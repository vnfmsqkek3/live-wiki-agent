import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateKnowhow, type Clause, type Judgement, type KnowhowDeps } from '../src/steps/knowhow.ts';

// 사용자 보고 11/23 (G-KREV-02): 시행 예정 개정판 기준 영향 초안대로 5천→3천달러로 고치면 새 버전 검사가 현행(5천) 기준 충돌로 '되돌리라'고 함
const NEW = 'SYN-FX-001@2026-12-01/ARTICLE:5/PARAGRAPH:1';
const CUR: Clause = { provision_id: 'SYN-FX-001@2026-11-01/ARTICLE:5/PARAGRAPH:1', label: '외국환 업무규정 제5조제1항', text: '건당 5천달러 초과 송금은 증빙을 받는다.', status: 'ACTIVE', effective_from: '2026-11-01',
  newer: { provision_id: NEW, text: '건당 3천달러 초과 송금은 증빙을 받는다.', deleted: false } };
const S = '건당 3천달러 초과 송금은 증빙을 받는다.';
const conflict: Judgement = { statement: S, provision_id: CUR.provision_id, relation: 'CONFLICTS', reason: '현행은 5천달러', quote: '건당 5천달러 초과 송금은 증빙을 받는다.' };
const deps = (second: Judgement[] | Error): KnowhowDeps => {
  let n = 0;
  return { extractCitations: async () => [], getClause: async () => undefined, searchClauses: async () => [CUR],
    judge: async () => { if (n++ === 0) return { items: [conflict], model: 't' }; if (second instanceof Error) throw second; return { items: second, model: 't' }; } };
};

test('현행과 충돌해도 시행 예정 개정판과 일치하면 충돌 아님: LOW KNOWHOW_UPCOMING_MATCH, 주장은 개정판 조문에', async () => {
  const r = await validateKnowhow(`메모\n${S}`, deps([{ statement: S, provision_id: NEW, relation: 'SUPPORTS', reason: '같음', quote: S }]));
  assert.deepEqual(r.findings.map((f) => [f.code, f.severity]), [['KNOWHOW_UPCOMING_MATCH', 'LOW']]);
  assert.match(r.findings[0]!.user_message!, /2026-12-01 시행/);
  assert.equal(r.validation.verdict, 'SUPPORTED'); assert.equal(r.gate, 'PASS');
  assert.equal(r.validation.items[0]!.provision_id, NEW); assert.equal(r.validation.items[0]!.relation, 'SUPPORTS');
});

test('개정판과도 다르거나 재판정 실패·인용 미확인이면 충돌 그대로', async () => {
  for (const second of [[{ statement: S, provision_id: NEW, relation: 'CONFLICTS', reason: 'x', quote: '건당 3천달러 초과 송금은 증빙을 받는다.' }] as Judgement[],
    [{ statement: S, provision_id: NEW, relation: 'SUPPORTS', reason: 'x', quote: '원문에 없는 인용' }] as Judgement[], new Error('model')]) {
    const r = await validateKnowhow(`메모\n${S}`, deps(second));
    assert.ok(r.findings.some((f) => f.code === 'KNOWHOW_CONFLICT')); assert.equal(r.validation.verdict, 'CONFLICT');
  }
});
