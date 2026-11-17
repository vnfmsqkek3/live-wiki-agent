import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guide, MOCK_EVIDENCE, type GuideDraft } from '../src/guide.ts';

const deps = (draft: GuideDraft, seen: string[] = []) => ({
  model: 'test-model',
  search: async (q: string) => { seen.push(q); return MOCK_EVIDENCE; },
  draft: async (p: string) => { seen.push(p); return draft; },
});

test('질의 PII는 검색·모델에 보내기 전에 마스킹', async () => {
  const seen: string[] = [];
  const r = await guide('고객 900101-1234568 담보 승인 기준', deps({ steps: [], uncertainty: '' }, seen));
  assert.ok(r.query_masked);
  assert.ok(seen.every((s) => !s.includes('1234568')), '원문 주민등록번호가 Tool/모델로 전달됨');
});

test('출처가 근거에 없는 단계는 버리고 수를 알린다 (근거 인용 강제)', async () => {
  const r = await guide('담보 승인 기준', deps({
    steps: [
      { text: '담보가액 3억원 이상이면 본부 승인을 받는다.', sources: ['doc_F001'] },
      { text: '1억원 이하는 승인 없이 처리한다.', sources: ['doc_FAKE'] },
      { text: '근거 없는 문장', sources: [] },
    ],
    uncertainty: '',
  }));
  assert.equal(r.status, 'OK');
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0]!.sources[0]!.provision, '기업여신 심사규정 제12조제2항');
  assert.equal(r.dropped_steps, 2);
  assert.match(r.uncertainty, /2개 단계는 제외/);
});

test('근거가 없으면 모델을 부르지 않고 NO_EVIDENCE', async () => {
  let called = false;
  const r = await guide('없는 내용', { model: 'm', search: async () => [], draft: async () => { called = true; return { steps: [], uncertainty: '' }; } });
  assert.equal(r.status, 'NO_EVIDENCE');
  assert.equal(called, false);
});

test('반려·폐지 근거는 모델에 넘기지 않음, 답변의 PII는 마스킹 (이메일은 그대로, 사용자 결정 11/17 22시)', async () => {
  const seen: string[] = [];
  const r = await guide('q', {
    model: 'm',
    search: async () => [{ ...MOCK_EVIDENCE[0]!, doc_id: 'doc_R', authority_status: 'REJECTED' }, MOCK_EVIDENCE[1]!],
    draft: async (p) => { seen.push(p); return { steps: [{ text: '담당자 hong@hanbit.example, 주민 900101-1234568 확인', sources: ['doc_K001'] }], uncertainty: '' }; },
  });
  assert.ok(!seen[0]!.includes('doc_R'));
  assert.equal(r.steps[0]!.text, '담당자 hong@hanbit.example, 주민 [주민등록번호] 확인');
});

test('삭제 조항은 근거에서 제외, 과거 조문은 불확실로 표시', async () => {
  const seen: string[] = [];
  const r = await guide('q', {
    model: 'm',
    search: async () => [{ ...MOCK_EVIDENCE[0]!, doc_id: 'doc_DEL', search_status: 'DELETED' }, { ...MOCK_EVIDENCE[1]!, search_status: 'HISTORICAL' }],
    draft: async (p) => { seen.push(p); return { steps: [{ text: 't', sources: ['doc_K001', 'doc_DEL'] }], uncertainty: '' }; },
  });
  assert.ok(!seen[0]!.includes('doc_DEL'));
  assert.deepEqual(r.steps[0]!.sources.map((e) => e.doc_id), ['doc_K001']);
  assert.match(r.uncertainty, /과거 조문 1건/);
});

test('스트리밍 진행 문구: 개인정보 확인 → 검색 → 작성 → 출처 확인 순서, 질문 원문 미포함', async () => {
  const said: string[] = [];
  await guide('900101-1234568 고객 담보 승인은?', { ...deps({ steps: [{ text: '본부 승인', sources: ['doc_F001'] }], uncertainty: '' }), progress: (t) => said.push(t) });
  assert.deepEqual(said.map((s) => s.slice(0, 6)), ['질문에 개인', '관련 규정·', '근거 문서 ', '단계마다 출']);
  assert.ok(said.every((s) => !s.includes('1234')));
});

test('Tool 상한: 허용 목록 밖 거부, 6회·같은 인자 반복 금지, 시간 초과', async () => {
  const { toolBudget } = await import('../src/guide.ts');
  const b = toolBudget(2, 1000, () => 0);
  assert.match(b.check('approval___create_review_request', {})!, /쓸 수 없는/);
  assert.equal(b.check('regulation___get_clause', { a: 1 }), undefined);
  assert.match(b.check('regulation___get_clause', { a: 1 })!, /다시 부르지/);
  assert.equal(b.check('graph___trace_impact', {}), undefined);
  assert.match(b.check('search___search_wiki', {})!, /상한 2회/);
  let t = 0; const late = toolBudget(6, 1000, () => t); t = 2000;
  assert.match(late.check('search___search_wiki', {})!, /시간 상한/);
});

test('Tool로 더 찾은 근거도 출처로 인정(그림 설명·과거 조문 제외), tool_calls 전달', async () => {
  const { guide, citableFrom } = await import('../src/guide.ts');
  const extra = citableFrom({ items: [
    { doc_id: 'doc_X', title: '외국환 규정', snippet: 's', authority_status: 'VERIFIED', freshness: 'CURRENT', search_status: 'FOUND' },
    { doc_id: 'doc_FIG', title: '그림', snippet: 's', authority_status: 'VERIFIED', freshness: 'CURRENT', quotable: false },
    { doc_id: 'doc_OLD', title: '옛 조문', snippet: 's', authority_status: 'VERIFIED', freshness: 'CURRENT', search_status: 'HISTORICAL' },
  ] });
  assert.deepEqual(extra.map((e) => e.doc_id), ['doc_X']);
  const r = await guide('외국환 송금 확인', { model: 'm', search: async () => MOCK_EVIDENCE,
    draft: async () => ({ steps: [{ text: '제재 대상 확인', sources: ['doc_X'] }, { text: '그림 근거', sources: ['doc_FIG'] }], uncertainty: '', evidence: extra, tool_calls: [{ name: 'search___search_legal_clause', ok: true, ms: 900 }] }) });
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0]!.sources[0]!.doc_id, 'doc_X');
  assert.equal(r.dropped_steps, 1);
  assert.equal(r.tool_calls?.[0]?.name, 'search___search_legal_clause');
});

test('SDK 내부 Tool은 상한 대상 아님, 현행 조문 조회 결과는 조문 ID로 인용 가능·개정 전 조문은 제외', async () => {
  const { toolBudget, citableFrom } = await import('../src/guide.ts');
  assert.equal(toolBudget(1).check('strands_structured_output', {}), undefined);
  const cur = citableFrom({ search_status: 'FOUND', provision_id: 'SYN-LOAN-001@2026-12-01/ARTICLE:12', path_label: '제12조', title: '기업여신 심사규정', original_text: '본부 승인', effective_from: 20261201, children: [{ original_text: '① 5억원 이상' }] });
  assert.deepEqual([cur[0]!.doc_id, cur[0]!.effective_from, cur[0]!.snippet], ['SYN-LOAN-001@2026-12-01/ARTICLE:12', '2026-12-01', '본부 승인 ① 5억원 이상']);
  assert.equal(citableFrom({ search_status: 'FOUND', provision_id: 'SYN-LOAN-001@2025-01-01/ARTICLE:12', original_text: '7억원', current: { revision_id: '2026-12-01' } }).length, 0);
});

test('같은 규정의 여러 조문: 출처는 조문 ID로 정확히 대조, 조문이 여럿인 doc_id만 쓴 출처는 버림', async () => {
  const { guide } = await import('../src/guide.ts');
  const reg = (p: string, label: string) => ({ doc_id: 'doc_R', provision_id: `SYN-LOAN-001@2026-11-01/${p}`, title: '기업여신 심사규정', snippet: label, provision: `기업여신 심사규정 ${label}`, authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, search_status: 'FOUND' });
  const r = await guide('제12조 승인 기준', { model: 'm', search: async () => [reg('ARTICLE:12', '제12조'), reg('ARTICLE:2', '제2조')],
    draft: async () => ({ steps: [{ text: '본부 승인 기준', sources: ['SYN-LOAN-001@2026-11-01/ARTICLE:12'] }, { text: '모호', sources: ['doc_R'] }], uncertainty: '' }) });
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0]!.sources[0]!.provision, '기업여신 심사규정 제12조');
  assert.equal(r.dropped_steps, 1);
});

test('그림·쪽 맥락(quotable=false)은 <context>로만 전달하고 출처로는 못 씀 (11/18)', async () => {
  const { guide } = await import('../src/guide.ts');
  let prompt = '';
  const fig = { doc_id: 'doc_M', title: '과천 매뉴얼', snippet: '[그림] 4층 배치도: ⑤ 브라더', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, quotable: false };
  const body = { doc_id: 'doc_M', provision_id: 'doc_M#p8', title: '과천 매뉴얼', snippet: '⑤ 브라더 HL-L6400 IP 10.0.4.15', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const };
  const r = await guide('4층 프린터 연결', { model: 'm', search: async () => [fig, body],
    draft: async (p) => { prompt = p; return { steps: [{ text: '(그림 기준) 4층 ⑤ 브라더 IP 확인', sources: ['doc_M#p8'] }, { text: '그림만 근거', sources: ['doc_M#fig1'] }], uncertainty: '' }; } });
  assert.match(prompt, /<context [^>]*>[\s\S]*4층 배치도[\s\S]*<\/context>/);
  assert.doesNotMatch(prompt.split('<context')[0]!, /4층 배치도/);
  assert.equal(r.steps.length, 1);
  assert.equal(r.evidence.length, 1);
});

test('매뉴얼 그림·화면 정리본은 그림 기준 근거로 인용(표시 자동), 규정 그림은 인용 불가 (11/18)', async () => {
  const { guide } = await import('../src/guide.ts');
  const shot = { doc_id: 'doc_M', provision_id: 'doc_M#fig3', title: '과천 매뉴얼', snippet: '[그림 설명 · 원문 아님] 설치 창에서 [다음]을 누른다', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, quotable: false, document_type: 'MANUAL', page: 12 };
  const regFig = { doc_id: 'doc_R', provision_id: 'doc_R#fig1', title: '규정', snippet: '[그림 설명 · 원문 아님] 결재 흐름도', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, quotable: false, document_type: 'REGULATION' };
  const r = await guide('드라이버 설치', { model: 'm', search: async () => [shot, regFig],
    draft: async () => ({ steps: [{ text: '설치 창에서 [다음]을 누릅니다', sources: ['doc_M#fig3'] }, { text: '결재 흐름', sources: ['doc_R#fig1'] }], uncertainty: '' }) });
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0]!.text, '(그림 기준 · 12쪽) 설치 창에서 [다음]을 누릅니다');
  assert.equal(r.steps[0]!.sources[0]!.figure, true);
  assert.equal(r.dropped_steps, 1);
});

test('여러 번 찾기: 1차 근거의 항목마다 2차 검색(같은 문서 우선), 못 찾은 항목은 불확실 (11/18)', async () => {
  const { guide } = await import('../src/guide.ts');
  const E = (doc: string, id: string, snippet: string) => ({ doc_id: doc, provision_id: id, title: '과천 매뉴얼', snippet, authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const });
  const calls: string[] = [];
  let prompt = '';
  const r = await guide('4층 프린터 연결', { model: 'm',
    search: async (q) => { calls.push(q); return q.startsWith('브라더') ? [E('doc_X', 'doc_X#1', '다른 문서'), E('doc_M', 'doc_M#p14', '브라더 드라이버 설치: setup.exe 실행')] : q.startsWith('삼성') ? [] : [E('doc_M', 'doc_M#p8', '4층: ⑤ 브라더, ⑧ 삼성')]; },
    expand: async () => ['브라더', '삼성'],
    draft: async (p) => { prompt = p; return { steps: [{ text: '[브라더] setup.exe 실행', sources: ['doc_M#p14'] }], uncertainty: '' }; } });
  assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['4층', '브라더', '삼성']);
  assert.ok(prompt.indexOf('doc_M#p14') < prompt.indexOf('doc_X#1'), '같은 문서 조각 우선');
  assert.match(prompt, /<items[^>]*>\["브라더","삼성"\]<\/items>/);
  assert.equal(r.steps.length, 1);
  assert.match(r.uncertainty, /삼성 절차는 근거에서 더 찾지 못했습니다/);
});
