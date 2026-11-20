import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkImpactDraft, impactPrompt, type ImpactChange } from '../src/steps/impact-draft.ts';

// K-001 4번 문장 ↔ F-001 → F-002 제12조제1항 (합성)
const before = '여신 금액이 5억원 이상이면 본부 여신심사위원회 안건으로 올린다 (제12조제1항).';
const ch: ImpactChange = { path: 'ARTICLE:12/PARAGRAPH:1', kind: 'MODIFIED', old_text: '여신 금액이 5억원 이상인 경우 본부 여신심사위원회의 승인을 받아야 한다.', new_text: '여신 금액이 3억원 이상인 경우 본부 여신심사위원회의 승인을 받아야 한다.' };

test('개정 수치대로 고친 초안은 통과', () => {
  const r = checkImpactDraft(before, { verdict: 'APPROPRIATE', after: before.replace('5억원', '3억원'), reason: '기준 금액 5억원 → 3억원' }, ch);
  assert.equal(r.verdict, 'APPROPRIATE');
  assert.match(r.after!, /3억원/);
});

test('개정 조문에 없는 숫자를 지어내면 버리고 UNKNOWN', () => {
  const r = checkImpactDraft(before, { verdict: 'APPROPRIATE', after: before.replace('5억원', '4억원'), reason: 'x' }, ch);
  assert.equal(r.verdict, 'UNKNOWN');
  assert.equal(r.after, undefined);
});

test('조문 삭제면 모델 출력과 관계없이 사람 판단', () => {
  const r = checkImpactDraft(before, { verdict: 'APPROPRIATE', after: '아무 문장', reason: 'x' }, { ...ch, kind: 'DELETED', new_text: '' });
  assert.equal(r.verdict, 'UNKNOWN');
  assert.equal(r.after, undefined);
});

test('빈 after·같은 문장·PII·무응답은 UNKNOWN, INAPPROPRIATE는 after 없이 통과', () => {
  assert.equal(checkImpactDraft(before, { verdict: 'APPROPRIATE', after: before, reason: 'x' }, ch).verdict, 'UNKNOWN');
  assert.equal(checkImpactDraft(before, { verdict: 'APPROPRIATE', after: '', reason: 'x' }, ch).verdict, 'UNKNOWN');
  assert.equal(checkImpactDraft(before, { verdict: 'APPROPRIATE', after: '고객 900101-1234568 은 3억원 이상이면 본부 승인', reason: 'x' }, ch).verdict, 'UNKNOWN');
  assert.equal(checkImpactDraft(before, undefined, ch).verdict, 'UNKNOWN');
  const na = checkImpactDraft(before, { verdict: 'INAPPROPRIATE', after: '무시', reason: '관계없음' }, ch);
  assert.deepEqual(na, { verdict: 'INAPPROPRIATE', reason: '관계없음' });
});

test('프롬프트에 개정 전후 조문과 문장이 들어간다', () => {
  const p = impactPrompt({ before, change: ch, context: '주변 글' });
  assert.ok(p.includes('<before>') && p.includes('3억원 이상인 경우') && p.includes('5억원 이상인 경우'));
});
