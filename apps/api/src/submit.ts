// 게시 요청(Approvals 생성). API(POST /v1/documents/{id}/submit)와 approval MCP Tool(create_review_request)이 함께 쓴다.
// 승인 자체는 하지 않는다 (사람만, POST /v1/approvals/{id}/decision).
import { newId, type ApprovalRecord, type DocumentRecord } from './contracts.ts';
import { ApiError } from './errors.ts';
import type { Store } from './store.ts';

export async function submitForApproval(store: Store, d: DocumentRecord, actorSub: string): Promise<ApprovalRecord> {
  if (d.owner !== actorSub) throw new ApiError('FORBIDDEN', 'not the owner');
  if (d.lifecycle !== 'IN_REVIEW' || !d.trust_gate_result || d.trust_gate_result === 'QUARANTINED')
    throw new ApiError('CONFLICT', `cannot submit in ${d.lifecycle}/${d.trust_gate_result ?? 'NO_GATE'}`);
  if (!d.s3_version_id || !d.content_hash) throw new ApiError('CONFLICT', 'no analyzed version');
  const now = new Date().toISOString();
  const apr: ApprovalRecord = {
    approval_id: newId.apr(), doc_id: d.doc_id, version: d.version, s3_version_id: d.s3_version_id, content_hash: d.content_hash,
    author_sub: d.owner, status: 'PENDING', task_token: d.task_token, created_at: now,
  };
  await store.createApproval(apr);
  await store.putDoc({ ...d, lifecycle: 'PENDING_APPROVAL', updated_at: now });
  return apr;
}
