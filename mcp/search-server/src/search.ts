import { createHash } from "node:crypto";
import { PII_NAME } from "@hanaeum/pii";
// Search MCP: search_wiki, retrieve_evidence, search_legal_clause (docs/04 4.3, docs/01 8.6·8.7)
// 하드 게이트(ACL·공식성·유효기간)는 Rerank 전에 서버가 필터로 강제하고, 결과는 DynamoDB 현재 상태로 다시 검증한다.
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import type { RetrievalFilter } from "@aws-sdk/client-bedrock-agent-runtime";
import { IndexGroup, isoOfYmd } from "@hanaeum/schemas";
import type { AuthorityStatus, Freshness, Lifecycle, SearchStatus } from "@hanaeum/schemas";
import { ToolError, aclKeys, asOfYmd, maskPii, str } from "@hanaeum/mcp-kit";
import type { Actor } from "@hanaeum/mcp-kit";
import type { regulationTools } from "@hanaeum/regulation-server";
import { cleanQuery } from "./rewrite.ts";
import type { Rewriter, Rewritten } from "./rewrite.ts";

// ── 필터 ───────────────────────────────────────────────
export interface FilterOpts {
  asOf: number; indexGroups?: IndexGroup[]; includeHistory?: boolean; docIds?: string[]; business?: string; tags?: string[];
  /** 세부 필터 (사용자 요청 11/17): 부서, 문서 일자 기간(YYYYMMDD, 본문 대표 일자), 검증 상태·최신성(Documents 현재 상태로 거름) */
  dept?: string; dateFrom?: number; dateTo?: number; authority?: "VERIFIED" | "UNVERIFIED"; freshness?: "CURRENT" | "REVIEW_REQUIRED";
  /** 업무 분류 경로 (하위 포함). 예 "경영지원" → "경영지원", "경영지원/사무기기·시설" */
  category?: string;
  /** false면 KB 경로 필터를 빼고(doc_id로 이미 좁힘) 현재 분류 재검증만 */
  kbCategory?: boolean;
  /** 장(章) 하나로 좁힘 (청크 메타데이터 section) */
  section?: string;
  /** "section": 걸린 조각과 같은 장의 조각들을 쪽 순서로 함께 (사용자 지적 11/18: 여러 쪽에 걸친 절차) */
  expand?: "section";
}

export function buildFilter(actor: Actor, o: FilterOpts): RetrievalFilter {
  const keys = aclKeys(actor);
  const acl: RetrievalFilter = keys.length === 1
    ? { listContains: { key: "acl_groups", value: keys[0] } }
    : { orAll: keys.map((k) => ({ listContains: { key: "acl_groups", value: k } })) };
  const conds: RetrievalFilter[] = [
    acl,
    { equals: { key: "lifecycle", value: "PUBLISHED" } },
    { notEquals: { key: "authority_status", value: "REJECTED" } },
  ];
  if (!o.includeHistory) {
    conds.push(
      { lessThanOrEquals: { key: "effective_from", value: o.asOf } },
      { greaterThanOrEquals: { key: "effective_to", value: o.asOf } },
      { notEquals: { key: "provision_status", value: "DELETED" } },
    );
  }
  if (o.indexGroups?.length) conds.push({ in: { key: "index_group", value: o.indexGroups } });
  if (o.docIds?.length) conds.push({ in: { key: "doc_id", value: o.docIds } });
  // 업무 분류(1단계 일치)·태그(하나라도 일치)
  if (o.business) conds.push({ listContains: { key: "business_path", value: o.business } });
  if (o.dept) conds.push({ equals: { key: "dept", value: o.dept } });
  if (o.section) conds.push({ equals: { key: "section", value: o.section } });
  // 하위 포함: 같은 경로 또는 "경로/"로 시작 (OpenSearch Serverless KB는 startsWith 지원). 현재 분류로 다시 거른다(revalidate)
  if (o.category && o.kbCategory !== false) conds.push({ orAll: [{ equals: { key: "category_path", value: o.category } }, { startsWith: { key: "category_path", value: `${o.category}/` } }] });
  if (o.authority) conds.push({ equals: { key: "authority_status", value: o.authority } }); // KB에서 먼저 거르고 현재 상태로 다시 확인 (상위 N건 밖 누락 방지)
  if (o.dateFrom) conds.push({ greaterThanOrEquals: { key: "doc_date", value: o.dateFrom } });
  if (o.dateTo) conds.push({ lessThanOrEquals: { key: "doc_date", value: o.dateTo } });
  if (o.tags?.length) conds.push(o.tags.length === 1 ? { listContains: { key: "tags", value: o.tags[0]! } } : { orAll: o.tags.map((t) => ({ listContains: { key: "tags", value: t } })) });
  return { andAll: conds };
}

// ── KB Retrieve ────────────────────────────────────────
/** weak: 재정렬 1위가 근거 기준(RERANK_TOP1_MIN) 미만이지만 RELATED_MIN 이상 — 근거로 쓰지 않고 "관련 가능 문서"로만 보여 준다 */
export interface Hit { text: string; score: number; metadata: Record<string, unknown>; weak?: boolean; matched_query?: string }
/** filter 없음 = 운영자 시점 원시 조회 (측정 전용, Tool은 항상 필터를 넣는다) */
export interface Retriever {
  retrieve(query: string, filter?: RetrievalFilter): Promise<Hit[]>;
  /** 재정렬·관련도 게이트 없이 필터 안 조각을 가져온다 (장 펼치기: 같은 장 조각은 관련도와 상관없이 모두 필요) */
  retrieveRaw?(query: string, filter: RetrievalFilter): Promise<Hit[]>;
}

// ponytail: 후보 50 → Rerank 15 → 최종 5 고정 기본값 (docs/01 8.5). 실험 후 조정
export const CANDIDATES = 50;
export const RERANKED = 15;
/** Rerank 관련도 판정 (절대 하한 하나는 데이터가 바뀌면 흔들림 → 1위 점수 게이트 + 1위 대비 비율, dhxorb96 QA 11/17).
 *  ① 1위가 RERANK_TOP1_MIN 미만이면 근거 없음 → UNVERIFIED. ② 아니면 1위의 RERANK_RATIO 이상만 함께 반환.
 *  보정(공유 dev, Rerank 3.5): 11/16 한빛 KB 관련 top1 최저 0.396·무관 최고 0.147 / 11/17 하나은행 KB 관련 23건 최저 0.361·무관 10건 최고 0.248 → 게이트 0.30.
 *  비율 0.4: "개인정보 수집"(규정에 수집 조문 없음)에서 1위 0.536일 때 정의 조문 0.233은 남기고 0.12대 잡음은 뺀다.
 *  ponytail: 고정값. 문서가 늘면 같은 보정(무관·관련 질문 top1 분포)으로 다시 잰다. HYBRID 대체 중에는 점수 체계가 달라 미적용 */
export const RERANK_TOP1_MIN = 0.30;
export const RERANK_RATIO = 0.4;
/** 관련 가능 문서 하한 (11/17 실측: "개인정보 수집" 같은 짧은 자연어 질의는 관련 조문이어도 1위 0.13~0.26, 무관 질의는 0.017~0.094.
 *  0.30 미만은 근거로 단정하지 않되 버리지도 않고 related로 보여 준다). ponytail: 고정값, 평가 세트 늘면 재보정 */
export const RELATED_MIN = 0.10;

export class BedrockRetriever implements Retriever {
  private readonly c: BedrockAgentRuntimeClient;
  private readonly kbId: string;
  private readonly rerankArn: string | undefined;
  /** rerankModel: SSM MODEL_RERANK 값(모델 ID, 예 cohere.rerank-v3-5:0) 또는 ARN. 실 KB에서 이 설정 형식 동작 확인함 (11/16) */
  constructor(kbId: string, rerankModel?: string, c = new BedrockAgentRuntimeClient({})) {
    this.kbId = kbId;
    this.rerankArn = rerankModel && !rerankModel.startsWith("arn:") ? `arn:aws:bedrock:${process.env["AWS_REGION"] ?? "us-east-1"}::foundation-model/${rerankModel}` : rerankModel;
    this.c = c;
  }
  async retrieveRaw(text: string, filter: RetrievalFilter): Promise<Hit[]> { return this.query(text, filter); }
  async retrieve(text: string, filter?: RetrievalFilter): Promise<Hit[]> {
    try {
      return await this.query(text, filter, this.rerankArn);
    } catch (e) {
      // 재정렬 모델 접근 거부(Marketplace 계약 대기 등)면 HYBRID 결과로 대체. 질의 원문은 로그에 남기지 않는다
      // ponytail: 접근 거부가 풀릴 때까지 매 호출 1회씩 실패 후 재시도. 지속되면 실패 캐시
      if (!this.rerankArn || !isRerankAccessError(e)) throw e;
      console.warn(JSON.stringify({ msg: "rerank 불가 → HYBRID 대체", error: (e as Error).name }));
      return this.query(text, filter);
    }
  }
  private async query(text: string, filter?: RetrievalFilter, rerankArn?: string): Promise<Hit[]> {
    const r = await this.c.send(new RetrieveCommand({
      knowledgeBaseId: this.kbId,
      retrievalQuery: { text },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: CANDIDATES, overrideSearchType: "HYBRID", ...(filter ? { filter } : {}),
          ...(rerankArn ? { rerankingConfiguration: { type: "BEDROCK_RERANKING_MODEL", bedrockRerankingConfiguration: { numberOfRerankedResults: RERANKED, modelConfiguration: { modelArn: rerankArn } } } } : {}),
        },
      },
    }));
    const hits = (r.retrievalResults ?? []).map((x) => ({ text: x.content?.text ?? "", score: x.score ?? 0, metadata: (x.metadata ?? {}) as Record<string, unknown> }));
    if (!rerankArn) return hits;
    const top = Math.max(0, ...hits.map((h) => h.score));
    if (top < RELATED_MIN) return [];
    // 근거 미달(weak)이면 조각마다 RELATED_MIN 하한도 (1위 대비 비율로 남은 0.1 미만 잡음 숨김, 사용자 지적 11/18). Rerank 점수에만 적용
    const kept = hits.filter((h) => h.score >= Math.max(top * RERANK_RATIO, top < RERANK_TOP1_MIN ? RELATED_MIN : 0));
    return top < RERANK_TOP1_MIN ? kept.map((h) => ({ ...h, weak: true })) : kept;
  }
}

/** 재정렬 모델 접근 거부 (실측 11/16: ValidationException "Model access is denied ... aws-marketplace") */
export const isRerankAccessError = (e: unknown) =>
  ["ValidationException", "AccessDeniedException"].includes((e as Error).name) && /model access|marketplace/iu.test((e as Error).message);

// ── 현재 상태 재검증 ───────────────────────────────────
export interface DocState {
  doc_id: string; lifecycle: Lifecycle; authority_status: AuthorityStatus; conditional?: boolean; freshness: Freshness; acl_groups: string[];
  published_content_hash: string; // Promote가 기록한 게시본 해시 (Documents.content_hash는 원본 해시라 다름)
  effective_from?: number; effective_to?: number; // 현재 유효기간 (새 버전 시행 시 갱신). KB 메타데이터보다 우선
  version?: number;
  document_type?: string; // 게시본 위치(legal/·knowledge/)를 정하는 데만 씀
}
/** 게시본 읽기 (published 버킷 content.txt + .metadata.json). 문서 전체 조회(get_wiki_document)용 */
export interface PublishedReader { get(doc_id: string, document_type?: string): Promise<{ content: string; meta: Record<string, unknown> } | undefined> }
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export interface DocStates {
  get(docIds: string[]): Promise<Map<string, DocState>>;
  /** 현재 분류 경로 (분류 필터를 쓸 때만, PostgreSQL). 재분류·병합 뒤 KB 메타데이터가 낡아도 현재 분류로 거르기 위해 */
  categoryPaths?(docIds: string[]): Promise<Map<string, string>>;
  /** 현재 그 분류(하위 포함)에 속한 게시 문서 doc_id. 재분류된 문서도 찾도록 KB를 doc_id로 거른다 (PR #32 리뷰) */
  categoryDocIds?(category: string): Promise<string[]>;
}
/** 경로가 분류(하위 포함) 안인지 */
export const inCategory = (path: string | undefined, cat: string) => !!path && (path === cat || path.startsWith(`${cat}/`));

/** 검색 결과 항목. 앞 8개 필드는 dhxorb96 가이드 Agent Evidence 계약 (agents/src/guide.ts) */
export interface Result {
  doc_id: string; title: string;
  snippet: string; // 인용 원문 (문맥 헤더 없음)
  provision?: string; // 사람이 읽는 조문 표기 "하나은행 기업여신 심사규정 제12조제1항" (규정만)
  effective_from: string; // YYYY-MM-DD
  authority_status: AuthorityStatus; freshness: Freshness;
  search_status: "FOUND" | "HISTORICAL" | "DELETED";
  /** 근거 기준 미달, 참고용 (related에만 들어감) */
  weak?: boolean;
  /** 이 결과의 점수를 낸 질의 (재구성 질의 중 하나). 화면 "이 검색어로 찾았습니다"·평가 재현용 */
  matched_query?: string;
  // 추가 정보
  document_type: string; provision_id: string; path_label: string; provision_status: string;
  conditional: boolean; effective_to: string; score: number;
  business_path: string[]; tags: string[];
  /** 업무 분류 경로 (색인 시점) */
  category_path?: string;
  /** 근거 조각이 있는 쪽 (1부터). 화면 쪽 썸네일용 */
  page?: number;
  /** 장(章)과 그 쪽 범위 "시작-끝" (매뉴얼·노하우) */
  section?: string; section_pages?: string;
  /** "FIGURE" = 그림 기준(AI 정리) 근거. 인용 가능하되 그렇게 표시해야 함 */
  evidence_kind?: "FIGURE";
  /** 같은 쪽 그림 제목 (OCR로 확인된 것만, AI 정리 기준). 인용 원문 아님 */
  page_context?: string;
  quotable: boolean; // false = 그림 설명·그림 속 글자 등 원문이 아닌 결과. 근거 인용 금지 (매뉴얼·노하우의 그림 기준 근거는 true + evidence_kind FIGURE)
  historical: boolean; // 기준일에 유효하지 않음(삭제·과거) — include_history 결과에서만 true 가능
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const isoDate = isoOfYmd;

/** 유효기간 판정: DynamoDB 현재 상태가 있으면 그것을, 없으면 KB 메타데이터를 쓴다. 기간 정보 없이 SUPERSEDED면 현행 아님 */
const current = (st: DocState, m: Record<string, unknown>, asOf: number) => {
  const from = st.effective_from ?? Number(m["effective_from"]);
  const to = st.effective_to ?? Number(m["effective_to"]);
  if (st.effective_to === undefined && st.freshness === "SUPERSEDED") return false;
  return from <= asOf && asOf <= to;
};

export function revalidate(hits: Hit[], states: Map<string, DocState>, actor: Actor, o: FilterOpts): { kept: Result[]; dropped: number } {
  const keys = aclKeys(actor);
  const kept: Result[] = [];
  for (const h of hits) {
    const m = h.metadata;
    const st = states.get(String(m["doc_id"]));
    const ok = st
      && st.lifecycle === "PUBLISHED"
      && st.authority_status !== "REJECTED"
      && st.acl_groups.some((g) => keys.includes(g))
      && st.published_content_hash === m["content_hash"] // KB 동기화 지연으로 남은 옛 버전 청크 차단
      && (!o.authority || st.authority_status === o.authority) && (!o.freshness || st.freshness === o.freshness) // 승인 후 바뀌는 값이라 KB가 아니라 현재 상태로
      && (o.includeHistory || (current(st, m, o.asOf) && m["provision_status"] !== "DELETED"));
    if (!ok) continue;
    const hist = m["provision_status"] === "DELETED" || !current(st, m, o.asOf);
    const isReg = m["document_type"] === "REGULATION";
    // 그림 기준 근거는 매뉴얼·노하우에서만, 원문(정리본)이 있을 때만 (색인 쪽 제외가 어긋나도 규정 근거로 새지 않게, PR #42 리뷰)
    const fig = m["evidence_kind"] === "FIGURE" && !isReg && String(m["original_text"] ?? "").trim() !== "";
    const pathLabel = String(m["provision_path"] ?? "");
    kept.push({
      doc_id: st.doc_id, title: String(m["title"] ?? ""),
      // 인용은 원문만 (보강 헤더 인용 금지). 그림 기준 근거(매뉴얼·노하우 쪽 정리본)는 인용 가능하되 머리표로 구분
      snippet: fig ? `[그림 기준 · AI 정리] ${String(m["original_text"])}`
        : m["has_figure"] === true ? `[그림 설명 · 원문 아님] ${h.text.replace(/^\[[^\]]*\]\n/u, "")}` : String(m["original_text"] ?? h.text),
      quotable: m["has_figure"] !== true || fig,
      ...(fig ? { evidence_kind: "FIGURE" as const } : {}),
      ...(typeof m["page_context"] === "string" && m["page_context"] ? { page_context: m["page_context"] } : {}),
      ...(typeof m["section"] === "string" && m["section"] ? { section: m["section"], ...(typeof m["section_pages"] === "string" ? { section_pages: m["section_pages"] } : {}) } : {}),
      ...(isReg && pathLabel ? { provision: `${String(m["law_name"] ?? m["title"] ?? "")} ${pathLabel}`.trim() } : {}),
      effective_from: isoDate(st.effective_from ?? Number(m["effective_from"])),
      authority_status: st.authority_status, freshness: st.freshness,
      search_status: m["provision_status"] === "DELETED" ? "DELETED" : hist ? "HISTORICAL" : "FOUND",
      document_type: String(m["document_type"]), provision_id: String(m["provision_id"] ?? ""), path_label: pathLabel,
      provision_status: String(m["provision_status"] ?? "ACTIVE"), conditional: !!st.conditional,
      effective_to: isoDate(st.effective_to ?? Number(m["effective_to"])), score: h.score, historical: hist,
      business_path: strs(m["business_path"]), tags: strs(m["tags"]), ...(typeof m["category_path"] === "string" ? { category_path: m["category_path"] } : {}),
      ...(typeof m["source_page"] === "number" && Number.isInteger(m["source_page"]) && m["source_page"] >= 0 ? { page: m["source_page"] + 1 } : {}), ...(h.weak ? { weak: true } : {}), ...(h.matched_query ? { matched_query: h.matched_query } : {}),
    });
  }
  return { kept, dropped: hits.length - kept.length };
}

// ── Tool ───────────────────────────────────────────────
const groupsArg = (args: Record<string, unknown>): IndexGroup[] | undefined => {
  const v = args["index_groups"];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((g) => !IndexGroup.safeParse(g).success)) throw new ToolError("INVALID_ARGUMENT", "index_groups");
  return v as IndexGroup[];
};
/** 업무 분류·태그 필터 인자 (문서보관함·검색 화면) */
const classArgs = (args: Record<string, unknown>) => {
  const business = str(args, "business", false);
  const tags = Array.isArray(args["tags"]) ? (args["tags"] as unknown[]).filter((t): t is string => typeof t === "string" && !!t.trim()).slice(0, 8) : [];
  const day = (k: string) => { const v = str(args, k, false); if (!v) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new ToolError("INVALID_ARGUMENT", `${k}: YYYY-MM-DD`);
    return Number(v.replaceAll("-", "")); };
  const pick = <T extends string>(k: string, ok: readonly T[]) => { const v = str(args, k, false); if (!v) return undefined; if (!ok.includes(v as T)) throw new ToolError("INVALID_ARGUMENT", `${k}: ${ok.join("|")}`); return v as T; };
  const dept = str(args, "dept", false), dateFrom = day("date_from"), dateTo = day("date_to");
  // 분류 경로 정규화 ("여신 / 기업여신/" → "여신/기업여신"). 지정했는데 비거나 문자열이 아니면 거부 (전체 검색으로 새지 않게)
  const rawCat = args["category"];
  if (rawCat !== undefined && typeof rawCat !== "string") throw new ToolError("INVALID_ARGUMENT", "category: 문자열");
  const category = typeof rawCat === "string" ? rawCat.split("/").map((x) => x.trim()).filter(Boolean).join("/") : undefined;
  if (rawCat !== undefined && !category) throw new ToolError("INVALID_ARGUMENT", "category: 비어 있음");
  if (category && category.length > 200) throw new ToolError("INVALID_ARGUMENT", "category: 200자 이하");
  if (dateFrom && dateTo && dateFrom > dateTo) throw new ToolError("INVALID_ARGUMENT", "date_from이 date_to보다 늦음");
  const authority = pick("authority_status", ["VERIFIED", "UNVERIFIED"] as const), freshness = pick("freshness", ["CURRENT", "REVIEW_REQUIRED"] as const);
  const expand = pick("expand", ["section"] as const);
  return { ...(expand ? { expand } : {}), ...(category ? { category } : {}), ...(business ? { business } : {}), ...(tags.length ? { tags } : {}), ...(dept ? { dept } : {}), ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}),
    ...(authority ? { authority } : {}), ...(freshness ? { freshness } : {}) };
};
const topK = (args: Record<string, unknown>) => Math.min(Math.max(Number(args["top_k"] ?? 5) || 5, 1), RERANKED);
const CLAUSE_IN_QUERY = /(?:「([^」]+)」|([가-힣A-Za-z0-9·\s]+?))\s*((?:부칙\s*)?제\s*\d+\s*조(?:\s*의\s*\d+)?(?:\s*제\s*\d+\s*항)?(?:\s*제\s*\d+\s*호(?:\s*의\s*\d+)?)?(?:\s*[가-하]\s*목)?)/u;

/** 재구성 질의 각각으로 검색(각자 Rerank) → 같은 청크는 최고 점수 하나만, 점수를 낸 질의를 남긴다.
 *  core만으로 Rerank하지 않는 이유 (11/17 dev 실측): "개인정보 처리방법" 0.284 탈락, 같은 뜻 "개인정보 처리" 0.486·"처리 기준" 0.498 통과.
 *  안전장치 (PR #24 리뷰): ① primary는 사람이 쓴 질의(원문·규칙 정리본)만. 모델 질의(core·alternates)에서 나온 결과는
 *  primary 결과(weak 포함)에 같은 문서가 있을 때만 근거, 아니면 weak(참고) — 모델이 주제를 바꿔도 새 문서를 근거로 끌어오지 못한다
 *  ② 합친 뒤 1위 대비 RERANK_RATIO를 다시 적용 ③ 일부 질의 실패는 건너뛰고(로그) 전부 실패할 때만 오류.
 *  ponytail: Rerank 호출이 질의당 최대 5회(중복 제거 후). 비용·쿼터가 문제면 alternates를 1개로 */
export async function retrieveMany(r: Retriever, primary: string[], model: string[], filter: RetrievalFilter): Promise<Hit[]> {
  const qs = [...new Set([...primary, ...model])];
  const settled = await Promise.allSettled(qs.map(async (q) => (await r.retrieve(q, filter)).map((h) => ({ ...h, matched_query: q }))));
  const ok = settled.flatMap((x, i) => {
    if (x.status === "fulfilled") return [{ q: qs[i]!, hits: x.value }];
    console.warn(JSON.stringify({ msg: "재구성 질의 1건 검색 실패 → 건너뜀", error: (x.reason as Error)?.name })); // 질의 원문은 남기지 않는다
    return [];
  });
  if (!ok.length) throw (settled[0] as PromiseRejectedResult).reason;
  const isPrimary = (q: string) => primary.includes(q);
  const primaryDocs = new Set(ok.filter((x) => isPrimary(x.q)).flatMap((x) => x.hits.map((h) => String(h.metadata["doc_id"]))));
  const best = new Map<string, Hit>();
  for (const x of ok) for (const h0 of x.hits) {
    const h = isPrimary(x.q) || primaryDocs.has(String(h0.metadata["doc_id"])) ? h0 : { ...h0, weak: true };
    const key = `${String(h.metadata["doc_id"])}\u0000${String(h.metadata["provision_id"] ?? "")}\u0000${h.text}`;
    const prev = best.get(key);
    // 근거 기준을 넘은 결과가 weak보다 우선, 같으면 점수
    if (!prev || (prev.weak && !h.weak) || (!!prev.weak === !!h.weak && h.score > prev.score)) best.set(key, h);
  }
  const all = [...best.values()];
  const top = Math.max(0, ...all.filter((h) => !h.weak).map((h) => h.score));
  return all.filter((h) => h.weak || h.score >= top * RERANK_RATIO).sort((a, b) => Number(!!a.weak) - Number(!!b.weak) || b.score - a.score);
}

export function searchTools(deps: { retriever: Retriever; states: DocStates; regulation: ReturnType<typeof regulationTools>; rewriter?: Rewriter; published?: PublishedReader }) {
  // ponytail: 분류 문서가 이보다 많으면 doc_id 대신 색인 시점 경로로 KB를 거른다 (재분류 문서는 다시 게시해야 잡힘)
  const CATEGORY_DOC_IDS_MAX = 200;
  /** 걸린 조각의 장(최대 2개)마다 같은 장 조각을 현재 상태로 다시 검증해 쪽 순서로 (장당 8조각).
   *  ponytail: 장 2개·8조각 고정. 장이 길면 앞 8조각만 → 필요하면 가이드가 page로 다시 찾음 */
  async function expandSections(top: Result[], query: string, actor: Actor, o: FilterOpts) {
    if (!deps.retriever.retrieveRaw) return [];
    const keys = [...new Map(top.filter((r) => r.section).map((r) => [`${r.doc_id}\u0000${r.section}`, r] as const)).values()].slice(0, 2);
    // 장 2개를 동시에 (PR #43 리뷰: 순차 호출 지연)
    const out = await Promise.all(keys.map(async (r) => {
      const [hits, states] = await Promise.all([
        deps.retriever.retrieveRaw!(query, buildFilter(actor, { ...o, docIds: [r.doc_id], section: r.section!, expand: undefined, kbCategory: false })),
        deps.states.get([r.doc_id])]);
      // 인용 불가 그림 설명은 빼고(장 자리를 차지하지 않게), 쪽·조각 번호 순 (#s10이 #s2 뒤로)
      const items = [...new Map(revalidate(hits, states, actor, o).kept.filter((x) => x.quotable).map((x) => [x.provision_id, x] as const)).values()]
        .sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.provision_id.localeCompare(b.provision_id, undefined, { numeric: true })).slice(0, 8)
        .map((x) => { const y = { ...x }; delete y.weak; return y; }); // 같은 장 조각은 관련도와 무관 (weak 표시 없음)
      return { doc_id: r.doc_id, section: r.section!, ...(r.section_pages ? { section_pages: r.section_pages } : {}), items };
    }));
    return out.filter((x) => x.items.length);
  }

  async function run(query: string, actor: Actor, o0: FilterOpts, k: number, rewrite = false) {
    const q = maskPii(query);
    let o = o0;
    if (o.category && deps.states.categoryDocIds) {
      const ids = await deps.states.categoryDocIds(o.category);
      if (!ids.length) return { search_status: "UNVERIFIED" as SearchStatus, items: [] as Result[], related: undefined as Result[] | undefined, dropped_after_revalidation: 0, pii_masked: q.masked };
      if (ids.length <= CATEGORY_DOC_IDS_MAX) o = { ...o, docIds: o.docIds ? o.docIds.filter((d) => ids.includes(d)) : ids, kbCategory: false };
    }
    // 재구성: 규칙(항상) + 모델(있으면). rewrite=false("원래 질의로 찾기")면 원문 그대로
    const rw: Rewritten | undefined = !rewrite ? undefined : deps.rewriter ? await deps.rewriter.rewrite(q.text) : { core: cleanQuery(q.text), alternates: [] };
    // primary = 원문(정리가 틀려도 원문보다 나빠지지 않게) + 규칙 정리본(11/17 실측: 모델이 "개인정보 관련 문서"를 core로 남겨 0.249, 정리본 "개인정보"는 0.630)
    const hits = rw
      ? await retrieveMany(deps.retriever, [q.text, cleanQuery(q.text)], [rw.core, ...rw.alternates], buildFilter(actor, o))
      : await deps.retriever.retrieve(q.text, buildFilter(actor, o));
    const states = await deps.states.get([...new Set(hits.map((h) => String(h.metadata["doc_id"])))]);
    const rv = revalidate(hits, states, actor, o);
    let { kept, dropped } = rv;
    if (o.category && deps.states.categoryPaths) {
      const cur = await deps.states.categoryPaths([...new Set(kept.map((r) => r.doc_id))]);
      const before = kept.length;
      kept = kept.filter((r) => inCategory(cur.get(r.doc_id), o.category!)).map((r) => ({ ...r, category_path: cur.get(r.doc_id)! }));
      dropped += before - kept.length;
    }
    // 검색 결과 0건은 "없음"이 아니라 "확인 불가" (docs/01 8.7). 근거 기준 미달(weak)은 UNVERIFIED + related(참고)로만
    const top = kept.filter((r) => !r.weak).slice(0, k);
    // 관련 가능 문서는 질의 핵심어가 조각(제목·본문·분류)에 하나라도 있고, 인용 가능한 조각일 때만 (그림 설명만으로는 만들지 않음).
    // 점수 하한을 올리지 않는 이유: 11/17 실측 관련 질의 1위 0.13~0.26 → 0.20이면 진짜 관련 문서도 숨음 (yoyo0704 실측 11/18, 과천 그림 설명이 "개인정보"에 걸림)
    const terms = queryTerms(`${rw?.core ?? ""} ${rw?.alternates.join(" ") ?? ""} ${cleanQuery(q.text)}`);
    const related = kept.filter((r) => r.weak && r.quotable && hasTerm(`${r.title} ${r.snippet} ${r.category_path ?? ""} ${r.path_label}`, terms)).slice(0, k);
    const search_status: SearchStatus = !top.length ? "UNVERIFIED" : top.every((r) => r.historical) ? "HISTORICAL" : "FOUND";
    const expanded = o.expand === "section" ? await expandSections(top, q.text, actor, o) : [];
    return { search_status, items: top, ...(related.length ? { related } : {}), ...(expanded.length ? { expanded } : {}), ...(rw ? { rewritten: rw } : {}), dropped_after_revalidation: dropped, pii_masked: q.masked };
  }

  return {
    async search_wiki(args: Record<string, unknown>, actor: Actor) {
      return run(str(args, "query"), actor, { asOf: asOfYmd(args), indexGroups: groupsArg(args), includeHistory: args["include_history"] === true, ...classArgs(args) }, topK(args), args["rewrite"] !== false);
    },

    /** 문서 전체를 쪽별로 (외부 MCP 클라이언트·문서 생성 앱용, interfaces 11장). 게시본(마스킹)에서만 읽어 지금 게시된 버전과 항상 같다.
     *  없음·권한 없음·게시 아님은 모두 NOT_FOUND (존재 여부를 흘리지 않음) */
    async get_wiki_document(args: Record<string, unknown>, actor: Actor) {
      const doc_id = str(args, "doc_id");
      if (!/^doc_[0-9A-HJKMNP-TV-Z]{26}$/u.test(doc_id)) throw new ToolError("INVALID_ARGUMENT", "doc_id 형식: doc_{ULID}");
      const notFound = () => new ToolError("NOT_FOUND", "문서가 없거나 볼 권한이 없습니다");
      const st = (await deps.states.get([doc_id])).get(doc_id);
      const keys = aclKeys(actor);
      if (!st || st.lifecycle !== "PUBLISHED" || st.authority_status === "REJECTED" || !st.acl_groups.some((g) => keys.includes(g))) throw notFound();
      const pub = await deps.published?.get(doc_id, st.document_type);
      // 본문 자체의 해시로 확인 (사이드카보다 본문이 먼저 써지는 게시 도중에도 버전이 섞이지 않게, PR #45 리뷰)
      if (!pub || sha256(pub.content) !== st.published_content_hash) throw notFound();
      // 폐지·시행 전·대체된 문서는 검색과 같이 기본 제외 (include_history면 historical 표시로)
      const asOf = asOfYmd(args), now = current(st, pub.meta, asOf);
      if (!now && args["include_history"] !== true) throw notFound();
      const from = st.effective_from ?? Number(pub.meta["effective_from"]), to = st.effective_to ?? Number(pub.meta["effective_to"]);
      const fromPage = Math.max(1, Math.floor(Number(args["from_page"] ?? 1)) || 1);
      return { doc_id, title: pub.meta["title"], document_type: pub.meta["document_type"], ...(st.version ? { version: st.version } : {}),
        ...(pub.meta["category_path"] ? { category_path: pub.meta["category_path"] } : {}), authority_status: st.authority_status, freshness: st.freshness,
        effective_from: isoDate(from), effective_to: isoDate(to), conditional: st.conditional === true, ...(now ? {} : { historical: true }),
        ...docPages(pub.content, fromPage) };
    },

    async retrieve_evidence(args: Record<string, unknown>, actor: Actor) {
      const docIds = args["doc_ids"];
      if (!Array.isArray(docIds) || !docIds.length || docIds.some((d) => typeof d !== "string")) throw new ToolError("INVALID_ARGUMENT", "doc_ids 필요");
      return run(str(args, "query"), actor, { asOf: asOfYmd(args), docIds: docIds as string[], includeHistory: args["include_history"] === true }, topK(args));
    },

    /** 조문 번호가 있으면 Exact Lookup 먼저, 확인되면 KB 검색 생략 (docs/01 8.7 복구 흐름) */
    async search_legal_clause(args: Record<string, unknown>, actor: Actor) {
      const query = str(args, "query");
      const m = query.match(CLAUSE_IN_QUERY);
      const law = str(args, "law", false) || (m ? (m[1] ?? m[2] ?? "").trim() : "");
      if (m && law) {
        const exact = await deps.regulation.get_clause({ law, clause: m[3]!, as_of: args["as_of"] }, actor);
        if (exact.search_status !== "UNVERIFIED") return { via: "exact_lookup", ...exact };
        // 지정한 조문을 확인하지 못함: 상태는 UNVERIFIED 그대로. 의미 검색 결과는 근거가 아닌 참고(related)로만 붙인다
        // (다른 조문을 FOUND로 내면 "그 조문이 있다"로 오해됨)
        const r = await run(query, actor, { asOf: asOfYmd(args), indexGroups: ["legal-clauses"], includeHistory: args["include_history"] === true }, topK(args));
        return { via: "exact_lookup", ...exact, related: r.items };
      }
      const r = await run(query, actor, { asOf: asOfYmd(args), indexGroups: ["legal-clauses"], includeHistory: args["include_history"] === true }, topK(args));
      return { via: "kb_hybrid", ...r };
    },
  };
}

// ponytail: 응답 상한 글자 수 (외부 챗봇 문맥 고려 ~2만 토큰). 넘으면 next_page로 이어 받기
const DOC_CHARS_MAX = 40_000;
const SUMMARY_LINE = /^⟦그림 p(\d+)⟧ 쪽 정리\(AI, 그림 기준\)(?: \(이어서 \d+\))?: (.*)$/u;
/** 게시본 → 쪽별 본문. 본문(OCR, 표는 마크다운)이 있으면 TEXT, 글자가 거의 없는 화면 캡처 쪽은 AI 그림 정리본(VISION).
 *  그림 속 글자·그림 설명·쪽 맥락 줄(⟦그림 …⟧)은 원문이 아니라 내보내지 않는다 (정리본만 ai_summary로) */
export function docPages(content: string, fromPage = 1) {
  const lines = content.split("\n");
  const summary = new Map<number, string>();
  const body: string[] = [];
  for (const l of lines) {
    const m = SUMMARY_LINE.exec(l);
    if (m) summary.set(Number(m[1]), [summary.get(Number(m[1])), m[2]].filter(Boolean).join(" "));
    else if (!l.startsWith("⟦그림 p")) body.push(l);
  }
  const texts = body.join("\n").split(/\n?\f\n?/u);
  let used = 0, next: number | undefined;
  const pages: { page: number; markdown: string; source: "TEXT" | "VISION"; ai_summary?: string; cut?: true }[] = [];
  for (const [i, t0] of texts.entries()) {
    if (i + 1 < fromPage) continue;
    const t = t0.trim(), ai = summary.get(i);
    const thin = t.replace(/\[그림 \d+\]/gu, "").replace(/\s+/gu, "").length < 10; // ponytail: 10자 미만이면 캡처 쪽으로 봄
    const p = thin && ai ? { page: i + 1, markdown: ai, source: "VISION" as const } : { page: i + 1, markdown: t, source: "TEXT" as const, ...(ai ? { ai_summary: ai } : {}) };
    const size = p.markdown.length + (("ai_summary" in p && p.ai_summary) ? p.ai_summary.length : 0);
    if (used + size > DOC_CHARS_MAX) {
      // 한 쪽만으로 상한을 넘으면 그 쪽을 잘라서라도 넣음 (빈 응답 방지)
      if (!pages.length) pages.push({ ...p, markdown: p.markdown.slice(0, DOC_CHARS_MAX), cut: true });
      next = (pages.at(-1)?.page ?? i) + 1;
      break;
    }
    used += size; pages.push(p);
  }
  return { page_count: texts.length, pages, ...(next && next <= texts.length ? { next_page: next } : {}) };
}

/** 질의 핵심어 (요청 어미·군더더기 제외, 2자 이상). 관련 가능 문서 거르기용 */
const STOP_TERMS = new Set(["관련", "관련된", "문서", "문서들", "문서를", "자료", "자료를", "내용을", "규정", "내용", "방법", "어떻게", "무엇", "찾아줘", "알려줘", "있는", "대한", "대해"]);
// 가림 표시([개인정보]·[전화번호] 등)는 질의·조각 양쪽에서 빼고 비교 (가린 문서가 "개인정보"에 걸리지 않게, PR #46 리뷰)
// 가림 표시 이름만 (@hanaeum/pii PII_NAME + [개인정보]). "[개인정보 보호법]" 같은 대괄호 법령명은 지우지 않음
// 지금 가리지 않는 종류(전화번호·이메일·IP 주소)도 이미 게시된 문서에 남아 있어 함께 (dhxorb96 pii 변경 11/18)
const MASK_MARK = new RegExp(`\\[(?:개인정보|전화번호|이메일|IP 주소|${Object.values(PII_NAME).join("|")})\\]`, "gu");
const PARTICLE = /(에서|으로|에게|까지|부터|이나|과|와|을|를|이|가|은|는|에|의|도|로)$/u;
export const queryTerms = (q: string) => [...new Set(q.replace(MASK_MARK, " ").toLowerCase().split(/[^0-9a-z가-힣]+/u)
  .map((w) => (w.length >= 3 ? w.replace(PARTICLE, "") : w)).filter((w) => w.length >= 2 && !STOP_TERMS.has(w)))];
/** 핵심어가 하나라도 있으면 (공백·대소문자 무시). 핵심어가 없으면 거르지 않음 */
export const hasTerm = (hay: string, terms: string[]) => {
  const h = hay.replace(MASK_MARK, " ").toLowerCase().replace(/\s+/gu, "");
  return !terms.length || terms.some((t) => h.includes(t));
};
