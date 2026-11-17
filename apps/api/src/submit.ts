// 게시 요청(Approvals 생성). API(POST /v1/documents/{id}/submit)와 approval MCP Tool(create_review_request)이 함께 쓴다.
// 승인 자체는 하지 않는다 (사람만, POST /v1/approvals/{id}/decision).
import { newId, type ApprovalRecord, type DocumentRecord } from './contracts.ts';
import { ApiError } from './errors.ts';
import type { Store } from './store.ts';

export const hasSourceMismatch = (d: DocumentRecord) => d.findings.some((f) => f.code === 'REGISTRY_MISMATCH');

export async function submitForApproval(store: Store, d: DocumentRecord, actorSub: string): Promise<ApprovalRecord> {
  if (d.owner !== actorSub) throw new ApiError('FORBIDDEN', 'not the owner');
  if (d.lifecycle !== 'IN_REVIEW' || !d.trust_gate_result || d.trust_gate_result === 'QUARANTINED')
    throw new ApiError('CONFLICT', `cannot submit in ${d.lifecycle}/${d.trust_gate_result ?? 'NO_GATE'}`);
  if (!d.s3_version_id || !d.content_hash) throw new ApiError('CONFLICT', 'no analyzed version');
  // 공식 원본과 다른 문서는 '위조 확정'은 아니지만 출처가 확인될 때까지 게시 요청을 막는다 (docs/02 위조 5건 게시 차단 + docs/01 4.4)
  if (hasSourceMismatch(d)) throw new ApiError('CONFLICT', 'source mismatch: 공식 원본과 내용이 다릅니다. 출처 확인 전에는 게시를 요청할 수 없습니다');
  // 분류 전 문서는 게시 단계(Promote)가 UnclassifiedDocument로 실패한다 → 요청 단계에서 막는다
  if (!(d.document_type ?? d.classification?.document_type)) throw new ApiError('CONFLICT', 'unclassified: 문서 분류가 끝나지 않아 게시를 요청할 수 없습니다. 분석을 다시 실행하세요');
  const now = new Date().toISOString();
  const apr: ApprovalRecord = {
    approval_id: newId.apr(), doc_id: d.doc_id, version: d.version, s3_version_id: d.s3_version_id, content_hash: d.content_hash,
    author_sub: d.owner, status: 'PENDING', created_at: now,
  };
  await store.createApproval(apr);
  await store.putDoc({ ...d, lifecycle: 'PENDING_APPROVAL', updated_at: now });
  return apr;
}
