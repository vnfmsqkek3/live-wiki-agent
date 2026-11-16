import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from '../src/index.ts';
import { memoryStore } from '../../../apps/api/src/store.ts';
import { newId, type DocumentRecord } from '../../../apps/api/src/contracts.ts';

const ctx = (t: string) => ({ clientContext: { custom: { bedrockAgentCoreToolName: `approval___${t}` } } });
const author = { sub: 'u-author', groups: ['AUTHOR'] };
type R = { error?: { code: string; message: string } } & Record<string, unknown>;

async function setup(lifecycle: DocumentRecord['lifecycle'] = 'IN_REVIEW') {
  const store = memoryStore();
  const d: DocumentRecord = {
    doc_id: newId.doc(), version: 1, owner: 'u-author', title: '[SYNTHETIC] t', dept: 'loan', acl_groups: ['ALL'], ext: 'pdf', lifecycle,
    authority_status: 'UNVERIFIED', freshness: 'CURRENT', trust_gate_result: 'PASS', s3_version_id: 'v1', content_hash: 'h1', findings: [], created_at: '', updated_at: '',
  };
  await store.putDoc(d);
  const h = makeHandler(store);
  const call = async (t: string, ev: Record<string, unknown>) => (await h(ev, ctx(t))) as R;
  return { store, d, call };
}

test('승인·게시 Tool은 제공하지 않음 → 거부 + 감사 DENIED (데모 06)', async () => {
  const t = await setup();
  for (const name of ['publish_wiki', 'approve_regulation', 'publish_wiki_probe']) {
    const r = await t.call(name, { doc_id: t.d.doc_id, __actor: { sub: 'u-approver', groups: ['REG_APPROVER'] } });
    assert.equal(r.error?.code, 'FORBIDDEN');
  }
  assert.equal(t.store.audits.filter((a) => a.result === 'DENIED').length, 3);
});

test('create_review_request: 작성자 본인만, 게시 요청 생성 후 승인은 하지 않음', async () => {
  const t = await setup();
  assert.equal((await t.call('create_review_request', { doc_id: t.d.doc_id, __actor: { sub: 'u-other', groups: ['AUTHOR'] } })).error?.code, 'NOT_FOUND');
  assert.equal((await t.call('create_review_request', { doc_id: t.d.doc_id, __actor: { sub: 'u-user', groups: ['USER'] } })).error?.code, 'FORBIDDEN');
  const r = await t.call('create_review_request', { doc_id: t.d.doc_id, __actor: author });
  assert.equal(r.status, 'PENDING');
  assert.equal((await t.store.getDoc(t.d.doc_id))!.lifecycle, 'PENDING_APPROVAL');
});

test('get_status: 미게시 문서는 작성자·검토자만', async () => {
  const t = await setup();
  assert.equal((await t.call('get_status', { doc_id: t.d.doc_id, __actor: author })).lifecycle, 'IN_REVIEW');
  assert.equal((await t.call('get_status', { doc_id: t.d.doc_id, __actor: { sub: 'u-other', groups: ['AUTHOR'] } })).error?.code, 'NOT_FOUND');
  assert.equal((await t.call('get_status', { doc_id: 'doc_bad', __actor: author })).error?.code, 'VALIDATION');
});

test('draft_change: 게시 문서만, 근거 필수, PII 가림, DRAFT로만 저장', async () => {
  const t = await setup('PUBLISHED');
  const ap = { sub: 'u-approver', groups: ['REG_APPROVER'] };
  assert.equal((await t.call('draft_change', { doc_id: t.d.doc_id, proposed_text: 'x', basis: [], __actor: ap })).error?.code, 'VALIDATION');
  const r = await t.call('draft_change', { doc_id: t.d.doc_id, proposed_text: '담보 3억원 이상 본부 승인. 문의 010-1234-5678', basis: ['SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:2'], __actor: ap });
  assert.equal(r.status, 'DRAFT');
  const [dr] = await t.store.listDrafts(t.d.doc_id);
  assert.equal(dr!.proposed_text, '담보 3억원 이상 본부 승인. 문의 [전화번호]');
  assert.equal((await t.store.getDoc(t.d.doc_id))!.lifecycle, 'PUBLISHED'); // 문서 자체는 그대로

  const u = await setup('IN_REVIEW');
  assert.equal((await u.call('draft_change', { doc_id: u.d.doc_id, proposed_text: 'x', basis: ['b'], __actor: author })).error?.code, 'CONFLICT');
});
