// Graph MCP Tool: trace_impact, get_dependencies (AUTHOR·REG_APPROVER)
import type { ParsedLaw } from "@hanaeum/schemas";
import { ToolError, aclKeys, str } from "@hanaeum/mcp-kit";
import type { Actor } from "@hanaeum/mcp-kit";
import type { ClauseStore } from "@hanaeum/regulation-server";
import { analyzeImpact } from "./impact.ts";
import type { GraphStore } from "./store.ts";

const ALLOWED = ["AUTHOR", "REG_APPROVER"];
/** acl 문자열이 없으면(법령 노드) 공개, 있으면 사용자 ACL 키와 교집합 필요 */
const canSee = (a: Actor) => (acl: string | null) => !acl || acl.split("|").some((g) => aclKeys(a).includes(g));
const guard = (a: Actor) => { if (!a.groups.some((g) => ALLOWED.includes(g))) throw new ToolError("ACCESS_DENIED", "AUTHOR·REG_APPROVER 전용"); };

export async function loadLaw(store: ClauseStore, lawId: string, rev: string): Promise<ParsedLaw> {
  const r = (await store.revisions(lawId)).find((x) => x.revision_id === rev);
  const provisions = await store.provisions(lawId, rev);
  if (!r || !provisions) throw new ToolError("NOT_FOUND", `${lawId}@${rev} 구조 데이터 없음`);
  return { law_id: lawId, law_name: r.law_name, revision_id: rev, effective_from: r.effective_from, parser_version: "", provisions, issues: [] };
}

export function graphTools(deps: { graph: GraphStore; clauses: ClauseStore }) {
  return {
    async trace_impact(args: Record<string, unknown>, actor: Actor) {
      guard(actor);
      const lawId = await deps.clauses.lawIdByName(str(args, "law"));
      if (!lawId) throw new ToolError("NOT_FOUND", "등록되지 않은 법령");
      const revs = await deps.clauses.revisions(lawId);
      const newRev = str(args, "new_revision", false) || revs.at(-1)!.revision_id;
      const idx = revs.findIndex((r) => r.revision_id === newRev);
      const oldRev = str(args, "old_revision", false) || revs[idx - 1]?.revision_id;
      if (!oldRev) throw new ToolError("NOT_FOUND", "비교할 이전 버전 없음");
      return analyzeImpact(await loadLaw(deps.clauses, lawId, oldRev), await loadLaw(deps.clauses, lawId, newRev), deps.graph, canSee(actor));
    },
    async get_dependencies(args: Record<string, unknown>, actor: Actor) {
      guard(actor);
      const id = str(args, "id");
      const see = canSee(actor);
      const edges = await deps.graph.outgoing(id);
      if (edges.length && !see(edges[0]!.from_acl)) throw new ToolError("ACCESS_DENIED", "열람 권한 없음");
      return { id, edges: edges.filter((e) => see(e.to_acl)).map((e) => ({ type: e.type, to: e.to, to_label: e.to_label, props: e.props })) };
    },
  };
}
