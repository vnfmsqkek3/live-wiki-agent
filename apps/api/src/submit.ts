// 게시 요청(Approvals 생성). API(POST /v1/documents/{id}/submit)와 approval MCP Tool(create_review_request)이 함께 쓴다.
// 승인 자체는 하지 않는다 (사람만, POST /v1/approvals/{id}/decision).
import { newId, type ApprovalRecord, type DocumentRecord } from './contracts.ts';
import { ApiError } from './errors.ts';
import type { Store } from './store.ts';

export const hasSourceMismatch = (d: DocumentRecord) => d.findings.some((f) => f.code === 'REGISTRY_MISMATCH');

/** 올린 사람이 고쳐야 게시 요청할 수 있는 Finding (사용자 결정 11/17 규칙 2) */
export const FIX_CODES = new Set(['KNOWHOW_CONFLICT', 'EDIT_REMOVED_KEY_SENTENCE', 'CLARIFY_NEEDED']);
/** 게시 요청을 막는 '고칠 것': 확인 필요는 MEDIUM(절차 문장의 담당자·빠진 값)이고 아직 열린 것만 (계약 6.5) */
/** 항목별 사람 확인(Fable 권고·사용자 요청 11/18): 개인정보·비밀값 MEDIUM 은 항목마다 '그대로 사용(사유)' 또는 수정해야 게시 요청 가능. OCR 신뢰도는 잠그지 않음 */
export const REVIEW_CODES = new Set(['PII_IMAGE_REVIEW', 'PII_IN_FIGURE', 'PII_GUARDRAIL', 'SECRET_MASKED']);
export const isOpenFix = (f: { code: string; severity: string; acknowledged?: unknown; details?: Record<string, unknown> }) =>
  (FIX_CODES.has(f.code) && !f.acknowledged && !(f.code === 'CLARIFY_NEEDED' && (f.severity !== 'MEDIUM' || f.details?.['status'] !== 'OPEN')))
  || (REVIEW_CODES.has(f.code) && f.severity === 'MEDIUM' && !f.acknowledged);

export async function submitForApproval(store: Store, d: DocumentRecord, actorSub: string): Promise<ApprovalRecord> {
  if (d.owner !== actorSub) throw new ApiError('FORBIDDEN', 'not the owner');
  if (d.lifecycle !== 'IN_REVIEW' || !d.trust_gate_result || d.trust_gate_result === 'QUARANTINED')
    throw new ApiError('CONFLICT', `cannot submit in ${d.lifecycle}/${d.trust_gate_result ?? 'NO_GATE'}`);
  if (!d.s3_version_id || !d.content_hash) throw new ApiError('CONFLICT', 'no analyzed version');
  // 공식 원본과 다른 문서는 '위조 확정'은 아니지만 출처가 확인될 때까지 게시 요청을 막는다 (docs/02 위조 5건 게시 차단 + docs/01 4.4)
  if (hasSourceMismatch(d)) throw new ApiError('CONFLICT', 'source mismatch: 공식 원본과 내용이 다릅니다. 출처 확인 전에는 게시를 요청할 수 없습니다');
  // 분류 전 문서는 게시 단계(Promote)가 UnclassifiedDocument로 실패한다 → 요청 단계에서 막는다
  // 규칙 2: AI 가 찾은 '고칠 것'이 남아 있으면 게시 요청을 막는다 (규정과 어긋난 문장, 수정에서 지운 중요 문장)
  const fix = d.findings.filter(isOpenFix).length;
  if (fix) throw new ApiError('CONFLICT', `고칠 것·확인할 것 ${fix}건이 남아 있습니다. 처리한 뒤 게시를 요청하세요`);
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
