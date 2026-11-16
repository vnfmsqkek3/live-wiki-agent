// 공유 계약의 단일 원본 (docs/interfaces.md 1·2·5·6장). 변경 시 interfaces.md 변경 이력 + 요청기록/ 통지.
import { z } from "zod";

// ── 1. ID ──────────────────────────────────────────────
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
export const DocId = z.string().regex(new RegExp(`^doc_${ULID}$`));
export const DocVersionId = z.string().regex(new RegExp(`^doc_${ULID}@v[1-9]\\d*$`));
export const WorkflowId = z.string().regex(new RegExp(`^wf_${ULID}$`));
export const ApprovalId = z.string().regex(new RegExp(`^apr_${ULID}$`));
export const FindingId = z.string().regex(new RegExp(`^fnd_${ULID}$`));

/** 법령 ID 본체: 영문 대문자·숫자·하이픈 (예 SYN-LOAN-001) */
export const LAW_ID = "[A-Z][A-Z0-9-]*[A-Z0-9]";
export const REV = "\\d{4}-\\d{2}-\\d{2}";
export const LawRevisionId = z.string().regex(new RegExp(`^${LAW_ID}@${REV}$`));

/** 목 코드: 국어 로마자 표기 대문자 (docs/01 7.6) */
export const SUBITEM_CODES = {
  가: "GA", 나: "NA", 다: "DA", 라: "RA", 마: "MA", 바: "BA", 사: "SA",
  아: "A", 자: "JA", 차: "CHA", 카: "KA", 타: "TA", 파: "PA", 하: "HA",
} as const;
export type SubitemChar = keyof typeof SUBITEM_CODES;
export type SubitemCode = (typeof SUBITEM_CODES)[SubitemChar];
export const SUBITEM_CHARS = Object.keys(SUBITEM_CODES) as SubitemChar[];
const SUBITEM_ALT = Object.values(SUBITEM_CODES).sort((a, b) => b.length - a.length).join("|");

// 부칙은 본칙과 별도 네임스페이스(SUPPLEMENTARY:{k}/), 별표는 ANNEX:{n}[-{m}] (팀 결정 v0)
export const ProvisionId = z.string().regex(
  new RegExp(
    `^${LAW_ID}@${REV}/(?:(?:SUPPLEMENTARY:\\d+/)?ARTICLE:\\d+(?:-\\d+)?(?:/PARAGRAPH:\\d+)?(?:/ITEM:\\d+(?:-\\d+)?)?(?:/SUBITEM:(?:${SUBITEM_ALT}))?|SUPPLEMENTARY:\\d+|ANNEX:\\d+(?:-\\d+)?)$`,
  ),
);

// ── 2. 상태 enum ───────────────────────────────────────
export const DocumentType = z.enum(["REGULATION", "KNOWHOW", "MANUAL"]);
export const AuthorityStatus = z.enum(["VERIFIED", "UNVERIFIED", "REJECTED"]);
export const Freshness = z.enum(["CURRENT", "REVIEW_REQUIRED", "SUPERSEDED"]);
export const Lifecycle = z.enum(["QUARANTINED", "IN_REVIEW", "PENDING_APPROVAL", "PUBLISHED", "BLOCKED"]);
export const TrustGateResult = z.enum(["PASS", "REVIEW_REQUIRED", "QUARANTINED"]);
export const ProvisionStatus = z.enum(["ACTIVE", "HISTORICAL", "DELETED"]);
export const SearchStatus = z.enum(["FOUND", "HISTORICAL", "DELETED", "NOT_FOUND_VERIFIED", "UNVERIFIED", "ACCESS_DENIED"]);
export const Role = z.enum(["USER", "AUTHOR", "REG_APPROVER", "SECURITY_REVIEWER", "PLATFORM_OPERATOR"]);
export const IndexGroup = z.enum(["legal-clauses", "wiki-knowledge", "official-manuals"]);

export type DocumentType = z.infer<typeof DocumentType>;
export type AuthorityStatus = z.infer<typeof AuthorityStatus>;
export type Freshness = z.infer<typeof Freshness>;
export type Lifecycle = z.infer<typeof Lifecycle>;
export type ProvisionStatus = z.infer<typeof ProvisionStatus>;
export type SearchStatus = z.infer<typeof SearchStatus>;
export type Role = z.infer<typeof Role>;
export type IndexGroup = z.infer<typeof IndexGroup>;

// ── 5. 메타데이터 사이드카 ─────────────────────────────
/** yyyymmdd 숫자. KB 범위 필터용 (docs/04 4.1) */
export const YmdNumber = z.number().int().min(19000101).max(99991231);
export const OPEN_END = 99991231;

export const DocumentMetadata = z.object({
  doc_id: z.string().min(1),
  document_type: DocumentType,
  index_group: IndexGroup,
  authority_status: AuthorityStatus,
  freshness: Freshness,
  lifecycle: Lifecycle,
  title: z.string().min(1), // v0.1 추가: 청크 문맥 헤더용
  law_id: z.string().optional(),
  law_name: z.string().optional(), // v0.1 추가: 법령 청크 헤더용
  revision_id: z.string().regex(new RegExp(`^${REV}$`)).optional(),
  effective_from: YmdNumber,
  effective_to: YmdNumber,
  acl_groups: z.array(z.string().min(1)).min(1),
  dept: z.string().min(1),
  approval_id: z.string().min(1),
  content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  // v0.2: Classify 결과 (업무 경로·태그). 문서보관함 카드·검색 필터. 비어 있으면 생략 (KB 목록 메타데이터에 빈 배열 금지)
  business_path: z.array(z.string().min(1)).min(1).max(3).optional(),
  tags: z.array(z.string().min(1)).min(1).max(8).optional(),
}).refine((m) => m.effective_from <= m.effective_to, "effective_from > effective_to")
  .refine((m) => m.document_type !== "REGULATION" || (m.law_id && m.revision_id), "REGULATION은 law_id·revision_id 필수");
export type DocumentMetadata = z.infer<typeof DocumentMetadata>;

/** Chunker가 청크마다 추가하는 필드 */
export const ChunkMetadata = z.object({
  provision_id: z.string().min(1),
  provision_path: z.string().min(1),
  provision_status: ProvisionStatus,
  parent_id: z.string(),
  source_page: z.number().int().nonnegative(),
});
export type ChunkMetadata = z.infer<typeof ChunkMetadata>;

/** S3 `{file}.metadata.json` 형식 */
export const MetadataSidecar = z.object({ metadataAttributes: DocumentMetadata });

// ── 6. 단계 입출력 ─────────────────────────────────────
export const Severity = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const Finding = z.object({
  finding_id: z.string().min(1),
  step: z.string().min(1),
  severity: Severity,
  code: z.string().min(1),
  message: z.string(), // 원문 PII 금지
  evidence_ref: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const StepInput = z.object({
  workflow_id: z.string().min(1),
  doc_id: z.string().min(1),
  version: z.number().int().positive(),
  bucket: z.string().min(1),
  prefix: z.string(),
  actor: z.object({ sub: z.string().min(1), groups: z.array(z.string()) }),
});
export type StepInput = z.infer<typeof StepInput>;

export const StepOutput = z.object({
  status: z.enum(["OK", "REVIEW_REQUIRED", "BLOCKED", "PENDING"]), // PENDING: 폴링 단계만 (MalwareCheck·OcrIfNeeded·KbIngest)
  output_key: z.string().optional(),
  content_hash: z.string().optional(), // Promote: 게시본 해시 (Finalize가 Documents에 기록)
  findings: z.array(Finding).optional(),
});
export type StepOutput = z.infer<typeof StepOutput>;

// ── 법령 구조 (docs/01 7.4·7.5) ─────────────────────────
export const ProvisionLevel = z.enum(["PART", "CHAPTER", "SECTION", "ARTICLE", "PARAGRAPH", "ITEM", "SUBITEM", "SUPPLEMENTARY", "ANNEX"]);
export type ProvisionLevel = z.infer<typeof ProvisionLevel>;

export const Reference = z.object({
  raw: z.string(),
  kind: z.enum(["ABSOLUTE", "RELATIVE", "EXTERNAL", "ANNEX"]),
  target_id: z.string().nullable(), // 해석 실패 시 null (미해결)
  exception_candidate: z.boolean(),
});
export type Reference = z.infer<typeof Reference>;

export const Provision = z.object({
  provision_id: z.string(),
  level: ProvisionLevel,
  original_marker: z.string(),
  title: z.string().optional(),
  original_text: z.string(),
  normalized_text: z.string(),
  parent_id: z.string().nullable(),
  sibling_order: z.number().int().nonnegative(),
  status: ProvisionStatus,
  deletion_date: z.string().optional(),
  amendments: z.array(z.object({ kind: z.enum(["개정", "신설"]), dates: z.array(z.string()) })),
  tail_tags: z.record(z.string(), z.string()),
  references: z.array(Reference),
  path_label: z.string(), // 표시용 "제12조제2항제1호가목"
  heading_path: z.array(z.string()), // 편·장·절 제목
  source_line: z.number().int().positive(),
});
export type Provision = z.infer<typeof Provision>;

export const ParsedLaw = z.object({
  law_id: z.string(),
  law_name: z.string(),
  revision_id: z.string(),
  effective_from: YmdNumber,
  parser_version: z.string(),
  provisions: z.array(Provision),
  issues: z.array(z.object({ code: z.string(), line: z.number().int(), message: z.string() })),
});
export type ParsedLaw = z.infer<typeof ParsedLaw>;

// ── 검색 결과 (MCP search/regulation 공통) ──────────────
export const Citation = z.object({
  doc_id: z.string(),
  provision_id: z.string().optional(),
  path_label: z.string().optional(),
  original_text: z.string(),
  authority_status: AuthorityStatus,
  freshness: Freshness,
  effective_from: YmdNumber,
  effective_to: YmdNumber,
  score: z.number().optional(),
});
export type Citation = z.infer<typeof Citation>;

// ── 헬퍼 ───────────────────────────────────────────────
export const ymd = (isoDate: string): number => Number(isoDate.replaceAll("-", ""));
export const isoFromDotted = (s: string): string => {
  const [y, m, d] = s.split(".").map((x) => x.trim()).filter(Boolean);
  return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
};

/** ULID (Crockford base32, 48bit 시간 + 80bit 난수). 접두어는 호출부에서 붙인다 */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newUlid(now = Date.now()): string {
  let t = "";
  for (let i = 0; i < 10; i++) { t = B32[now % 32] + t; now = Math.floor(now / 32); }
  const r = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (let i = 0; i < 16; i++) s += B32[r[i]! % 32];
  return t + s;
}
export const newId = (prefix: "doc" | "wf" | "apr" | "fnd"): string => `${prefix}_${newUlid()}`;

/** 페이지 그림 묘사 (ImageDescribe 단계, yoyo0704) → 게시 본문 끝에 한 줄씩. 인용 원문이 아니므로 별도 청크(has_figure)로만 색인 */
export interface Figure { kind: string; description: string; overlay_text?: string; intent?: string }
export const FIGURE_RE = /^⟦그림 p(\d+)⟧ (.+)$/u;
export const figureLine = (page: number, f: Figure) =>
  `⟦그림 p${page}⟧ ${[`${f.kind}: ${f.description}`, f.overlay_text ? `표기: ${f.overlay_text}` : "", f.intent ? `의도: ${f.intent}` : ""].filter(Boolean).join(" / ").replace(/\s+/gu, " ")}`;
