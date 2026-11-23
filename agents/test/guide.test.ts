import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLawNames, citableFrom, guide, unnamedLaws, MOCK_EVIDENCE, type Evidence, type GuideDraft } from '../src/guide.ts';

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
  assert.match(r.uncertainty, /관련 2건은 근거를 찾지 못해 뺐습니다/);
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
  const shot = { doc_id: 'doc_M', provision_id: 'doc_M#fig3', title: '과천 매뉴얼', snippet: '설치 창에서 [다음]을 누른다', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, quotable: true, evidence_kind: 'FIGURE' as const, document_type: 'MANUAL', page: 12 };
  const regFig = { doc_id: 'doc_R', provision_id: 'doc_R#fig1', title: '규정', snippet: '결재 흐름도', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, quotable: true, evidence_kind: 'FIGURE' as const, document_type: 'REGULATION' };
  const r = await guide('드라이버 설치', { model: 'm', search: async () => [shot, regFig],
    draft: async () => ({ steps: [{ text: '설치 창에서 [다음]을 누릅니다', sources: ['doc_M#fig3'] }, { text: '결재 흐름', sources: ['doc_R#fig1'] }], uncertainty: '' }) });
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0]!.text, '(그림 기준 · 12쪽) 설치 창에서 [다음]을 누릅니다');
  assert.equal(r.steps[0]!.sources[0]!.figure, true);
  assert.match(r.uncertainty, /그림 기준\(AI 정리\) 근거/);
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

test('섹션 형식: 종류×갈래 조합마다 2차 검색, 섹션 단계 출처 검증, 근거 없는 조합은 안내만 (11/18)', async () => {
  const { guide } = await import('../src/guide.ts');
  const E = (id: string, snippet: string) => ({ doc_id: 'doc_M', provision_id: id, title: '과천 매뉴얼', snippet, authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const });
  const calls: string[] = [];
  const r = await guide('4층 프린터 연결', { model: 'm',
    search: async (q, o) => { calls.push(q); if (q !== '4층 프린터 연결') assert.equal(o?.expand, 'section'); return q.startsWith('macOS 삼성') ? [E('doc_M#p20', '삼성 macOS 설치')] : q.startsWith('4층') ? [E('doc_M#p8', '4층 목록')] : []; },
    expand: async () => ({ items: ['삼성', '브라더'], variants: ['macOS', 'Windows'] }),
    draft: async () => ({ steps: [], uncertainty: '', sections: [
      { title: '4층 프린터 목록', note: '', fallback: '', steps: [{ text: '⑧ 삼성', sources: ['doc_M#p8'] }] },
      { title: 'macOS에서 삼성 프린터 연결', note: '', fallback: '안 될 때: 드라이버를 직접 선택', steps: [{ text: '설치 파일 실행', sources: ['doc_M#p20'] }, { text: '지어낸 단계', sources: ['none'] }] },
      { title: 'macOS에서 브라더 프린터 연결', note: '매뉴얼에 해당 절차 없음', fallback: '', steps: [] },
    ] }) });
  assert.deepEqual(calls.slice(1).map((c) => c.split(' ').slice(0, 2).join(' ')), ['macOS 삼성', 'Windows 삼성', 'macOS 브라더', 'Windows 브라더']);
  assert.equal(r.sections?.length, 3);
  assert.equal(r.sections![1]!.steps.length, 1);
  assert.equal(r.sections![2]!.note, '매뉴얼에 해당 절차 없음');
  assert.equal(r.sections![1]!.fallback, '안 될 때: 드라이버를 직접 선택');
  assert.equal(r.steps.length, 2);
  assert.equal(r.dropped_steps, 1);
});

test('불확실 안내의 근거 ID 는 문서 이름으로 바꾼다 (11/18 dev 시험)', async () => {
  const { guide } = await import('../src/guide.ts');
  const E = { doc_id: 'doc_K', provision_id: 'doc_K#s2', title: '서류 체크리스트', snippet: 's', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const };
  const r = await guide('q', { model: 'm', search: async () => [E], draft: async () => ({ steps: [{ text: 'a', sources: ['doc_K#s2'] }], uncertainty: '노하우(doc_K#s2) "…"는 규정과 상충 — 규정을 따름.' }) });
  assert.match(r.uncertainty, /^「서류 체크리스트」 "…"는 규정과 상충/);
  assert.doesNotMatch(r.uncertainty, /doc_K/);
});

test('불확실 안내에 내부 구간 표시(#s1)·상태 코드(freshness=…)가 남지 않는다 (11/18 prod 시험)', async () => {
  const { guide } = await import('../src/guide.ts');
  const E = { doc_id: 'doc_K', provision_id: 'doc_K#s2', title: '서류 체크리스트', snippet: 's', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const };
  const r = await guide('q', { model: 'm', search: async () => [E], draft: async () => ({ steps: [{ text: 'a', sources: ['doc_K#s2'] }], uncertainty: '체크리스트(doc_K#s1, #s2)는 freshness=REVIEW_REQUIRED(재검토 필요) 상태입니다.' }) });
  assert.doesNotMatch(r.uncertainty, /#s\d|freshness=|doc_K/);
  assert.match(r.uncertainty, /「서류 체크리스트」/);
});

test('Guardrails 출력 검사: 탐지 값은 가리고, 차단이면 답변을 버린다', async () => {
  const draft = { steps: [{ text: '비밀번호 hunter2 로 접속한다.', sources: ['doc_F001'] }], uncertainty: '' };
  const seen: string[] = [];
  const masked = await guide('접속 방법', { ...deps(draft), guard: async (t) => { seen.push(t); return { blocked: false, matches: ['hunter2'] }; } });
  assert.equal(masked.guard, 'MASKED');
  assert.equal(masked.steps[0]!.text, '비밀번호 [민감정보] 로 접속한다.');
  assert.ok(seen[0]!.includes('hunter2'), '검사 대상에 답변 문장이 들어가야 함');
  const blocked = await guide('접속 방법', { ...deps(draft), guard: async () => ({ blocked: true, matches: [] }) });
  assert.equal(blocked.guard, 'BLOCKED');
  assert.equal(blocked.status, 'NO_EVIDENCE');
  assert.equal(blocked.steps.length, 0);
  assert.ok(!JSON.stringify(blocked.steps).includes('hunter2'));
  await assert.rejects(guide('접속 방법', { ...deps(draft), guard: async () => { throw new Error('guardrail down'); } }));
});

test('withAsOf: 기준일을 받는 Tool에 as_of가 없을 때만 채운다', async () => {
  const { withAsOf } = await import('../src/guide.ts');
  assert.deepEqual(withAsOf('search___search_wiki', { query: 'q' }, '2026-12-15'), { query: 'q', as_of: '2026-12-15' });
  assert.deepEqual(withAsOf('regulation___get_clause', { law: 'l', as_of: '2025-01-01' }, '2026-12-15'), { law: 'l', as_of: '2025-01-01' }, '모델이 정한 기준일은 그대로');
  assert.deepEqual(withAsOf('regulation___resolve_reference', { provision_id: 'p' }, '2026-12-15'), { provision_id: 'p' }, 'as_of 없는 Tool은 그대로');
  assert.deepEqual(withAsOf('search___search_wiki', { query: 'q' }), { query: 'q' }, '기준일 미지정이면 그대로');
});

test('1차 검색 0건: Tool 검색 가능하면 Agent가 다시 찾고, 찾은 근거로만 답한다 (QA 데모 05)', async () => {
  const found = MOCK_EVIDENCE[0]!;
  let prompt = '';
  const draft = async (p: string) => { prompt = p; return { steps: [{ text: '본부 승인을 받는다', sources: [found.doc_id] }, { text: '근거 없는 단계', sources: ['nope'] }], uncertainty: '', evidence: [found], tool_calls: [] }; };
  const r = await guide('담보평가 시 확인 절차는?', { search: async () => [], draft, model: 'm', toolSearch: true });
  assert.match(prompt, /1차 검색 근거가 없다/);
  assert.equal(r.status, 'OK');
  assert.equal(r.steps.length, 1, '출처 없는 단계는 빠짐');
  const none = await guide('q', { search: async () => [], draft: async () => ({ steps: [{ text: 'x', sources: ['nope'] }], uncertainty: '', evidence: [], tool_calls: [] }), model: 'm', toolSearch: true });
  assert.equal(none.status, 'NO_EVIDENCE');
  assert.match(none.uncertainty!, /근거를 찾지 못/);
  let called = false;
  const off = await guide('q', { search: async () => [], draft: async () => { called = true; return { steps: [], uncertainty: '' }; }, model: 'm' });
  assert.equal(off.status, 'NO_EVIDENCE'); assert.equal(called, false, 'Tool 없으면 기존처럼 바로 끝');
});

test('불확실 안내의 내부 상태 용어는 사용자 문구로 (QA M05 nit)', async () => {
  const r = await guide('q', { search: async () => MOCK_EVIDENCE, draft: async () => ({ steps: [{ text: '본부 승인', sources: [MOCK_EVIDENCE[0]!.doc_id] }], uncertainty: '검색 결과가 UNVERIFIED 상태로, related 조문으로만 확인됨' }), model: 'm' });
  assert.ok(!/UNVERIFIED|related/.test(r.uncertainty!), r.uncertainty);
  assert.match(r.uncertainty!, /확인되지 않은 상태.*참고 조문/);
});

test('답변의 내부 ID·상태 코드는 사람이 읽는 표기로 + 시행 예정 개정 한 줄 (엔드유저 D05)', async () => {
  const { humanize, pathLabel } = await import('../src/guide.ts');
  assert.equal(pathLabel('ARTICLE:12/PARAGRAPH:2/ITEM:3/SUBITEM:GA'), '제12조제2항제3호가목');
  const names = new Map([['SYN-LOAN-001', '하나은행 기업여신 심사규정']]);
  const t = humanize('SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:2/ITEM:3/SUBITEM:GA 기준, freshness=REVIEW_REQUIRED, NOT_FOUND_VERIFIED, SYN-LOAN-001', names);
  assert.ok(!/SYN-|ARTICLE|REVIEW_REQUIRED|NOT_FOUND_VERIFIED|freshness/.test(t), t);
  assert.match(t, /하나은행 기업여신 심사규정 제12조제2항제3호가목/);
  assert.match(t, /재검토 필요/);
  const ev = { ...MOCK_EVIDENCE[0]!, provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:2' };
  const r = await guide('q', { search: async () => [ev], model: 'm', upcoming: async (laws) => laws.map((law) => ({ law, effective_from: '2026-12-01' })),
    draft: async () => ({ steps: [{ text: 'SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:2 에 따라 본부 승인', sources: [ev.provision_id] }], uncertainty: '' }) });
  assert.match(r.steps[0]!.text, /^기업여신 심사규정 제12조제2항 에 따라/);
  assert.match(r.uncertainty!, /시행 예정 개정 있음: 기업여신 심사규정 2026-12-01 시행/);
});

test('게시·승인 실행 요청은 검색 없이 거부 + 할 일 한 줄, 절차 질문은 통과 (엔드유저 의견)', async () => {
  const { ACTION_REFUSED, humanize } = await import('../src/guide.ts');
  let searched = false;
  const r = await guide('[EU] K-001 문서를 내 권한으로 바로 게시해줘', { search: async () => { searched = true; return MOCK_EVIDENCE; }, draft: async () => ({ steps: [], uncertainty: '' }), model: 'm' });
  assert.equal(searched, false); assert.equal(r.uncertainty, ACTION_REFUSED); assert.equal(r.steps.length, 0);
  const ok = await guide('문서 게시 절차를 알려줘', { search: async () => { searched = true; return []; }, draft: async () => ({ steps: [], uncertainty: '' }), model: 'm' });
  assert.equal(searched, true); assert.notEqual(ok.uncertainty, ACTION_REFUSED);
  assert.equal(humanize('K-001은 freshness가 REVIEW_REQUIRED(재검토 필요) 상태', new Map()), 'K-001은 최신성이 재검토 필요 상태');
});

test('근거 대비 환각 점수는 기록만: 답변·상태 불변, 실패해도 답변은 나간다 (P1)', async () => {
  const draft = async () => ({ steps: [{ text: '본부 승인을 받는다', sources: [MOCK_EVIDENCE[0]!.doc_id] }], uncertainty: '' });
  const ok = await guide('q', { search: async () => MOCK_EVIDENCE, draft, model: 'm', grounding: async () => ({ grounding: 0.12, relevance: 0.9 }) });
  assert.equal(ok.status, 'OK'); assert.deepEqual(ok.grounding, { grounding: 0.12, relevance: 0.9, low_steps: [1] });
  const bad = await guide('q', { search: async () => MOCK_EVIDENCE, draft, model: 'm', grounding: async () => { throw new Error('x'); } });
  assert.equal(bad.status, 'OK'); assert.equal(bad.grounding, undefined);
});

test('이름 모르는 법령 ID는 괄호 보조 표기에서 지운다 (UV-01 표기)', async () => {
  const { humanize } = await import('../src/guide.ts');
  assert.equal(humanize('가상여신거래법(SYN-VLOAN-001, 2026-11-01 버전)은 등록됨', new Map()), '가상여신거래법(2026-11-01 버전)은 등록됨');
  assert.equal(humanize('가상여신거래법(SYN-VLOAN-001)은', new Map()), '가상여신거래법은');
  assert.equal(humanize('SYN-LOAN-001 기준', new Map([['SYN-LOAN-001', '기업여신 심사규정']])), '기업여신 심사규정 기준');
});

test('뺀 단계는 본문 대신 주제 낱말 + 건수 (숫자·조건 노출 없음)', async () => {
  const { droppedNote } = await import('../src/guide.ts');
  const n = droppedNote(['감정평가서 발급일이 6개월을 초과하면 재발급을 요청한다.', '1억원 이하는 승인 없이 처리한다.']);
  assert.ok(!/억원|6개월|승인 없이|재발급을 요청/.test(n), n); // 건수(2건) 외 숫자·조건·본문 없음
  assert.match(n, /「감정평가서」/);
  assert.match(n, /2건은 근거를 찾지 못해 뺐습니다/);
});

test('조문 조회 근거(법령 ID)는 같은 개정본 규정 문서의 doc_id·제목·규정명으로 표기 (프론트 7차 11/23)', async () => {
  const doc = { doc_id: 'doc_REG1', provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:14/PARAGRAPH:1', title: '[SYNTHETIC] 기업여신 심사규정', snippet: '제14조 ① 현장 실사', provision: '기업여신 심사규정 제14조제1항', authority_status: 'VERIFIED', freshness: 'CURRENT', search_status: 'FOUND' } as Evidence;
  const clause = citableFrom({ search_status: 'FOUND', provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:10/PARAGRAPH:1', original_text: '심사역은 다음 각 호의 서류를 받아야 한다.', path_label: '제10조제1항', law_id: 'SYN-LOAN-001' })[0]!;
  const r = await guide('q', { search: async () => [doc], draft: async () => ({ steps: [{ text: '서류 세 가지를 받는다', sources: [clause.provision_id!] }], uncertainty: '', evidence: [clause] }), model: 'm' });
  const s = r.steps[0]!.sources[0]!;
  assert.equal(s.doc_id, 'doc_REG1'); assert.equal(s.title, '[SYNTHETIC] 기업여신 심사규정'); assert.equal(s.provision, '기업여신 심사규정 제10조제1항');
  assert.equal(s.provision_id, 'SYN-LOAN-001@2026-11-01/ARTICLE:10/PARAGRAPH:1');
});

test('조문 조회 근거 제목: 같은 응답에 규정 문서가 없으면 Tool 인자 규정 이름. 법령 ID 인자는 쓰지 않음', () => {
  const r = { search_status: 'FOUND', provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:10/PARAGRAPH:1', original_text: 'x', path_label: '제10조제1항', law_id: 'SYN-LOAN-001' };
  const a = citableFrom(r, '기업여신 심사규정')[0]!;
  assert.equal(a.title, '기업여신 심사규정'); assert.equal(a.provision, '기업여신 심사규정 제10조제1항');
  const b = citableFrom(r, 'SYN-LOAN-001')[0]!;
  assert.equal(b.title, 'SYN-LOAN-001'); assert.equal(b.provision, '제10조제1항');
});

test('법령 ID로만 표기된 조문 근거는 Registry 규정 이름으로 (8차)', () => {
  const e = citableFrom({ search_status: 'FOUND', provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:10/PARAGRAPH:1', original_text: 'x', path_label: '제10조제1항', law_id: 'SYN-LOAN-001' }, 'SYN-LOAN-001');
  assert.deepEqual(unnamedLaws(e), ['SYN-LOAN-001']);
  applyLawNames(e, new Map([['SYN-LOAN-001', '하나은행 기업여신 심사규정']]));
  assert.equal(e[0]!.title, '하나은행 기업여신 심사규정'); assert.equal(e[0]!.provision, '하나은행 기업여신 심사규정 제10조제1항');
  assert.equal(e[0]!.provision_id, 'SYN-LOAN-001@2026-11-01/ARTICLE:10/PARAGRAPH:1'); assert.deepEqual(unnamedLaws(e), []);
});

test('조 전체 조회 결과의 하위 항·호도 각자 provision_id 로 인용 근거 (Tool 상한 대비, 8차)', () => {
  const B = 'SYN-LOAN-001@2026-11-01/ARTICLE:10';
  const ev = citableFrom({ search_status: 'FOUND', provision_id: B, path_label: '제10조', law_id: 'SYN-LOAN-001', original_text: '(심사 서류)', children: [
    { provision_id: `${B}/PARAGRAPH:1`, path_label: '제10조제1항', status: 'ACTIVE', original_text: '심사역은 다음 각 호의 서류를 받아야 한다.' },
    { provision_id: `${B}/PARAGRAPH:1/ITEM:1`, path_label: '제10조제1항제1호', status: 'ACTIVE', original_text: '최근 3년간 재무제표' },
    { provision_id: `${B}/PARAGRAPH:2`, path_label: '제10조제2항', status: 'ACTIVE', original_text: '감정평가서는 6개월 이내의 것이어야 한다.' },
    { provision_id: `${B}/PARAGRAPH:3`, path_label: '제10조제3항', status: 'DELETED', original_text: '삭제' }] }, '기업여신 심사규정');
  assert.deepEqual(ev.map((e) => e.provision_id), [B, `${B}/PARAGRAPH:1`, `${B}/PARAGRAPH:1/ITEM:1`, `${B}/PARAGRAPH:2`]);
  assert.match(ev[1]!.snippet, /다음 각 호.*최근 3년간 재무제표/); assert.equal(ev[3]!.provision, '기업여신 심사규정 제10조제2항');
});

test('엔드유저 8차: 시스템 사정 문구 숨김·상위/하위 조문 중복 출처는 상위만', async () => {
  const { humanize, topSources } = await import('../src/guide.ts');
  const { hideSystem } = await import('../src/guide.ts');
  const t = hideSystem('제10조제2항은 도구 조회 한도 초과로 확인하지 못하였음 — 원문을 확인할 것. 대출 한도는 5억원이다.');
  assert.equal(humanize('신용정보 조회 한도는 1일 3회이다.', new Map()), '신용정보 조회 한도는 1일 3회이다.', '단계 본문의 정상 문장은 그대로');
  assert.match(hideSystem('제10조제2항 등 추가 항의 내용은 조회 한도 초과로 확인하지 못하였습니다.'), /^일부 조문은 직접 확인하지 못했습니다/);
  assert.equal(hideSystem('신용정보 조회 한도는 1일 3회이다.'), '신용정보 조회 한도는 1일 3회이다.', '도구 낱말 없으면 그대로');
  assert.equal(humanize('심사역은 담보물 감정평가서를 포함한 다음 서류를 징구한다: ① 재무제표', new Map()), '심사역은 다음 서류를 징구한다: ① 재무제표');
  assert.equal(humanize('심사역은 담보물감정평가서를 포함한 아래 서류를 받는다.', new Map()), '심사역은 아래 서류를 받는다.');
  assert.doesNotMatch(t, /한도 초과/); assert.match(t, /일부 조문은 직접 확인하지 못했습니다/); assert.match(t, /대출 한도는 5억원이다/);
  const e = (provision_id: string) => ({ doc_id: provision_id, provision_id, title: 't', snippet: 's' }) as Evidence;
  const B = 'SYN-LOAN-001@2026-11-01/ARTICLE:10/PARAGRAPH:1';
  assert.deepEqual(topSources([e(B), e(`${B}/ITEM:1`), e('SYN-LOAN-001@2026-11-01/ARTICLE:10/PARAGRAPH:2')]).map((x) => x.provision_id), [B, 'SYN-LOAN-001@2026-11-01/ARTICLE:10/PARAGRAPH:2']);
});
