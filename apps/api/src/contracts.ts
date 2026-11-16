// interfaces.md v0 계약의 로컬 사본.
// ponytail: packages/schemas(let522mj) 미존재 → 임시 사본. 생기면 이 파일을 re-export로 교체.
import { z } from 'zod';
import { ulid } from 'ulid';

export const ROLES = ['USER', 'AUTHOR', 'REG_APPROVER', 'SECURITY_REVIEWER', 'PLATFORM_OPERATOR'] as const;
export type Role = (typeof ROLES)[number];

export type DocumentType = 'REGULATION' | 'KNOWHOW' | 'MANUAL';
export type AuthorityStatus = 'VERIFIED' | 'UNVERIFIED' | 'REJECTED';
export type Freshness = 'CURRENT' | 'REVIEW_REQUIRED' | 'SUPERSEDED';
/** DELETED: 폐기(이력 보존, 검색·보관함 제외). let522mj 재게시·테스트 정리에서 사용 */
export type Lifecycle = 'QUARANTINED' | 'IN_REVIEW' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'BLOCKED' | 'DELETED';
export type TrustGateResult = 'PASS' | 'REVIEW_REQUIRED' | 'QUARANTINED';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';
export type StepStatus = 'OK' | 'REVIEW_REQUIRED' | 'BLOCKED';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'USED';

export const newId = {
  doc: () => `doc_${ulid()}`,
  wf: () => `wf_${ulid()}`,
  apr: () => `apr_${ulid()}`,
  fnd: () => `fnd_${ulid()}`,
  draft: () => `drf_${ulid()}`,
};

/** message에 원문 PII를 넣지 않는다. */
export interface Finding {
  finding_id: string;
  step: string;
  severity: Severity;
  code: string;
  message: string;
  evidence_ref: string;
}

export interface StepOutput {
  status: StepStatus;
  output_key?: string;
  findings?: Finding[];
}

export interface Actor {
  sub: string;
  groups: Role[];
  dept?: string;
}

export interface DocumentRecord {
  doc_id: string;
  version: number;
  owner: string; // author sub
  title: string;
  dept: string;
  acl_groups: string[];
  ext: string;
  lifecycle: Lifecycle;
  document_type?: DocumentType;
  authority_status: AuthorityStatus;
  conditional?: boolean;
  freshness: Freshness;
  trust_gate_result?: TrustGateResult;
  classification?: { document_type: DocumentType; business_path: string[]; tags: string[]; confidence: number; rationale: string; source?: 'MODEL' | 'HUMAN' };
  /** 사람 분류 수정 이력 (docs/04 3장: 결과·confidence·rationale·사람 수정 이력 저장) */
  classification_history?: { at: string; by: string; from?: DocumentType; to: DocumentType; reason: string }[];
  s3_version_id?: string;
  /** `sha256:{hex}` 검사한 원본 바이트. 승인 바인딩·Promote 대조 기준 */
  content_hash?: string;
  /** let522mj Promote가 기록하는 게시본 해시 (검색 재검증 기준) */
  published_content_hash?: string;
  /** 규정 메타데이터 (Classify·TrustGate가 Registry 대조로 채움) */
  law_id?: string; law_name?: string; revision_id?: string; effective_from?: string; effective_to?: string; registry_doc_no?: string; previous_revision_id?: string;
  /** 승인된 노하우 인용 (GraphUpsert 입력) */
  citations?: { provision_id: string; evidence_span: string; confidence: number }[];
  /** 문서보관함 요약 (Classify 단계, 마스킹본 → Haiku). page_summaries[i] = page_index i 요약 */
  summary?: string;
  page_summaries?: { page: number; summary: string }[];
  /** 노하우 검증 결과 (TrustGate가 KNOWHOW 문서에 기록) */
  knowhow_validation?: import('./steps/knowhow.ts').KnowhowValidation;
  /** 근거 규정 개정·시행으로 재검토가 필요해진 이유 (freshness=REVIEW_REQUIRED). 자동 수정 없음 */
  freshness_reason?: { law_id: string; law_name: string; cited_revision: string; current_revision: string; effective_from: string; provisions: string[]; at: string };
  deleted_reason?: string;
  /** 출처 불일치 처리 결과 */
  source_review?: { decision: 'REJECT'; by: string; reason: string; at: string };
  /** 파싱 이슈를 사람이 검토했는지 (GraphUpsert 적재 허용) */
  parse_reviewed?: boolean;
  workflow_id?: string;
  findings: Finding[];
  created_at: string;
  updated_at: string;
}

export interface ApprovalRecord {
  approval_id: string;
  doc_id: string;
  version: number;
  s3_version_id: string;
  content_hash: string;
  author_sub: string;
  approver_sub?: string;
  status: ApprovalStatus;
  reason?: string;
  decided_at?: string;
  created_at: string;
}

/** 수정 초안. Agent가 만들지만 게시되지 않는다 (사람 재승인 필요, docs/01 6장) */
export interface DraftRecord {
  draft_id: string;
  doc_id: string;
  base_version: number;
  proposed_text: string; // 마스킹·PII 검사 후 저장
  basis: string[]; // 근거 조문·문서 ID
  created_by: string;
  status: 'DRAFT';
  created_at: string;
}

export interface FeedbackRecord {
  doc_id: string;
  user_sub: string;
  stars?: number;
  useful: boolean;
  updated_at: string;
}

// ---- 요청 바디 ----
export const ALLOWED_EXT = ['pdf', 'docx', 'hwpx', 'png', 'jpg', 'jpeg'] as const;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // ponytail: 50MB 고정, 필요 시 환경변수화

export const UploadUrlBody = z.object({
  filename: z.string().min(1).max(200),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  title: z.string().min(1).max(200),
  dept: z.string().min(1).max(50),
  acl_groups: z.array(z.string().min(1).max(50)).min(1).max(20),
});

export const DecisionBody = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'REVALIDATE']),
  reason: z.string().min(1).max(1000),
});

export const FeedbackBody = z.object({
  doc_id: z.string().regex(/^doc_[0-9A-HJKMNP-TV-Z]{26}$/),
  stars: z.number().int().min(1).max(5).optional(), // 가이드의 "도움이 됐어요"는 별점 없이 useful만
  useful: z.boolean(),
});

export const ClassificationBody = z.object({
  document_type: z.enum(['REGULATION', 'KNOWHOW', 'MANUAL']),
  reason: z.string().min(1).max(500),
});

/** 출처 불일치 문서 처리 (규정 승인자·보안 검토자). 위조로 확정하지 않고 '반려'만 한다 */
export const SourceReviewBody = z.object({ decision: z.literal('REJECT'), reason: z.string().min(1).max(1000) });

export const GuideBody = z.object({ question: z.string().trim().min(1).max(1000) });
