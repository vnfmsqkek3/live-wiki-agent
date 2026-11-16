import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateKnowhow, type Clause, type Judgement, type KnowhowDeps } from '../src/steps/knowhow.ts';

// F-001(현행 2026-11-01) / F-000(2025-01-01) 일부 (합성)
const C = (id: string, label: string, text: string, extra: Partial<Clause> = {}): Clause =>
  ({ provision_id: id, label, text, status: 'ACTIVE', effective_from: '2026-11-01', ...extra });
const A14 = C('SYN-LOAN-001@2026-11-01/ARTICLE:14/PARAGRAPH:1', '기업여신 심사규정 제14조제1항', '담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다.');
const A12 = C('SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:1', '기업여신 심사규정 제12조제1항', '여신 금액이 5억원 이상인 경우 본부 여신심사위원회의 승인을 받아야 한다.');
const A12_OLD = C('SYN-LOAN-001@2025-01-01/ARTICLE:12/PARAGRAPH:1', '기업여신 심사규정(2025) 제12조제1항', '여신 금액이 7억원 이상인 경우 본부 여신심사위원회의 승인을 받아야 한다.', { status: 'HISTORICAL', effective_from: '2025-01-01', current: A12 });

function deps(o: { cites?: string[]; search?: Clause[]; items: Judgement[] }): KnowhowDeps & { judged: Clause[][] } {
  const all = new Map([A14, A12, A12_OLD].map((c) => [c.provision_id, c]));
  const judged: Clause[][] = [];
  return {
    judged,
    extractCitations: async () => (o.cites ?? []).map((provision_id) => ({ provision_id, evidence_span: '', confidence: 0.9 })),
    getClause: async (id) => all.get(id),
    searchClauses: async () => o.search ?? [],
    judge: async (_t, clauses) => { judged.push(clauses); return { items: o.items, model: 'test' }; },
  };
}

test('K-002: 조문 번호 없이 실사 생략 → 의미 검색으로 찾은 제14조와 충돌, 게시 보류 + HIGH Finding', async () => {
  const d = deps({ search: [A14], items: [{ statement: '1억원 이하는 현장 실사 생략', provision_id: A14.provision_id, relation: 'CONFLICTS', reason: '부동산 담보는 실사 필수', quote: '현장 실사를 반드시 실시하여야 한다' }] });
  const r = await validateKnowhow('1억원 이하 부동산 담보대출은 현장 실사를 생략', d);
  assert.equal(r.validation.verdict, 'CONFLICT');
  assert.equal(r.gate, 'REVIEW_REQUIRED');
  assert.equal(r.findings[0]!.code, 'KNOWHOW_CONFLICT');
  assert.equal(r.findings[0]!.severity, 'HIGH');
  assert.match(r.findings[0]!.message, /제14조제1항/);
});

test('K-001: 근거 부합이면 PASS', async () => {
  const d = deps({ cites: [A12.provision_id], items: [{ statement: '5억원 이상 본부 승인', provision_id: A12.provision_id, relation: 'SUPPORTS', reason: '일치', quote: '여신 금액이 5억원 이상인 경우 본부 여신심사위원회의 승인을 받아야 한다.' }] });
  const r = await validateKnowhow('5억원 이상이면 본부 여신심사위원회 (제12조제1항)', d);
  assert.deepEqual([r.validation.verdict, r.gate, r.findings.length], ['SUPPORTED', 'PASS', 0]);
});

test('K-003: 개정 전 조문 인용 → 현행 조문도 함께 비교, OUTDATED + freshness REVIEW_REQUIRED', async () => {
  const d = deps({ cites: [A12_OLD.provision_id], items: [{ statement: '7억원 이상만 본부 승인', provision_id: A12.provision_id, relation: 'SUPPORTS', reason: '과거 기준과 일치', quote: '7억원' }] });
  const r = await validateKnowhow('7억원 이상일 때만 본부 승인 (2025. 1. 1. 시행본 제12조제1항)', d);
  assert.ok(d.judged[0]!.some((c) => c.provision_id === A12.provision_id), '현행 조문이 비교 대상에 포함');
  assert.equal(r.validation.verdict, 'OUTDATED');
  assert.equal(r.freshness, 'REVIEW_REQUIRED');
  assert.equal(r.validation.outdated[0]!.current, A12.provision_id);
});

test('K-004: 근거 조문 없음 → 모델 호출 없이 INSUFFICIENT(조건부, 사람 검토)', async () => {
  const d = deps({ items: [] });
  const r = await validateKnowhow('매출채권 회전일이 업종 평균보다 30일 이상 길면 추가 자료', d);
  assert.equal(r.validation.verdict, 'INSUFFICIENT');
  assert.equal(d.judged.length, 0);
  assert.equal(r.findings[0]!.code, 'KNOWHOW_NO_BASIS');
});

test('환각 차단: 조문 원문에 없는 인용으로 낸 충돌·부합 판정은 INSUFFICIENT로 강등', async () => {
  const d = deps({ search: [A14], items: [{ statement: 's', provision_id: A14.provision_id, relation: 'CONFLICTS', reason: 'r', quote: '현장 실사는 2억원 이상만 실시한다' }] });
  const r = await validateKnowhow('t', d);
  assert.equal(r.validation.items[0]!.relation, 'INSUFFICIENT');
  assert.equal(r.validation.items[0]!.verified_quote, false);
  assert.equal(r.validation.verdict, 'INSUFFICIENT');
});

test('개정 전 인용 + 현행과 충돌: 판정은 OUTDATED, 충돌 Finding은 유지', async () => {
  const d = deps({ cites: [A12_OLD.provision_id], items: [{ statement: '7억원 이상만 본부 승인', provision_id: A12.provision_id, relation: 'CONFLICTS', reason: '현행 5억원', quote: '여신 금액이 5억원 이상인 경우' }] });
  const r = await validateKnowhow('7억원 이상일 때만 (2025. 1. 1. 시행본 제12조제1항)', d);
  assert.equal(r.validation.verdict, 'OUTDATED');
  assert.deepEqual(r.findings.map((f) => f.code).sort(), ['KNOWHOW_CONFLICT', 'KNOWHOW_OUTDATED_CITATION']);
});

test('실무 보완(SUPPLEMENTS): 근거 있음으로 보고 게시 보류 사유가 아님 (사용자 지적 11/17)', async () => {
  const { validateKnowhow } = await import('../src/steps/knowhow.ts');
  const clause = { provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:14/PARAGRAPH:2', label: '기업여신 심사규정 제14조제2항', text: '현장 실사 결과는 실사 보고서로 작성하여 보관한다.', status: 'ACTIVE' as const, effective_from: '2026-11-01' };
  const r = await validateKnowhow('실사 사진은 실사 보고서에 첨부한다', {
    extractCitations: async () => [{ provision_id: clause.provision_id, evidence_span: '제14조제2항', confidence: 0.95 }],
    getClause: async () => clause, searchClauses: async () => [],
    judge: async () => ({ model: 'm', items: [{ statement: '실사 사진은 실사 보고서에 첨부한다', provision_id: clause.provision_id, relation: 'SUPPLEMENTS', reason: '제14조제2항은 보고서 작성만 정합니다. 사진 첨부는 실무 보완입니다.', quote: '현장 실사 결과는 실사 보고서로 작성하여 보관한다.' }] }),
  });
  assert.equal(r.validation.verdict, 'SUPPORTED');
  assert.equal(r.gate, 'PASS');
  assert.equal(r.findings.length, 0);
});
