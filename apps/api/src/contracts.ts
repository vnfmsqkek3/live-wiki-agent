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
  cat: () => `cat_${ulid().toLowerCase()}`, // 업무 분류 칸 (초기 칸은 cat_loan 처럼 소문자)
};

/** message에 원문 PII를 넣지 않는다. */
/** 올린 사람에게 "몇 쪽 어디가" 보여 주기 위한 위치 (사용자 지시 11/17, 요청기록 0106). page는 1부터, excerpt는 마스킹본 120자 이하 */
export interface FindingLocation { page?: number; bbox?: number[][]; excerpt?: string }

export interface Finding {
  /** 올린 사람이 '의도한 삭제'로 확인 (EDIT_REMOVED_KEY_SENTENCE). 확인된 것은 게시 요청을 막지 않고 승인자 '자세히'에 남는다 */
  acknowledged?: { by: string; at: string; reason?: string };
  finding_id: string;
  step: string;
  severity: Severity;
  code: string;
  message: string;
  evidence_ref: string;
  location?: FindingLocation;
  /** 올린 사람용 한 문장: 몇 쪽·무엇이·왜 */
  user_message?: string;
  /** 어떻게 고쳐 다시 올리는지 */
  fix_hint?: string;
  /** 판정 근거 사실 (explain_findings 모델 입력, yoyo0704). 원문·개인정보 금지 */
  details?: Record<string, unknown>;
}

/** 마스킹본에서 [start,end) 주변 문장 일부 (120자 이하, 줄바꿈 정리) */
export function excerptAround(text: string, start: number, end: number, max = 120): string {
  const pad = Math.max(0, Math.floor((max - (end - start)) / 2));
  const a = Math.max(0, start - pad), b = Math.min(text.length, end + pad);
  return `${a > 0 ? '…' : ''}${text.slice(a, b).replace(/\s+/g, ' ').trim()}${b < text.length ? '…' : ''}`.slice(0, max + 2);
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
  /** Cognito 로그인 아이디 (access token username). 화면 표시용 */
  username?: string;
}

export interface DocumentRecord {
  doc_id: string;
  version: number;
  owner: string; // author sub
  title: string;
  /** AUTO: 업로드 때 비워 두어 분석(Classify)이 채움 / USER: 작성자가 입력·수정 (사용자 요청 11/17) */
  title_source?: 'AUTO' | 'USER';
  title_history?: { from: string; to: string; by: string; at: string }[];
  /** 올린 파일 이름 (제목 후보용, 경로 없음) */
  filename?: string;
  /** 본문에 적힌 일자 (legal-parser docDates). doc_date는 대표 일자(시행 > 개정 > 제정 > 작성 …) */
  doc_date?: { kind: string; date: string; page: number };
  doc_dates?: { kind: string; date: string; page: number }[];
  /** 버전 관리: series_id = 첫 버전 doc_id, 작성자가 확인한 경우에만 연결. 새 버전 게시 시 이전 버전 freshness=SUPERSEDED·superseded_by */
  series_id?: string;
  version_no?: number;
  previous_doc_id?: string;
  /** 위키 그 자리 수정 전의 결정·본문 (steps/carry.ts). 재분석 뒤 검토 대기로 갈 때 '해당 없음'·'그대로 사용'을 잇고 고치지 않은 문장의 새 질문은 뺀다 */
  review_carry?: import('./steps/carry.ts').ReviewCarry;
  /** AI 검사(전 단계)가 끝나 검토 대기로 간 시각. 도장 'AI 검사' 칸 날짜 */
  checked_at?: string;
  /** 위키 수정 요청 (steps/change-request.ts, 사용자 결정 11/18) */
  change_requests?: import('./steps/change-request.ts').ChangeRequest[];
  /** 위키 수정 전 처음 올린 원본 파일 (버킷 버전). '원본 파일' 다운로드 */
  original_upload?: { key: string; version_id: string; filename: string };
  /** 위키 수정본의 '(그림 쪽-k)'가 가리키는 그림: 원래 문서와 그림을 보여도 되는 쪽(개인정보 확인을 마친 쪽) */
  figure_source?: { doc_id: string; pages: number[] };
  /** WIKI_EDIT: 위키 수정본(정리본 마크다운, 사용자 결정 11/17 규칙 1). 없으면 파일 업로드 */
  source?: 'UPLOAD' | 'WIKI_EDIT';
  /** 위키 수정본의 이전 버전 대비 문장 수 (TrustGate 수정분 검수) */
  edit_diff?: { changed: number; removed: number };
  superseded_by?: string;
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
  /** deleted_doc: 근거 규정 문서가 삭제됨(문서 삭제 흐름, interfaces 6.0) */
  /** 게시 문서 '고칠 곳'을 해당 없음으로 둔 기록 (사용자 요청 11/19). key = markKey. 표시는 참고로 내린다 */
  mark_dismissals?: { key: string; reason: string; by: string; at: string }[];
  freshness_reason?: { law_id: string; law_name: string; cited_revision: string; current_revision: string; effective_from: string; provisions: string[]; at: string; deleted_doc?: string };
  deleted_reason?: string;
  deleted_by?: string;
  /** 사용자 삭제 정리 실행 (purge_document → kb_ingest → graph_upsert → finalize). 정리가 끝나면 purge.deleted_at */
  delete_workflow_id?: string;
  /** 검증 실패·반려 문서의 파일 삭제 기록 (원본·work 즉시, masked는 보관 기간 뒤). 사용자 삭제는 deleted_at·review_required(근거를 잃은 노하우) */
  purge?: { original_at?: string; masked_at?: string; objects: number; deleted_at?: string; review_required?: string[] };
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
  /** 승인자 로그인 아이디 (상세 화면 '검증한 사람') */
  approver_name?: string;
  status: ApprovalStatus;
  reason?: string;
  decided_at?: string;
  created_at: string;
  /** 관리자 본인 문서 결재 (사용자 결정 11/18) */
  self_approved?: boolean;
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
  title: z.string().trim().max(200).optional(), // 비우면 분석 후 자동 제목
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
export const TitleBody = z.object({ title: z.string().trim().min(1).max(200) });
export const PreviousBody = z.object({ previous_doc_id: z.string().min(1).max(40).nullable() });
export const CategoryRenameBody = z.object({ name: z.string().trim().min(2).max(20).regex(/^[^/|]+$/, '/ | 는 쓸 수 없습니다') });
export const CategoryMergeBody = z.object({ into: z.string().min(1).max(40) });
export const EditBody = z.object({ markdown: z.string().trim().min(1).max(200_000) });
export const DeleteBody = z.object({ reason: z.string().trim().min(1).max(500) });
export const SourceReviewBody = z.object({ decision: z.literal('REJECT'), reason: z.string().min(1).max(1000) });

export const GuideBody = z.object({ question: z.string().trim().min(1).max(1000) });
