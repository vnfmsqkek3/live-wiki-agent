// Regulation MCP Tool (읽기 전용): get_official_policy, verify_version, get_clause, resolve_reference, compare_versions, fetch_official_law
// 검색 상태 원칙 (docs/01 8.7): 부재는 "확인한 버전·범위"가 있을 때만 NOT_FOUND_VERIFIED. 근거 부족은 UNVERIFIED.
import type { Provision, SearchStatus } from "@hanaeum/schemas";
import { diffLaws } from "@hanaeum/legal-parser";
import { ToolError, aclKeys, asOfYmd, str } from "@hanaeum/mcp-kit";
import type { Actor } from "@hanaeum/mcp-kit";
import { relPath } from "./store.ts";
import { clausePath } from "./clause.ts";
export { clausePath } from "./clause.ts";
import { fetchOfficialLaw } from "./browser.ts";
import type { LawPageFetcher } from "./browser.ts";
import type { ClauseStore, RevisionRecord } from "./store.ts";

const findPath = (provs: Provision[], path: string): Provision | undefined => {
  if (path.startsWith("SUPPLEMENTARY:*/")) {
    // "부칙 제N조"는 부칙이 여러 개면 가장 최근(마지막) 부칙으로 해석
    const n = Math.max(0, ...provs.map((p) => Number(relPath(p.provision_id).match(/^SUPPLEMENTARY:(\d+)/u)?.[1] ?? 0)));
    if (!n) return undefined;
    path = path.replace("SUPPLEMENTARY:*/", `SUPPLEMENTARY:${n}/`);
  }
  const byRel = new Map(provs.map((p) => [relPath(p.provision_id), p]));
  // "제12조제1호"처럼 항이 생략된 표현은 제1항 경로로 보완
  return byRel.get(path) ?? byRel.get(path.replace(/^(.*ARTICLE:[\d-]+)(\/ITEM:.*)$/u, "$1/PARAGRAPH:1$2"));
};

const visible = (r: RevisionRecord, actor: Actor) => r.acl_groups.some((g) => aclKeys(actor).includes(g));
/** 기준일에 시행 중인 VERIFIED 버전. 기간이 겹치면(이전 버전 종료일 미갱신) 가장 최근 시행 버전이 우선 */
const effectiveAt = (revs: RevisionRecord[], ymd: number) =>
  revs.filter((r) => r.authority_status === "VERIFIED" && r.effective_from <= ymd && ymd <= r.effective_to)
    .sort((a, b) => b.effective_from - a.effective_from)[0];
const systemToday = () => Number(new Date().toISOString().slice(0, 10).replaceAll("-", ""));

export interface ClauseResult {
  search_status: SearchStatus;
  reason: string;
  law_id?: string; revision_id?: string; effective_from?: number; effective_to?: number;
  provision_id?: string; path_label?: string; title?: string;
  original_text?: string; deletion_date?: string; children?: { provision_id: string; path_label: string; status: string; original_text: string }[];
  /** 인용한 버전이 기준일 현행이 아닐 때, 같은 위치의 현행 조문 (dhxorb96 노하우 최신성 판정용, 요청 1924) */
  current?: { revision_id: string; effective_from: number; provision_id: string | null; status: "ACTIVE" | "DELETED" | "NOT_FOUND"; original_text: string };
}

async function resolveLaw(store: ClauseStore, args: Record<string, unknown>): Promise<string | undefined> {
  const law = str(args, "law");
  return store.lawIdByName(law);
}

export function regulationTools(store: ClauseStore, opts: { today?: () => number; fetcher?: LawPageFetcher } = {}) {
  const todayYmd = opts.today ?? systemToday;
  /** 버전이 박힌 조문 ID 조회: 그 버전 원문 + (현행이 아니면) 같은 위치 현행 조문 */
  async function getCitedClause(pid: string, asOf: number, actor: Actor): Promise<ClauseResult> {
    const [lawRev] = pid.split("/");
    const [lawId, revId] = lawRev!.split("@") as [string, string];
    const revs = await store.revisions(lawId);
    const rec = revs.find((r) => r.revision_id === revId);
    if (!rec) return { search_status: "UNVERIFIED", reason: `등록되지 않은 버전: ${lawId}@${revId}`, law_id: lawId };
    if (!visible(rec, actor)) return { search_status: "ACCESS_DENIED", reason: "열람 권한 없음", law_id: lawId };
    const path = relPath(pid);
    const provs = await store.provisions(lawId, revId);
    if (!provs) return { search_status: "UNVERIFIED", reason: "조문 구조 데이터 없음", law_id: lawId, revision_id: revId };
    const p = findPath(provs, path);
    const cur = effectiveAt(revs.filter((r) => visible(r, actor)), asOf);
    let current: ClauseResult["current"];
    if (cur && cur.revision_id !== revId) {
      const cp = (await store.provisions(lawId, cur.revision_id)) ?? [];
      const hit = findPath(cp, path);
      current = { revision_id: cur.revision_id, effective_from: cur.effective_from, provision_id: hit?.provision_id ?? null,
        status: !hit ? "NOT_FOUND" : hit.status === "DELETED" ? "DELETED" : "ACTIVE", original_text: hit ? (hit.status === "DELETED" ? hit.original_text : hit.normalized_text) : "" };
    }
    const base = { law_id: lawId, revision_id: revId, effective_from: rec.effective_from, effective_to: rec.effective_to, ...(current ? { current } : {}) };
    if (!p) return { search_status: rec.parse_ok ? "NOT_FOUND_VERIFIED" : "UNVERIFIED", reason: `${lawId}@${revId}에 ${path} 없음`, ...base };
    const isCurrent = cur?.revision_id === revId && rec.effective_to >= todayYmd();
    return {
      search_status: p.status === "DELETED" ? "DELETED" : isCurrent ? "FOUND" : "HISTORICAL",
      reason: p.status === "DELETED" ? `삭제된 조문 (${p.deletion_date})` : isCurrent ? "인용 버전이 현행" : `인용 버전은 현행 아님${current ? ` (현행 ${current.revision_id})` : ""}`,
      ...base, provision_id: p.provision_id, path_label: p.path_label, title: p.title, deletion_date: p.deletion_date,
      original_text: p.status === "DELETED" ? p.original_text : p.normalized_text,
    };
  }

  async function getClause(args: Record<string, unknown>, actor: Actor): Promise<ClauseResult> {
    const asOf = asOfYmd(args);
    const clauseArg = str(args, "clause");
    // 버전이 박힌 조문 ID(노하우 인용 등)는 그 버전 그대로 조회 — law 인자 불필요
    if (/^[A-Z][A-Z0-9-]*@\d{4}-\d{2}-\d{2}\//u.test(clauseArg)) return getCitedClause(clauseArg, asOf, actor);
    const path = clausePath(clauseArg);
    const lawId = await resolveLaw(store, args);
    if (!lawId) return { search_status: "UNVERIFIED", reason: "등록되지 않은 법령: 부재를 확정할 수 없음" };
    const revs = await store.revisions(lawId);
    if (!revs.length) return { search_status: "UNVERIFIED", reason: "법령 버전 정보 없음", law_id: lawId };
    if (!revs.some((r) => visible(r, actor))) return { search_status: "ACCESS_DENIED", reason: "열람 권한 없음", law_id: lawId };
    const vis = revs.filter((r) => visible(r, actor));
    const rev = effectiveAt(vis, asOf);
    if (!rev) {
      // 모든 버전이 보이고 VERIFIED이며, 기준일이 보유한 가장 이른 버전 이후일 때만 "그 날짜에 시행 버전 없음"을 확정(폐지 등).
      // 가장 이른 버전보다 앞선 기준일은 그 시점 원문을 보유하지 않은 것이라 확인 불가 (부재 단정 금지, docs/02 4장)
      const earliest = Math.min(...revs.map((r) => r.effective_from));
      const certain = asOf >= earliest && vis.length === revs.length && revs.every((r) => r.authority_status === "VERIFIED");
      return certain
        ? { search_status: "NOT_FOUND_VERIFIED", reason: `기준일 ${asOf}에 시행 중인 승인 버전 없음 (등록 버전 ${vis.map((r) => r.revision_id).join(", ")})`, law_id: lawId }
        : { search_status: "UNVERIFIED", reason: asOf < earliest ? `기준일 ${asOf}은 보유한 가장 이른 버전(${earliest}) 이전 — 그 시점 원문 미보유` : `기준일 ${asOf}에 확인 가능한 승인 버전 없음`, law_id: lawId };
    }
    const base = { law_id: lawId, revision_id: rev.revision_id, effective_from: rev.effective_from, effective_to: rev.effective_to };
    const provs = await store.provisions(lawId, rev.revision_id);
    if (!provs) return { search_status: "UNVERIFIED", reason: "조문 구조 데이터 없음", ...base };

    const p = findPath(provs, path);
    if (p) {
      const kids = provs.filter((c) => c.provision_id.startsWith(p.provision_id + "/"));
      const hist = rev.effective_to < todayYmd();
      return {
        search_status: p.status === "DELETED" ? "DELETED" : hist ? "HISTORICAL" : "FOUND",
        reason: p.status === "DELETED" ? `삭제된 조문 (${p.deletion_date})` : hist ? `과거 버전 (${rev.effective_from}~${rev.effective_to})` : "현행 조문 확인",
        ...base, provision_id: p.provision_id, path_label: p.path_label, title: p.title, deletion_date: p.deletion_date,
        original_text: p.status === "DELETED" ? p.original_text : p.normalized_text,
        children: kids.map((c) => ({ provision_id: c.provision_id, path_label: c.path_label, status: c.status, original_text: c.normalized_text })),
      };
    }
    // 현행 버전에 없음 → 과거 버전에서 찾으면 HISTORICAL, 어디에도 없으면 확인된 부재
    let unchecked = false;
    for (const old of vis.filter((r) => r.effective_from < rev.effective_from).sort((a, b) => b.effective_from - a.effective_from)) {
      const op = await store.provisions(lawId, old.revision_id);
      if (!op) { unchecked = true; continue; }
      const hit = findPath(op, path);
      if (hit) {
        return {
          search_status: "HISTORICAL", reason: `현행 버전(${rev.revision_id})에 없음. 과거 버전 ${old.revision_id}에만 존재`,
          law_id: lawId, revision_id: old.revision_id, effective_from: old.effective_from, effective_to: old.effective_to,
          provision_id: hit.provision_id, path_label: hit.path_label, title: hit.title, original_text: hit.normalized_text,
        };
      }
    }
    // 파싱 이슈가 남은 버전은 구조가 완전하다고 볼 수 없으므로 부재를 확정하지 않는다
    if (!rev.parse_ok) return { search_status: "UNVERIFIED", reason: "파싱 검토 미완료 버전: 부재를 확정할 수 없음", ...base };
    if (unchecked || vis.length !== revs.length) return { search_status: "UNVERIFIED", reason: "확인하지 못한 과거 버전이 있어 부재를 확정할 수 없음", ...base };
    return { search_status: "NOT_FOUND_VERIFIED", reason: `${lawId}@${rev.revision_id} 전체 구조에서 ${path} 없음 (과거 버전 포함 확인)`, ...base };
  }

  return {
    get_clause: getClause,

    async get_official_policy(args: Record<string, unknown>, actor: Actor) {
      const asOf = asOfYmd(args);
      const lawId = await resolveLaw(store, args);
      if (!lawId) return { search_status: "UNVERIFIED", reason: "등록되지 않은 법령" };
      const revs = (await store.revisions(lawId)).filter((r) => visible(r, actor));
      if (!revs.length) return { search_status: "ACCESS_DENIED", reason: "열람 권한 없음" };
      const cur = effectiveAt(revs, asOf);
      return {
        search_status: cur ? "FOUND" : "UNVERIFIED",
        law_id: lawId, law_name: revs[0]!.law_name, as_of: asOf,
        current: cur ? { revision_id: cur.revision_id, effective_from: cur.effective_from, effective_to: cur.effective_to, registry_doc_no: cur.registry_doc_no, content_hash: cur.content_hash } : null,
        versions: revs.map((r) => ({ revision_id: r.revision_id, effective_from: r.effective_from, effective_to: r.effective_to, authority_status: r.authority_status })),
      };
    },

    async verify_version(args: Record<string, unknown>, actor: Actor) {
      const lawId = await resolveLaw(store, args);
      const revId = str(args, "revision_id");
      const hash = str(args, "content_hash", false);
      const asOf = asOfYmd(args);
      const revs = lawId ? (await store.revisions(lawId)).filter((r) => visible(r, actor)) : [];
      const r = revs.find((x) => x.revision_id === revId);
      if (!r) return { registered: false, official: false, reason: "Registry에 없는 버전 — 공식성 확인 불가" };
      const next = revs.find((x) => x.effective_from > r.effective_from && x.authority_status === "VERIFIED");
      return {
        registered: true, official: r.authority_status === "VERIFIED",
        current_as_of: r.effective_from <= asOf && asOf <= r.effective_to,
        hash_match: hash ? hash === r.content_hash : null,
        superseded_by: next?.revision_id ?? null,
      };
    },

    async resolve_reference(args: Record<string, unknown>, actor: Actor) {
      const pid = str(args, "provision_id");
      const [lawRev] = pid.split("/");
      const [lawId, revId] = lawRev!.split("@");
      const rec = (await store.revisions(lawId!)).find((r) => r.revision_id === revId);
      if (!rec) return { search_status: "UNVERIFIED", reason: "등록되지 않은 법령 버전", references: [] };
      if (!visible(rec, actor)) return { search_status: "ACCESS_DENIED", reason: "열람 권한 없음", references: [] };
      const provs = (await store.provisions(lawId!, revId!)) ?? [];
      const p = provs.find((x) => x.provision_id === pid);
      if (!p) return { search_status: rec.parse_ok ? "NOT_FOUND_VERIFIED" : "UNVERIFIED", reason: "조문 없음", references: [] };
      const byId = new Map(provs.map((x) => [x.provision_id, x]));
      return {
        search_status: "FOUND",
        references: p.references.map((r) => {
          const t = r.target_id ? byId.get(r.target_id) : undefined;
          return {
            raw: r.raw, kind: r.kind, exception_candidate: r.exception_candidate, target_id: r.target_id,
            target_status: r.target_id ? (t ? t.status : "UNVERIFIED") : "UNRESOLVED",
            target_path_label: t?.path_label ?? null,
          };
        }),
      };
    },

    async compare_versions(args: Record<string, unknown>, actor: Actor) {
      const lawId = await resolveLaw(store, args);
      if (!lawId) throw new ToolError("NOT_FOUND", "등록되지 않은 법령");
      const revs = (await store.revisions(lawId)).filter((r) => visible(r, actor));
      const [o, n] = [str(args, "old_revision"), str(args, "new_revision")];
      if (!revs.some((r) => r.revision_id === o) || !revs.some((r) => r.revision_id === n)) throw new ToolError("NOT_FOUND", "버전 없음 또는 권한 없음");
      const [op, np] = [await store.provisions(lawId, o), await store.provisions(lawId, n)];
      if (!op || !np) throw new ToolError("NOT_FOUND", "조문 구조 데이터 없음");
      const law = (rev: string, provisions: Provision[]) => ({ law_id: lawId, law_name: "", revision_id: rev, effective_from: 0, parser_version: "", provisions, issues: [] });
      return { law_id: lawId, old_revision: o, new_revision: n, changes: diffLaws(law(o, op), law(n, np)) };
    },

    /** 최신 공식 법령 원문 (AgentCore Browser, 국가법령정보센터 한정). 참고용 UNVERIFIED */
    async fetch_official_law(args: Record<string, unknown>) {
      if (!opts.fetcher) throw new ToolError("UNKNOWN_TOOL", "Browser 미설정");
      const law_name = str(args, "law_name");
      if (!/^[가-힣A-Za-z0-9·ㆍ\s()]{2,60}$/u.test(law_name)) throw new ToolError("INVALID_ARGUMENT", "law_name은 법령명만 (URL 불가)");
      const clause = str(args, "clause", false);
      return fetchOfficialLaw(opts.fetcher, store, { law_name, ...(clause ? { clause } : {}) });
    },
  };
}
