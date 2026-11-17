// Graph MCP 서버 + 단계 13 GraphUpsert
import { makeHandler } from "@hanaeum/mcp-kit";
import { S3ObjectStore, DynamoRecords, publishedPrefix } from "@hanaeum/legal-etl";
import type { DocumentRecord, ObjectStore, Records } from "@hanaeum/legal-etl";
import { StepInput } from "@hanaeum/schemas";
import type { ClauseStore } from "@hanaeum/regulation-server";
import { extractCitations } from "./citations.ts";
import type { Citation } from "./model.ts";
import { DynamoClauseStore } from "@hanaeum/regulation-server";
import { NeptuneGraphStore } from "./store.ts";
import type { GraphStore } from "./store.ts";
import { graphTools } from "./tools.ts";
import { graphUpsertStep } from "./upsert-step.ts";
import type { GraphUpsertInput } from "./upsert-step.ts";

export * from "./model.ts";
export * from "./store.ts";
export * from "./impact.ts";
export * from "./citations.ts";
export * from "./tools.ts";
export * from "./upsert-step.ts";

const e = process.env;
const records = () => new DynamoRecords({ documents: e["TABLE_DOCUMENTS"]!, approvals: "" });
const deps = () => ({ graph: new NeptuneGraphStore(e["NEPTUNE_ENDPOINT"]!), clauses: new DynamoClauseStore(e["TABLE_REGULATIONS"]!),
  // 레코드 없음 = 제외. 조회 실패(분류 전 레코드·스로틀링)는 영향 대상에 남긴다 (한 건 때문에 전체 분석이 실패하지 않게, 놓치는 쪽보다 안전)
  ...(e["TABLE_DOCUMENTS"] ? { live: async (id: string) => { try { const r = await records().getDocument(id); return !!r && r.lifecycle !== "DELETED"; } catch { return true; } } } : {}) });
export const handler = makeHandler(e["NEPTUNE_ENDPOINT"] && e["TABLE_REGULATIONS"] ? graphTools(deps()) : {});

/** 단계 13 Lambda: ASL은 공통 입력 6필드만 넘긴다 → Documents 레코드·게시본을 직접 읽어 GraphUpsertInput을 만든다 */
export async function buildUpsertInput(input: StepInput, records: Records, store: ObjectStore, clauses: ClauseStore, publishedBucket: string): Promise<GraphUpsertInput> {
  const doc = await records.getDocument(input.doc_id) as (DocumentRecord & { citations?: Citation[]; parse_reviewed?: boolean; previous_revision_id?: string; registry_doc_no?: string; published_content_hash?: string }) | undefined;
  if (!doc) throw new Error(`Documents 레코드 없음: ${input.doc_id}`);
  const content = (await store.get(publishedBucket, `${publishedPrefix(doc)}content.txt`)).toString("utf8");
  const from = doc.effective_from ?? (doc.revision_id ? Number(doc.revision_id.replaceAll("-", "")) : 0);
  // 인용: 승인 시 확정된 doc.citations 우선. 없으면 본문에서 추출한 후보 중 실제 조문으로 확인된 것(confidence 0.9)만
  const citations = doc.citations ?? (doc.document_type === "REGULATION" ? [] : (await extractCitations(content, clauses, from || 99991231)).filter((c) => c.confidence >= 0.9));
  return {
    ...input, document_type: doc.document_type, title: doc.title, effective_from: from, effective_to: doc.effective_to ?? 99991231,
    content, content_hash: doc.published_content_hash ?? "", acl_groups: doc.acl_groups, authority_status: doc.authority_status, parse_reviewed: doc.parse_reviewed,
    ...(doc.law_id && doc.revision_id ? { law: { law_id: doc.law_id, law_name: doc.law_name ?? doc.title, revision_id: doc.revision_id, previous_revision_id: doc.previous_revision_id, registry_doc_no: doc.registry_doc_no } } : {}),
    citations,
  };
}

/** 문서 삭제 흐름 마지막 단계 (interfaces.md 6.0): Documents가 DELETED일 때만 그 문서의 노드·관계를 지운다.
 *  분류 전 문서(UnclassifiedDocument)는 게시된 적이 없어 그래프에 없음 → 할 일 없이 OK */
export async function graphDeleteStep(docId: string, records: Pick<Records, "getDocument">, graph: Pick<GraphStore, "deleteDoc">): Promise<{ status: "OK"; affected_doc_ids: string[] }> {
  let doc;
  try { doc = await records.getDocument(docId); }
  catch (err) { if ((err as Error).name === "UnclassifiedDocument") return { status: "OK", affected_doc_ids: [] }; throw err; }
  if (!doc) throw Object.assign(new Error(`Documents 레코드 없음: ${docId}`), { name: "NotDeleted" });
  if (doc.lifecycle !== "DELETED") throw Object.assign(new Error(`삭제 표시(DELETED)가 아닌 문서는 그래프에서 지우지 않음: ${docId} (${doc.lifecycle})`), { name: "NotDeleted" });
  // 규정 삭제면 그 조문을 인용하던 노하우가 근거를 잃는다 → 재검토 대상으로 돌려준다 (오케스트레이터가 REVIEW_REQUIRED 표시)
  return { status: "OK", affected_doc_ids: await graph.deleteDoc(docId) };
}

export const graphUpsertHandler = async (event: unknown) => {
  const d = deps();
  const records = new DynamoRecords({ documents: e["TABLE_DOCUMENTS"]!, approvals: e["TABLE_APPROVALS"]! });
  const input = StepInput.parse(event); // action은 공통 입력 밖의 값이라 parse가 지움 → 원본 event에서 읽는다
  if ((event as { action?: unknown }).action === "delete") return graphDeleteStep(input.doc_id, records, d.graph);
  return graphUpsertStep(await buildUpsertInput(input, records, new S3ObjectStore(), d.clauses, e["BUCKET_PUBLISHED"]!), d.graph, d.clauses);
};
