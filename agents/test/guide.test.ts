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
  const r = await guide('고객 010-1234-5678 담보 승인 기준', deps({ steps: [], uncertainty: '' }, seen));
  assert.ok(r.query_masked);
  assert.ok(seen.every((s) => !s.includes('1234-5678')), '원문 전화번호가 Tool/모델로 전달됨');
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

test('반려·폐지 근거는 모델에 넘기지 않음, 답변의 PII는 마스킹', async () => {
  const seen: string[] = [];
  const r = await guide('q', {
    model: 'm',
    search: async () => [{ ...MOCK_EVIDENCE[0]!, doc_id: 'doc_R', authority_status: 'REJECTED' }, MOCK_EVIDENCE[1]!],
    draft: async (p) => { seen.push(p); return { steps: [{ text: '담당자 hong@hanbit.example 에게 등록', sources: ['doc_K001'] }], uncertainty: '' }; },
  });
  assert.ok(!seen[0]!.includes('doc_R'));
  assert.equal(r.steps[0]!.text, '담당자 [이메일] 에게 등록');
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

// ---- AgentCore Memory ----
import type { ConversationMemory, Turn } from '../src/memory.ts';

function fakeMemory(initial: Turn[] = []) {
  const saved: Turn[][] = [];
  const m: ConversationMemory = {
    history: async () => initial,
    summaries: async () => ['이전에 담보 승인 기준을 물어봄'],
    save: async (_a, _s, t) => { saved.push(t); },
    deleteActor: async () => 0,
  };
  return { m, saved };
}

test('Memory: 후속 질문은 직전 질문과 합쳐 검색, 기록은 맥락으로만 모델에 전달, 문답 저장', async () => {
  const seen: string[] = [];
  const { m, saved } = fakeMemory([{ role: 'USER', text: '담보 승인 기준은?' }, { role: 'ASSISTANT', text: '3억원 이상 본부 승인' }]);
  const r = await guide('그럼 2항은?', {
    model: 'm', memory: m,
    search: async (q) => { seen.push(q); return MOCK_EVIDENCE; },
    draft: async (p) => { seen.push(p); return { steps: [{ text: '예금담보는 영업점장 승인', sources: ['doc_F001'] }], uncertainty: '' }; },
  }, { actorId: 'sub-1', sessionId: 'conv-1' });
  assert.equal(seen[0], '담보 승인 기준은? 그럼 2항은?');
  assert.match(seen[1]!, /<history>[\s\S]*3억원 이상 본부 승인[\s\S]*<\/history>/);
  assert.equal(r.memory_used, true);
  assert.deepEqual(saved[0], [{ role: 'USER', text: '그럼 2항은?' }, { role: 'ASSISTANT', text: '예금담보는 영업점장 승인' }]);
});

test('Memory: 기억 속 문서를 출처로 내도 이번 검색 결과에 없으면 인용 불가 (재검증 강제), 저장은 마스킹본', async () => {
  const { m, saved } = fakeMemory([{ role: 'ASSISTANT', text: '근거 doc_OLD (폐지 조문)' }]);
  const r = await guide('연락처 010-3333-4444 담보 기준', {
    model: 'm', memory: m,
    search: async () => [MOCK_EVIDENCE[1]!],
    draft: async () => ({ steps: [{ text: '폐지 조문 근거', sources: ['doc_OLD'] }, { text: '3영업일 안에 등록', sources: ['doc_K001'] }], uncertainty: '' }),
  }, { actorId: 'sub-1', sessionId: 'conv-1' });
  assert.deepEqual(r.steps.map((s) => s.sources[0]!.doc_id), ['doc_K001']);
  assert.ok(!JSON.stringify(saved).includes('3333-4444'), '원문 PII가 Memory에 저장됨');
});

test('Memory 없거나 컨텍스트 없으면 기존 동작', async () => {
  const { m, saved } = fakeMemory();
  const r = await guide('q', { model: 'm', memory: m, search: async () => [], draft: async () => ({ steps: [], uncertainty: '' }) });
  assert.equal(r.memory_used, false);
  assert.equal(saved.length, 0);
});
