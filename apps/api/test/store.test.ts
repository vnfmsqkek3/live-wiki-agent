// Store 계약 테스트. 메모리 구현은 항상, DynamoDB 구현은 TABLE_* 환경변수가 있을 때만 (공유 dev 통합).
//   실행: set -a; . ./.env.local; set +a; eval "$(apps/api/scripts/ssm-env.sh dev)" && npm test -w @hanaeum/api
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore, type Store } from '../src/store.ts';
import { dynamoStore } from '../src/store-dynamo.ts';
import { newId, type ApprovalRecord, type DocumentRecord } from '../src/contracts.ts';

const stores: [string, () => Store][] = [['memory', () => memoryStore()]];
const e = process.env;
if (e.TABLE_DOCUMENTS && e.TABLE_APPROVALS && e.TABLE_FEEDBACK && e.TABLE_AUDIT_EVENTS)
  stores.push(['dynamo', () => dynamoStore({ documents: e.TABLE_DOCUMENTS!, approvals: e.TABLE_APPROVALS!, feedback: e.TABLE_FEEDBACK!, audit: e.TABLE_AUDIT_EVENTS! })]);

const now = () => new Date().toISOString();
const doc = (): DocumentRecord => ({
  doc_id: newId.doc(), version: 1, owner: 'it-author', title: '[SYNTHETIC] store 계약 테스트', dept: 'loan', acl_groups: ['ALL'], ext: 'pdf',
  lifecycle: 'QUARANTINED', authority_status: 'UNVERIFIED', freshness: 'CURRENT', findings: [], created_at: now(), updated_at: now(),
});
const apr = (doc_id: string): ApprovalRecord => ({
  approval_id: newId.apr(), doc_id, version: 1, s3_version_id: 'v1', content_hash: 'h1', author_sub: 'it-author', status: 'PENDING', created_at: now(),
});

for (const [name, make] of stores) {
  test(`${name}: 문서 저장·조회`, async () => {
    const s = make();
    const d = doc();
    await s.putDoc(d);
    assert.deepEqual(await s.getDoc(d.doc_id), d);
    assert.equal(await s.getDoc('doc_NOPE'), undefined);
  });

  test(`${name}: 승인 조건부 전환 (자기 승인·해시 불일치·중복·재사용 차단)`, async () => {
    const s = make();
    const a = apr(newId.doc());
    await s.createApproval(a);
    await assert.rejects(s.createApproval(a), /approval exists/);
    assert.ok((await s.listApprovals('PENDING')).some((x) => x.approval_id === a.approval_id));
    const ok = { status: 'APPROVED' as const, approver_sub: 'it-approver', reason: 'r', s3_version_id: 'v1', content_hash: 'h1' };
    await assert.rejects(s.decideApproval(a.approval_id, { ...ok, approver_sub: 'it-author' }), /self approval/);
    await assert.rejects(s.decideApproval(a.approval_id, { ...ok, content_hash: 'h2' }), /changed after review/);
    assert.equal((await s.decideApproval(a.approval_id, ok)).status, 'APPROVED');
    await assert.rejects(s.decideApproval(a.approval_id, ok), /not pending/);
    assert.ok(!(await s.listApprovals('PENDING')).some((x) => x.approval_id === a.approval_id));
    assert.equal((await s.consumeApproval(a.approval_id)).status, 'USED');
    await assert.rejects(s.consumeApproval(a.approval_id), /not usable/);
    await assert.rejects(s.decideApproval('apr_NOPE', ok), /not found/);
  });

  test(`${name}: 수정 초안 저장·조회 (문서와 같은 테이블, 문서 조회에 섞이지 않음)`, async () => {
    const s = make();
    const d = doc();
    await s.putDoc(d);
    await s.putDraft({ draft_id: newId.draft(), doc_id: d.doc_id, base_version: 1, proposed_text: 't', basis: ['b'], created_by: 'u', status: 'DRAFT', created_at: now() });
    assert.equal((await s.listDrafts(d.doc_id)).length, 1);
    assert.deepEqual(await s.getDoc(d.doc_id), d);
  });

  test(`${name}: 동시 승인 2건 중 1건만 성공`, async () => {
    const s = make();
    const a = apr(newId.doc());
    await s.createApproval(a);
    const ok = { status: 'APPROVED' as const, approver_sub: 'it-approver', reason: 'r', s3_version_id: 'v1', content_hash: 'h1' };
    const r = await Promise.allSettled([s.decideApproval(a.approval_id, ok), s.decideApproval(a.approval_id, { ...ok, approver_sub: 'it-approver2' })]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  });
}
