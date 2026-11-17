import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/index.ts';

const ctx = (t: string) => ({ clientContext: { custom: { bedrockAgentCoreToolName: `privacy___${t}` } } });
const author = { sub: 'u', groups: ['AUTHOR'] };
// 전화번호·이메일은 가리지 않음(사용자 결정 11/17 22시) → 표본은 주민등록번호(체크섬 통과)
const text = '담당 900101-1234568, 참조 123-45-678901';

test('detect: 원문 없이 유형·위치·개수만', async () => {
  const r = (await handler({ text, __actor: author }, ctx('detect_sensitive_data'))) as Record<string, unknown>;
  assert.equal(r.total, 2);
  assert.equal(r.uncertain, 1);
  assert.ok(!JSON.stringify(r).includes('1234568'));
});

test('masking_preview: 가린 텍스트, 불확실이면 needs_review', async () => {
  const r = (await handler({ text, __actor: author }, ctx('masking_preview'))) as Record<string, unknown>;
  assert.equal(r.masked_text, '담당 [주민등록번호], 참조 [계좌번호]');
  assert.equal(r.needs_review, true);
});

test('권한: 일반 사용자·신원 없음 거부, 길이 제한', async () => {
  for (const a of [{ sub: 'u', groups: ['USER'] }, undefined])
    assert.equal(((await handler({ text, __actor: a }, ctx('masking_preview'))) as { error: { code: string } }).error.code, 'FORBIDDEN');
  assert.equal(((await handler({ text: 'x'.repeat(20_001), __actor: author }, ctx('masking_preview'))) as { error: { code: string } }).error.code, 'VALIDATION');
});
