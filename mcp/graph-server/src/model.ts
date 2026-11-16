// 법령·노하우 그래프 모델 (docs/01 5.2, docs/04 5장). 결정적 ID, 모든 노드·엣지에 doc_id.
import type { ParsedLaw, Provision } from "@hanaeum/schemas";

export type NodeLabel = "LAW" | "LAW_VERSION" | "ARTICLE_VERSION" | "CLAUSE_VERSION" | "ANNEX" | "WIKI_VERSION";
export type EdgeType = "CONTAINS" | "REFERENCES" | "EXCEPTION_CANDIDATE" | "SUPERSEDES" | "CITES";

export interface GNode { id: string; label: NodeLabel; props: Record<string, string | number | boolean | null> }
export interface GEdge {
  type: EdgeType; from: string; fromLabel: NodeLabel; to: string; toLabel: NodeLabel;
  props: { doc_id: string; evidence_span: string; source_version: string; confidence: number; reviewer_status: string; valid_from: number; valid_to: number };
}
export interface Graph { nodes: GNode[]; edges: GEdge[] }

const relPath = (id: string) => id.slice(id.indexOf("/") + 1);
const labelOf = (p: Provision): NodeLabel => (p.level === "ARTICLE" ? "ARTICLE_VERSION" : p.level === "ANNEX" ? "ANNEX" : "CLAUSE_VERSION");
export const labelOfId = (id: string): NodeLabel =>
  /\/ANNEX:[\d-]+$/u.test(id) ? "ANNEX" : /\/ARTICLE:[\d-]+$/u.test(id) ? "ARTICLE_VERSION" : id.includes("/") ? "CLAUSE_VERSION" : id.includes("@") ? "LAW_VERSION" : "LAW";

export interface LawVersionInfo { doc_id: string; effective_from: number; effective_to: number; previous_revision_id?: string }

export function lawGraph(law: ParsedLaw, v: LawVersionInfo): Graph {
  const ver = `${law.law_id}@${law.revision_id}`;
  const ep = (evidence_span: string, confidence = 1) => ({ doc_id: v.doc_id, evidence_span, source_version: ver, confidence, reviewer_status: "APPROVED", valid_from: v.effective_from, valid_to: v.effective_to });
  const nodes: GNode[] = [
    { id: law.law_id, label: "LAW", props: { doc_id: v.doc_id, law_id: law.law_id, name: law.law_name } },
    { id: ver, label: "LAW_VERSION", props: { doc_id: v.doc_id, law_id: law.law_id, revision_id: law.revision_id, effective_from: v.effective_from, effective_to: v.effective_to } },
  ];
  const edges: GEdge[] = [{ type: "CONTAINS", from: law.law_id, fromLabel: "LAW", to: ver, toLabel: "LAW_VERSION", props: ep("") }];
  if (v.previous_revision_id) edges.push({ type: "SUPERSEDES", from: ver, fromLabel: "LAW_VERSION", to: `${law.law_id}@${v.previous_revision_id}`, toLabel: "LAW_VERSION", props: ep("") });
  for (const p of law.provisions) {
    if (p.level === "SUPPLEMENTARY") continue; // 부칙 묶음 노드는 생략, 부칙 조는 ARTICLE_VERSION
    const label = labelOf(p);
    nodes.push({ id: p.provision_id, label, props: {
      doc_id: v.doc_id, law_id: law.law_id, revision_id: law.revision_id, path: relPath(p.provision_id),
      path_label: p.path_label, status: p.status, text: p.normalized_text.slice(0, 1000),
    } });
    const parent = p.parent_id && !p.parent_id.match(/\/SUPPLEMENTARY:\d+$/u) ? p.parent_id : ver;
    edges.push({ type: "CONTAINS", from: parent, fromLabel: labelOfId(parent), to: p.provision_id, toLabel: label, props: ep("") });
    for (const r of p.references) {
      if (!r.target_id || !r.target_id.startsWith(ver + "/")) continue; // 외부·미해결 참조는 그래프에 게시하지 않음
      edges.push({ type: "REFERENCES", from: p.provision_id, fromLabel: label, to: r.target_id, toLabel: labelOfId(r.target_id), props: ep(r.raw) });
      if (r.exception_candidate) edges.push({ type: "EXCEPTION_CANDIDATE", from: p.provision_id, fromLabel: label, to: r.target_id, toLabel: labelOfId(r.target_id), props: { ...ep(r.raw, 0.5), reviewer_status: "CANDIDATE" } });
    }
  }
  return { nodes, edges };
}

export interface Citation { provision_id: string; evidence_span: string; confidence: number }

/** 승인된 노하우 → WIKI_VERSION + CITES (승인 전 관계는 그래프에 올리지 않음) */
export function wikiGraph(doc: { doc_id: string; version: number; title: string; effective_from: number; effective_to: number; acl_groups: string[] }, citations: Citation[]): Graph {
  const id = `${doc.doc_id}@v${doc.version}`;
  return {
    // acl은 문자열로 저장 (Neptune 속성은 리스트 미지원). Tool이 사용자 ACL로 다시 거른다
    nodes: [{ id, label: "WIKI_VERSION", props: { doc_id: doc.doc_id, version: doc.version, title: doc.title, acl: doc.acl_groups.join("|") } }],
    edges: citations.map((c) => ({
      type: "CITES", from: id, fromLabel: "WIKI_VERSION", to: c.provision_id, toLabel: labelOfId(c.provision_id),
      props: { doc_id: doc.doc_id, evidence_span: c.evidence_span, source_version: id, confidence: c.confidence, reviewer_status: "APPROVED", valid_from: doc.effective_from, valid_to: doc.effective_to },
    })),
  };
}
