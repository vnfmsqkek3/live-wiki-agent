import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASIS_MISMATCH_HINT, citedIn, validateKnowhow, type Clause, type Judgement, type KnowhowDeps } from '../src/steps/knowhow.ts';

// 사용자 피드백 11/20 (prod G-KN-01 2번 문장): 근거와 무관한 조문이 '근거'로 붙고 '판단 못함'으로 보임
const A72: Clause = { provision_id: 'SYN-DEP-001@2026-11-01/ARTICLE:7-2', label: '수신업무 처리규정 제7조의2', text: '비대면 계좌 개설은 2가지 이상 인증 수단을 사용한다.', status: 'ACTIVE', effective_from: '2026-11-01' };
const GKN01 = '## 절차\n1. 수신업무 처리규정 제7조의2에 따라 비대면 계좌 개설은 2가지 이상 인증 수단을 사용한다.\n2. 처리 결과를 고객에게 안내한다.';
const deps = (items: Judgement[]): KnowhowDeps => ({
  extractCitations: async () => [], getClause: async () => undefined, searchClauses: async () => [A72],
  judge: async () => ({ items, model: 't' }),
});
const ok: Judgement = { statement: '비대면 계좌 개설은 2가지 이상 인증 수단을 사용한다.', provision_id: A72.provision_id, relation: 'SUPPORTS', reason: '같음', quote: '비대면 계좌 개설은 2가지 이상 인증 수단을 사용한다.' };
const off = (statement: string, relation: Judgement['relation'] = 'INSUFFICIENT'): Judgement => ({ statement, provision_id: A72.provision_id, relation, reason: '제7조의2는 인증 수단만 정함', quote: '비대면 계좌 개설은 2가지 이상 인증 수단을 사용한다.' });

test('재현: 문서가 근거로 들지 않은 문장에 붙은 조문은 NONE(근거로 안 보임), 판정·게시 판단·Finding 불변', async () => {
  const r = await validateKnowhow(GKN01, deps([ok, off('처리 결과를 고객에게 안내한다.')]));
  assert.equal(r.validation.items[1]!.basis, 'NONE');
  assert.equal(r.validation.items[0]!.basis, undefined, '일치 판정에는 표시 없음');
  assert.equal(r.validation.verdict, 'SUPPORTED');
  assert.equal(r.gate, 'PASS');
  assert.deepEqual(r.findings, [], '정상 노하우 원본에 새 경고 없음(오탐 0)');
});

test('문서가 그 문장에서 든 조문과 내용이 다르면 CITED + MEDIUM KNOWHOW_BASIS_MISMATCH(잠금 아님), 안내 문구', async () => {
  const text = `${GKN01}\n3. 수신업무 처리규정 제7조의2에 따라 처리 결과를 고객에게 문자로 안내한다.`;
  for (const rel of ['INSUFFICIENT', 'UNRELATED'] as const) {
    const r = await validateKnowhow(text, deps([ok, off('처리 결과를 고객에게 문자로 안내한다.', rel)]));
    assert.equal(r.validation.items[1]!.basis, 'CITED');
    const f = r.findings.find((x) => x.code === 'KNOWHOW_BASIS_MISMATCH')!;
    assert.equal(f.severity, 'MEDIUM');
    assert.equal(f.fix_hint, BASIS_MISMATCH_HINT);
    assert.equal(r.validation.verdict, 'SUPPORTED');
    assert.equal(r.gate, 'PASS');
  }
});

test('인용 미확인으로 낮춘 충돌(모델은 CONFLICTS)은 basis 표시·새 경고 없음', async () => {
  const r = await validateKnowhow(`${GKN01}\n3. 제7조의2에 따라 1가지 인증으로 개설한다.`, deps([{ ...off('1가지 인증으로 개설한다.', 'CONFLICTS'), quote: '원문에 없는 문장' }]));
  assert.equal(r.validation.items[0]!.relation, 'INSUFFICIENT');
  assert.equal(r.validation.items[0]!.basis, undefined);
  assert.ok(!r.findings.some((x) => x.code === 'KNOWHOW_BASIS_MISMATCH'));
});

test('citedIn: 조 번호 공백·항 표기 차이', () => {
  assert.ok(citedIn('제 14 조 제1항에 따라 실사한다', '실사한다', '기업여신 심사규정 제14조제1항'));
  assert.ok(!citedIn('제14조에 따라 실사한다\n결과를 안내한다', '결과를 안내한다', '기업여신 심사규정 제14조제1항'));
  assert.ok(!citedIn('제7조의2에 따라 결과를 고객에게 안내한다', '결과를 고객에게 안내한다', '수신업무 처리규정 제7조'), '제7조의2 ≠ 제7조');
  assert.ok(citedIn('제7조의2에 따라 결과를 고객에게 안내한다', '결과를 고객에게 안내한다', '수신업무 처리규정 제7조의2'));
});
