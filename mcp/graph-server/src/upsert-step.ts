// 단계 13 GraphUpsert: 승인된 문서의 관계만 Neptune에 게시. 법령은 구조화 저장소(Regulations)에도 적재.
import { parseLaw } from "@hanaeum/legal-parser";
import { newId } from "@hanaeum/schemas";
import type { AuthorityStatus, Finding, StepInput, StepOutput } from "@hanaeum/schemas";
import type { ClauseStore, RevisionRecord } from "@hanaeum/regulation-server";
import { lawGraph, wikiGraph } from "./model.ts";
import type { Citation } from "./model.ts";
import type { GraphStore } from "./store.ts";

export interface GraphUpsertInput extends StepInput {
  document_type: "REGULATION" | "KNOWHOW" | "MANUAL";
  title: string; effective_from: number; effective_to: number;
  content: string; // published 마스킹본 본문 (핸들러가 S3에서 읽어 채움)
  content_hash: string; acl_groups: string[];
  authority_status: AuthorityStatus; // Documents 레코드의 현재 공식성 (하드코딩 금지)
  parse_reviewed?: boolean; // 파싱 이슈를 사람이 검토·승인했으면 true
  law?: { law_id: string; law_name: string; revision_id: string; previous_revision_id?: string; registry_doc_no?: string };
  citations?: Citation[]; // 승인 시 확정된 인용 (Trust Gate 후보 → 사람 승인)
}

export type WritableClauseStore = ClauseStore & {
  putLaw?(r: RevisionRecord, l: ReturnType<typeof parseLaw>): Promise<void>;
  closeRevision?(lawId: string, revisionId: string, effectiveTo: number): Promise<void>;
};

/** yyyymmdd 하루 전 */
export const dayBefore = (ymd: number) => {
  const d = new Date(Date.UTC(Math.floor(ymd / 10000), Math.floor(ymd / 100) % 100 - 1, ymd % 100) - 86400000);
  return Number(d.toISOString().slice(0, 10).replaceAll("-", ""));
};

export async function graphUpsertStep(input: GraphUpsertInput, graph: GraphStore, clauses: WritableClauseStore): Promise<StepOutput> {
  if (input.document_type === "REGULATION") {
    if (!input.law) throw new Error("REGULATION에는 law 정보 필요");
    const law = parseLaw(input.content, { ...input.law, effective_from: input.effective_from });
    const findings: Finding[] = law.issues.map((i) => ({ finding_id: newId("fnd"), step: "GraphUpsert", severity: "MEDIUM", code: i.code, message: i.message.slice(0, 200), evidence_ref: `line:${i.line}` }));
    // 파싱 이슈가 있으면 사람 검토 전에는 구조 저장소·그래프에 쓰지 않는다 (docs/01 13.5 자동 게시 금지)
    if (findings.length && !input.parse_reviewed) return { status: "REVIEW_REQUIRED", findings };
    const rec: RevisionRecord = {
      law_id: law.law_id, law_name: law.law_name, revision_id: law.revision_id, registry_doc_no: input.law.registry_doc_no,
      effective_from: input.effective_from, effective_to: input.effective_to, authority_status: input.authority_status,
      doc_id: input.doc_id, content_hash: input.content_hash, acl_groups: input.acl_groups, parse_ok: law.issues.length === 0,
    };
    if (clauses.putLaw) await clauses.putLaw(rec, law);
    // 새 VERIFIED 버전이 시행되면 겹치는 이전 버전의 종료일을 닫는다 (이전 버전이 현행으로 남지 않게)
    if (rec.authority_status === "VERIFIED" && clauses.closeRevision) {
      for (const r of await clauses.revisions(law.law_id)) {
        if (r.revision_id !== rec.revision_id && r.effective_from < rec.effective_from && r.effective_to >= rec.effective_from) {
          await clauses.closeRevision(law.law_id, r.revision_id, dayBefore(rec.effective_from));
        }
      }
    }
    await graph.upsert(lawGraph(law, { doc_id: input.doc_id, effective_from: input.effective_from, effective_to: input.effective_to, previous_revision_id: input.law.previous_revision_id }));
    return { status: "OK", findings };
  }
  // 노하우·매뉴얼: 존재하는 조문 인용만 게시, 없는 조문은 Finding
  const findings: Finding[] = [];
  const valid: Citation[] = [];
  for (const c of input.citations ?? []) {
    const [lawRev] = c.provision_id.split("/");
    const [lawId, rev] = lawRev!.split("@");
    const provs = await clauses.provisions(lawId!, rev!);
    if (provs?.some((p) => p.provision_id === c.provision_id)) valid.push(c);
    else findings.push({ finding_id: newId("fnd"), step: "GraphUpsert", severity: "MEDIUM", code: "CITATION_TARGET_MISSING", message: c.provision_id, evidence_ref: c.provision_id });
  }
  await graph.upsert(wikiGraph({ doc_id: input.doc_id, version: input.version, title: input.title, effective_from: input.effective_from, effective_to: input.effective_to, acl_groups: input.acl_groups }, valid));
  return { status: findings.length ? "REVIEW_REQUIRED" : "OK", findings };
}
