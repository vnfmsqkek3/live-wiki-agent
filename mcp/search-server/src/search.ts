// Search MCP: search_wiki, retrieve_evidence, search_legal_clause (docs/04 4.3, docs/01 8.6·8.7)
// 하드 게이트(ACL·공식성·유효기간)는 Rerank 전에 서버가 필터로 강제하고, 결과는 DynamoDB 현재 상태로 다시 검증한다.
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import type { RetrievalFilter } from "@aws-sdk/client-bedrock-agent-runtime";
import { IndexGroup, isoOfYmd } from "@hanaeum/schemas";
import type { AuthorityStatus, Freshness, Lifecycle, SearchStatus } from "@hanaeum/schemas";
import { ToolError, aclKeys, asOfYmd, maskPii, str } from "@hanaeum/mcp-kit";
import type { Actor } from "@hanaeum/mcp-kit";
import type { regulationTools } from "@hanaeum/regulation-server";

// ── 필터 ───────────────────────────────────────────────
export interface FilterOpts {
  asOf: number; indexGroups?: IndexGroup[]; includeHistory?: boolean; docIds?: string[]; business?: string; tags?: string[];
  /** 세부 필터 (사용자 요청 11/17): 부서, 문서 일자 기간(YYYYMMDD, 본문 대표 일자), 검증 상태·최신성(Documents 현재 상태로 거름) */
  dept?: string; dateFrom?: number; dateTo?: number; authority?: "VERIFIED" | "UNVERIFIED"; freshness?: "CURRENT" | "REVIEW_REQUIRED";
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
  if (o.dateFrom) conds.push({ greaterThanOrEquals: { key: "doc_date", value: o.dateFrom } });
  if (o.dateTo) conds.push({ lessThanOrEquals: { key: "doc_date", value: o.dateTo } });
  if (o.tags?.length) conds.push(o.tags.length === 1 ? { listContains: { key: "tags", value: o.tags[0]! } } : { orAll: o.tags.map((t) => ({ listContains: { key: "tags", value: t } })) });
  return { andAll: conds };
}

// ── KB Retrieve ────────────────────────────────────────
export interface Hit { text: string; score: number; metadata: Record<string, unknown> }
/** filter 없음 = 운영자 시점 원시 조회 (측정 전용, Tool은 항상 필터를 넣는다) */
export interface Retriever { retrieve(query: string, filter?: RetrievalFilter): Promise<Hit[]> }

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
    return top < RERANK_TOP1_MIN ? [] : hits.filter((h) => h.score >= top * RERANK_RATIO);
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
}
export interface DocStates { get(docIds: string[]): Promise<Map<string, DocState>> }

/** 검색 결과 항목. 앞 8개 필드는 dhxorb96 가이드 Agent Evidence 계약 (agents/src/guide.ts) */
export interface Result {
  doc_id: string; title: string;
  snippet: string; // 인용 원문 (문맥 헤더 없음)
  provision?: string; // 사람이 읽는 조문 표기 "하나은행 기업여신 심사규정 제12조제1항" (규정만)
  effective_from: string; // YYYY-MM-DD
  authority_status: AuthorityStatus; freshness: Freshness;
  search_status: "FOUND" | "HISTORICAL" | "DELETED";
  // 추가 정보
  document_type: string; provision_id: string; path_label: string; provision_status: string;
  conditional: boolean; effective_to: string; score: number;
  business_path: string[]; tags: string[];
  quotable: boolean; // false = 그림 묘사 등 원문이 아닌 결과. 근거 인용 금지
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
    const pathLabel = String(m["provision_path"] ?? "");
    kept.push({
      doc_id: st.doc_id, title: String(m["title"] ?? ""),
      snippet: m["has_figure"] === true ? `[그림 설명 · 원문 아님] ${h.text.replace(/^\[[^\]]*\]\n/u, "")}` : String(m["original_text"] ?? h.text), // 인용은 원문만 (보강 헤더 인용 금지)
      quotable: m["has_figure"] !== true,
      ...(isReg && pathLabel ? { provision: `${String(m["law_name"] ?? m["title"] ?? "")} ${pathLabel}`.trim() } : {}),
      effective_from: isoDate(st.effective_from ?? Number(m["effective_from"])),
      authority_status: st.authority_status, freshness: st.freshness,
      search_status: m["provision_status"] === "DELETED" ? "DELETED" : hist ? "HISTORICAL" : "FOUND",
      document_type: String(m["document_type"]), provision_id: String(m["provision_id"] ?? ""), path_label: pathLabel,
      provision_status: String(m["provision_status"] ?? "ACTIVE"), conditional: !!st.conditional,
      effective_to: isoDate(st.effective_to ?? Number(m["effective_to"])), score: h.score, historical: hist,
      business_path: strs(m["business_path"]), tags: strs(m["tags"]),
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
  const day = (k: string) => { const v = str(args, k, false); if (!v) return undefined; if (!/^\d{4}-\d{2}-\d{2}$/u.test(v)) throw new ToolError("INVALID_ARGUMENT", `${k}: YYYY-MM-DD`); return Number(v.replaceAll("-", "")); };
  const pick = <T extends string>(k: string, ok: readonly T[]) => { const v = str(args, k, false); if (!v) return undefined; if (!ok.includes(v as T)) throw new ToolError("INVALID_ARGUMENT", `${k}: ${ok.join("|")}`); return v as T; };
  const dept = str(args, "dept", false), dateFrom = day("date_from"), dateTo = day("date_to");
  const authority = pick("authority_status", ["VERIFIED", "UNVERIFIED"] as const), freshness = pick("freshness", ["CURRENT", "REVIEW_REQUIRED"] as const);
  return { ...(business ? { business } : {}), ...(tags.length ? { tags } : {}), ...(dept ? { dept } : {}), ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}),
    ...(authority ? { authority } : {}), ...(freshness ? { freshness } : {}) };
};
const topK = (args: Record<string, unknown>) => Math.min(Math.max(Number(args["top_k"] ?? 5) || 5, 1), RERANKED);
const CLAUSE_IN_QUERY = /(?:「([^」]+)」|([가-힣A-Za-z0-9·\s]+?))\s*((?:부칙\s*)?제\s*\d+\s*조(?:\s*의\s*\d+)?(?:\s*제\s*\d+\s*항)?(?:\s*제\s*\d+\s*호(?:\s*의\s*\d+)?)?(?:\s*[가-하]\s*목)?)/u;

export function searchTools(deps: { retriever: Retriever; states: DocStates; regulation: ReturnType<typeof regulationTools> }) {
  async function run(query: string, actor: Actor, o: FilterOpts, k: number) {
    const q = maskPii(query);
    const hits = await deps.retriever.retrieve(q.text, buildFilter(actor, o));
    const states = await deps.states.get([...new Set(hits.map((h) => String(h.metadata["doc_id"])))]);
    const { kept, dropped } = revalidate(hits, states, actor, o);
    // 검색 결과 0건은 "없음"이 아니라 "확인 불가" (docs/01 8.7)
    const top = kept.slice(0, k);
    const search_status: SearchStatus = !top.length ? "UNVERIFIED" : top.every((r) => r.historical) ? "HISTORICAL" : "FOUND";
    return { search_status, items: top, dropped_after_revalidation: dropped, pii_masked: q.masked };
  }

  return {
    async search_wiki(args: Record<string, unknown>, actor: Actor) {
      return run(str(args, "query"), actor, { asOf: asOfYmd(args), indexGroups: groupsArg(args), includeHistory: args["include_history"] === true, ...classArgs(args) }, topK(args));
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
