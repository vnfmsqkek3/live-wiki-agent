// interfaces.md v0 계약의 로컬 사본.
// ponytail: packages/schemas(let522mj) 미존재 → 임시 사본. 생기면 이 파일을 re-export로 교체.
import { z } from 'zod';
import { ulid } from 'ulid';

export const ROLES = ['USER', 'AUTHOR', 'REG_APPROVER', 'SECURITY_REVIEWER', 'PLATFORM_OPERATOR'] as const;
export type Role = (typeof ROLES)[number];

export type DocumentType = 'REGULATION' | 'KNOWHOW' | 'MANUAL';
export type AuthorityStatus = 'VERIFIED' | 'UNVERIFIED' | 'REJECTED';
export type Freshness = 'CURRENT' | 'REVIEW_REQUIRED' | 'SUPERSEDED';
export type Lifecycle = 'QUARANTINED' | 'IN_REVIEW' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'BLOCKED';
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
  content_hash?: string;
  workflow_id?: string;
  task_token?: string;
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
  task_token?: string;
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

export const GuideBody = z.object({ question: z.string().trim().min(1).max(1000) });
