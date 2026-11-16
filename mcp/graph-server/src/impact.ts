// Change Impact (docs/01 6장): 조항 Diff → 역방향 탐색(CITES 직접, REFERENCES 1홉 간접) → 영향 노하우 + 근거
// 결과는 dhxorb96의 Wiki Maintenance(수정 초안)·변경 영향 화면 입력. 자동 수정·자동 게시 없음.
import { diffLaws } from "@hanaeum/legal-parser";
import type { ProvisionChange } from "@hanaeum/legal-parser";
import type { ParsedLaw } from "@hanaeum/schemas";
import type { GraphStore } from "./store.ts";

export interface ImpactItem {
  doc_id: string; wiki_id: string; title: string;
  relation: "DIRECT" | "INDIRECT";
  risk: "HIGH" | "MEDIUM";
  recommended_freshness: "REVIEW_REQUIRED";
  evidence: { cited_provision_id: string; evidence_span: string; via_provision?: string; change: Pick<ProvisionChange, "path" | "kind" | "old_text" | "new_text" | "numbers_changed"> }[];
}
export interface ImpactReport { law_id: string; old_revision: string; new_revision: string; changes: ProvisionChange[]; impacted: ImpactItem[] }

const pick = (c: ProvisionChange) => ({ path: c.path, kind: c.kind, old_text: c.old_text, new_text: c.new_text, numbers_changed: c.numbers_changed });
const isHigh = (c: ProvisionChange) => c.kind === "DELETED" || c.kind === "REMOVED" || c.numbers_changed.old.join() !== c.numbers_changed.new.join();

/** canSee: 노하우 ACL 문자열("A|B") → 사용자 열람 가능 여부. 없으면 전체(배치·평가용) */
export async function analyzeImpact(oldLaw: ParsedLaw, newLaw: ParsedLaw, graph: GraphStore, canSee: (acl: string) => boolean = () => true): Promise<ImpactReport> {
  if (oldLaw.law_id !== newLaw.law_id) throw new Error("서로 다른 법령은 비교하지 않음");
  const changes = diffLaws(oldLaw, newLaw).filter((c) => !c.path.startsWith("SUPPLEMENTARY:")); // 부칙은 별도 검토 (경과조치)
  const byDoc = new Map<string, ImpactItem>();
  const add = (row: { wiki_id: string; wiki_doc_id: string; title: string; provision_id: string; path: string; evidence_span: string }, relation: ImpactItem["relation"], c: ProvisionChange, via?: string) => {
    const item = byDoc.get(row.wiki_doc_id) ?? { doc_id: row.wiki_doc_id, wiki_id: row.wiki_id, title: row.title, relation, risk: "MEDIUM", recommended_freshness: "REVIEW_REQUIRED", evidence: [] };
    if (relation === "DIRECT") item.relation = "DIRECT";
    if (isHigh(c)) item.risk = "HIGH";
    item.evidence.push({ cited_provision_id: row.provision_id, evidence_span: row.evidence_span, ...(via ? { via_provision: via } : {}), change: pick(c) });
    byDoc.set(row.wiki_doc_id, item);
  };

  const paths = changes.map((c) => c.path);
  const overlapsAny = (p: string, c: ProvisionChange) => p === c.path || p.startsWith(c.path + "/") || c.path.startsWith(p + "/");
  for (const row of (await graph.citers(newLaw.law_id, paths)).filter((r) => canSee(r.acl))) {
    for (const c of changes) if (overlapsAny(row.path, c)) add(row, "DIRECT", c);
  }
  // 간접: 변경 조문을 참조하는 다른 조문을 인용한 노하우 (1홉)
  const refs = await graph.referrers(newLaw.law_id, paths);
  const viaPaths = [...new Set(refs.map((r) => r.from_path))].filter((p) => !paths.some((x) => x === p));
  if (viaPaths.length) {
    for (const row of (await graph.citers(newLaw.law_id, viaPaths)).filter((r) => canSee(r.acl))) {
      if (byDoc.get(row.wiki_doc_id)?.relation === "DIRECT") continue;
      for (const r of refs.filter((x) => overlapsAny(row.path, { path: x.from_path } as ProvisionChange))) {
        const c = changes.find((x) => overlapsAny(r.to_path, x))!;
        add(row, "INDIRECT", c, `${r.from_path} → ${r.to_path}`);
      }
    }
  }
  return { law_id: newLaw.law_id, old_revision: oldLaw.revision_id, new_revision: newLaw.revision_id, changes, impacted: [...byDoc.values()].sort((a, b) => a.doc_id.localeCompare(b.doc_id)) };
}
