// store-postgres 계약 실측 (dev Aurora, Data API). 사용: eval "$(apps/api/scripts/ssm-env.sh dev)"; node apps/api/scripts/check-postgres-store.ts
// 시험 문서는 끝에 지운다 (권한이 없으면 DELETED로 남김). 감사 기록은 추가만이라 actor 'qa:store-check'로 남는다
import assert from 'node:assert/strict';
import { db } from '@hanaeum/db';
import { newId, type DocumentRecord } from '../src/contracts.ts';
import { postgresStore } from '../src/store-postgres.ts';

const s = postgresStore();
const id = newId.doc();
const at = new Date().toISOString();
const doc: DocumentRecord = {
  doc_id: id, version: 1, owner: 'qa:store-check', title: '[SYNTHETIC] store 점검', dept: 'qa', acl_groups: ['DEPT#qa'], ext: 'pdf', lifecycle: 'QUARANTINED',
  authority_status: 'UNVERIFIED', freshness: 'CURRENT', findings: [], created_at: at, updated_at: at,
  title_source: 'AUTO', doc_dates: [{ kind: '시행', date: '2026-12-01', page: 0 }], classification: { document_type: 'KNOWHOW', business_path: ['여신'], tags: [], confidence: 0.9, rationale: 'r', source: 'MODEL' },
};
const f = (step: string, code: string) => ({ finding_id: newId.fnd(), step, severity: 'MEDIUM' as const, code, message: 'm', evidence_ref: 'e', user_message: '사람 문장', location: { page: 1 } });
try {
  await s.putDoc(doc);
  let got = (await s.getDoc(id))!;
  assert.deepEqual({ ...got, updated_at: at, created_at: at }, doc, '왕복 모양 같음');
  // 단계 A가 읽은 뒤, 단계 B가 자기 findings를 쓰고, A가 늦게 써도 B의 findings는 남는다
  const a = (await s.getDoc(id))!;
  await s.putDoc({ ...a, findings: [...a.findings, f('PII_SCAN', 'PII_X')] });
  await s.putDoc({ ...a, findings: [...a.findings, f('INJECTION_SCAN', 'INJ_X')] });
  got = (await s.getDoc(id))!;
  assert.deepEqual(got.findings.map((x) => x.step).sort(), ['INJECTION_SCAN', 'PII_SCAN'], '병렬 단계 findings 보존');
  // 같은 단계 재실행은 교체
  await s.putDoc({ ...got, findings: [...got.findings.filter((x) => x.step !== 'PII_SCAN'), f('PII_SCAN', 'PII_Y')] });
  got = (await s.getDoc(id))!;
  assert.deepEqual(got.findings.map((x) => x.code).sort(), ['INJ_X', 'PII_Y'], '같은 단계는 교체');
  assert.equal(got.findings[0]!.user_message, '사람 문장');
  assert.ok((await s.listDocsByOwner('qa:store-check')).some((x) => x.doc_id === id));
  assert.ok((await s.listDocsByLifecycle(['QUARANTINED'])).some((x) => x.doc_id === id));
  // 승인: 생성 → 중복 생성 CONFLICT → 결정은 approver_name 열이 생긴 뒤 → 사용 1회
  const apr = { approval_id: newId.apr(), doc_id: id, version: 1, s3_version_id: 'v1', content_hash: 'sha256:x', author_sub: 'qa:store-check', status: 'PENDING' as const, created_at: at };
  await s.createApproval(apr);
  await assert.rejects(s.createApproval(apr), /approval exists/);
  assert.equal((await s.getApproval(apr.approval_id))!.status, 'PENDING');
  await assert.rejects(s.decideApproval(apr.approval_id, { status: 'APPROVED', approver_sub: 'qa:store-check', reason: 'r', s3_version_id: 'v1', content_hash: 'sha256:x' }), /self approval|approver_name/);
  let decided = false;
  try {
    await assert.rejects(s.decideApproval(apr.approval_id, { status: 'APPROVED', approver_sub: 'qa:other', approver_name: 'qa', reason: 'r', s3_version_id: 'v2', content_hash: 'sha256:x' }), /changed after review/);
    const ok = await s.decideApproval(apr.approval_id, { status: 'APPROVED', approver_sub: 'qa:other', approver_name: 'qa', reason: 'r', s3_version_id: 'v1', content_hash: 'sha256:x' });
    assert.equal(ok.status, 'APPROVED'); decided = true;
    assert.equal((await s.consumeApproval(apr.approval_id)).status, 'USED');
    await assert.rejects(s.consumeApproval(apr.approval_id), /not usable/);
  } catch (e) { console.log('decide/consume 생략:', (e as Error).message.slice(0, 120)); }
  await s.putFeedback({ doc_id: id, user_sub: 'qa:u', useful: true, stars: 4, updated_at: at });
  await s.putFeedback({ doc_id: id, user_sub: 'qa:u', useful: false, updated_at: at });
  await s.audit({ at, actor: 'qa:store-check', action: 'STORE_CHECK', resource: id, result: 'OK', trace_id: 'qa' });
  console.log(`OK store-postgres 계약 (decide/consume ${decided ? '포함' : '열 없음으로 생략'})`);
} finally {
  const q = db().query;
  try {
    await q('DELETE FROM feedback WHERE doc_id = :id', { id }); await q('DELETE FROM approvals WHERE doc_id = :id', { id }); await q('DELETE FROM documents WHERE doc_id = :id', { id });
    console.log('정리: 시험 문서 삭제');
  } catch (e) { await s.putDoc({ ...(await s.getDoc(id))!, lifecycle: 'DELETED', deleted_reason: 'store 점검' }).catch(() => {}); console.log('정리: 삭제 권한 없음 → DELETED 표시', (e as Error).message.slice(0, 80)); }
}
