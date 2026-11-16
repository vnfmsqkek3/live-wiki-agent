// Search MCP: search_wiki, retrieve_evidence, search_legal_clause (docs/04 4.3, docs/01 8.6·8.7)
// 하드 게이트(ACL·공식성·유효기간)는 Rerank 전에 서버가 필터로 강제하고, 결과는 DynamoDB 현재 상태로 다시 검증한다.
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import type { RetrievalFilter } from "@aws-sdk/client-bedrock-agent-runtime";
import type { AuthorityStatus, Freshness, IndexGroup, Lifecycle, SearchStatus } from "@hanaeum/schemas";
import { ToolError, aclKeys, asOfYmd, maskPii, str } from "@hanaeum/mcp-kit";
import type { Actor } from "@hanaeum/mcp-kit";
import type { regulationTools } from "@hanaeum/regulation-server";

// ── 필터 ───────────────────────────────────────────────
export interface FilterOpts { asOf: number; indexGroups?: IndexGroup[]; includeHistory?: boolean; docIds?: string[] }

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
  return { andAll: conds };
}

// ── KB Retrieve ────────────────────────────────────────
export interface Hit { text: string; score: number; metadata: Record<string, unknown> }
export interface Retriever { retrieve(query: string, filter: RetrievalFilter): Promise<Hit[]> }

// ponytail: 후보 50 → Rerank 15 → 최종 5 고정 기본값 (docs/01 8.5). 실험 후 조정
export const CANDIDATES = 50;
export const RERANKED = 15;

export class BedrockRetriever implements Retriever {
  private readonly c: BedrockAgentRuntimeClient;
  private readonly kbId: string;
  private readonly rerankArn: string | undefined;
  constructor(kbId: string, rerankModelArn?: string, c = new BedrockAgentRuntimeClient({})) { this.kbId = kbId; this.rerankArn = rerankModelArn; this.c = c; }
  async retrieve(text: string, filter: RetrievalFilter): Promise<Hit[]> {
    const r = await this.c.send(new RetrieveCommand({
      knowledgeBaseId: this.kbId,
      retrievalQuery: { text },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: CANDIDATES, overrideSearchType: "HYBRID", filter,
          // [확인 필요] us-east-1 Cohere Rerank 3.5 지원·설정 형식 (docs/04 4.3)
          ...(this.rerankArn ? { rerankingConfiguration: { type: "BEDROCK_RERANKING_MODEL", bedrockRerankingConfiguration: { numberOfRerankedResults: RERANKED, modelConfiguration: { modelArn: this.rerankArn } } } } : {}),
        },
      },
    }));
    return (r.retrievalResults ?? []).map((x) => ({ text: x.content?.text ?? "", score: x.score ?? 0, metadata: (x.metadata ?? {}) as Record<string, unknown> }));
  }
}

// ── 현재 상태 재검증 ───────────────────────────────────
export interface DocState {
  doc_id: string; lifecycle: Lifecycle; authority_status: AuthorityStatus; conditional?: boolean; freshness: Freshness; acl_groups: string[]; content_hash: string;
  effective_from?: number; effective_to?: number; // 현재 유효기간 (새 버전 시행 시 갱신). KB 메타데이터보다 우선
}
export interface DocStates { get(docIds: string[]): Promise<Map<string, DocState>> }

export interface Result {
  doc_id: string; title: string; document_type: string; provision_id: string; path_label: string; provision_status: string;
  original_text: string; authority_status: AuthorityStatus; conditional: boolean; freshness: Freshness;
  effective_from: number; effective_to: number; score: number;
  historical: boolean; // 기준일에 유효하지 않음(삭제·과거) — include_history 결과에서만 true 가능
}

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
      && st.content_hash === m["content_hash"] // KB 동기화 지연으로 남은 옛 버전 청크 차단
      && (o.includeHistory || (current(st, m, o.asOf) && m["provision_status"] !== "DELETED"));
    if (!ok) continue;
    const hist = m["provision_status"] === "DELETED" || !current(st, m, o.asOf);
    kept.push({
      historical: hist,
      doc_id: st.doc_id, title: String(m["title"] ?? ""), document_type: String(m["document_type"]),
      provision_id: String(m["provision_id"] ?? ""), path_label: String(m["provision_path"] ?? ""), provision_status: String(m["provision_status"] ?? "ACTIVE"),
      original_text: String(m["original_text"] ?? h.text), // 인용은 원문만 (보강 헤더 인용 금지)
      authority_status: st.authority_status, conditional: !!st.conditional, freshness: st.freshness,
      effective_from: st.effective_from ?? Number(m["effective_from"]), effective_to: st.effective_to ?? Number(m["effective_to"]), score: h.score,
    });
  }
  return { kept, dropped: hits.length - kept.length };
}

// ── Tool ───────────────────────────────────────────────
const groupsArg = (args: Record<string, unknown>): IndexGroup[] | undefined => {
  const v = args["index_groups"];
  if (v === undefined) return undefined;
  const allowed = ["legal-clauses", "wiki-knowledge", "official-manuals"];
  if (!Array.isArray(v) || v.some((g) => !allowed.includes(g as string))) throw new ToolError("INVALID_ARGUMENT", "index_groups");
  return v as IndexGroup[];
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
    return { search_status, results: top, dropped_after_revalidation: dropped, pii_masked: q.masked };
  }

  return {
    async search_wiki(args: Record<string, unknown>, actor: Actor) {
      return run(str(args, "query"), actor, { asOf: asOfYmd(args), indexGroups: groupsArg(args), includeHistory: args["include_history"] === true }, topK(args));
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
      }
      const r = await run(query, actor, { asOf: asOfYmd(args), indexGroups: ["legal-clauses"], includeHistory: args["include_history"] === true }, topK(args));
      return { via: "kb_hybrid", ...r };
    },
  };
}
