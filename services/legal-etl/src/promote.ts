// 단계 11 Promote: 승인 바인딩 소비(APPROVED→USED) 후 마스킹본을 published 버킷으로 + .metadata.json (interfaces.md 3·5·7.1장)
import { createHash } from "node:crypto";
import { MetadataSidecar, OPEN_END } from "@hanaeum/schemas";
import type { DocumentMetadata, IndexGroup, StepInput, StepOutput } from "@hanaeum/schemas";
import type { DocumentRecord, ObjectStore, Records } from "./store.ts";

export const sha256 = (b: Buffer | string) => "sha256:" + createHash("sha256").update(b).digest("hex");

/** 승인 레코드 해시와 원본 해시 비교. 승인 API가 S3 ChecksumSHA256(base64)을 저장해도, `sha256:{hex}`나 hex를 저장해도 같은 바이트면 일치 */
export function hashMatches(approvalHash: string, bytes: Buffer): boolean {
  const d = createHash("sha256").update(bytes).digest();
  const v = approvalHash.trim();
  return v === "sha256:" + d.toString("hex") || v.toLowerCase() === d.toString("hex") || v === d.toString("base64");
}

const INDEX_GROUP: Record<DocumentRecord["document_type"], IndexGroup> = {
  REGULATION: "legal-clauses", KNOWHOW: "wiki-knowledge", MANUAL: "official-manuals",
};
export const publishedPrefix = (d: Pick<DocumentRecord, "document_type" | "doc_id">) =>
  `${d.document_type === "REGULATION" ? "legal" : "knowledge"}/${d.doc_id}/`;

const todayYmd = () => Number(new Date().toISOString().slice(0, 10).replaceAll("-", ""));

export function buildMetadata(doc: DocumentRecord, approval_id: string, content_hash: string): DocumentMetadata {
  if (doc.authority_status === "REJECTED") throw new Error("REJECTED 문서는 게시 불가");
  return {
    doc_id: doc.doc_id,
    document_type: doc.document_type,
    index_group: INDEX_GROUP[doc.document_type],
    authority_status: doc.authority_status,
    freshness: "CURRENT",
    lifecycle: "PUBLISHED",
    title: doc.title,
    ...(doc.law_id ? { law_id: doc.law_id, law_name: doc.law_name ?? doc.title } : {}),
    ...(doc.revision_id ? { revision_id: doc.revision_id } : {}),
    effective_from: doc.effective_from ?? (doc.revision_id ? Number(doc.revision_id.replaceAll("-", "")) : todayYmd()),
    effective_to: doc.effective_to ?? OPEN_END,
    acl_groups: doc.acl_groups,
    dept: doc.dept,
    approval_id,
    content_hash,
  };
}

// approval_id: ASL이 넘기면 사용, 없으면 문서 버전으로 승인 레코드를 찾는다
export interface PromoteInput extends StepInput { approval_id?: string; published_bucket: string }

export async function promoteStep(input: PromoteInput, store: ObjectStore, records: Records): Promise<StepOutput> {
  const doc = await records.getDocument(input.doc_id);
  if (!doc) throw new Error(`Documents 레코드 없음: ${input.doc_id}`);
  if (doc.version !== input.version) throw new Error(`버전 불일치: record v${doc.version} ≠ input v${input.version}`);

  // 승인은 원본 객체 해시에 묶인다 (interfaces.md 7.1). 승인 이후 원본이 바뀌었으면 여기서 막힌다.
  const originals = await store.list(input.bucket, `${input.doc_id}/original.`);
  if (originals.length !== 1) throw new Error("original 객체가 1개가 아님");
  const original = await store.get(input.bucket, originals[0]!);
  const apr = input.approval_id ? await records.getApproval(input.approval_id) : await records.findApproval(input.doc_id, input.version, input.workflow_id);
  if (!apr || !hashMatches(apr.content_hash, original)) {
    throw Object.assign(new Error(`승인 바인딩 불일치 또는 재사용: ${apr?.approval_id ?? "승인 레코드 없음"}`), { name: "ApprovalBindingError" });
  }
  // 조건부 전환은 레코드에 저장된 해시 값 그대로로 (형식 차이와 무관하게 위에서 바이트 일치를 확인함)
  await records.consumeApproval({ approval_id: apr.approval_id, doc_id: input.doc_id, version: input.version, content_hash: apr.content_hash, workflow_id: input.workflow_id });
  const approvalId = apr.approval_id;

  // 마스킹본만 게시 (원문·work/ 는 절대 published로 가지 않음). 페이지 수가 이번 추출 결과와 정확히 같아야 함 (이전 실행의 잔여 페이지 혼입 차단)
  const { page_count } = JSON.parse((await store.get(input.bucket, `${input.doc_id}/work/text_layer.json`)).toString()) as { page_count: number };
  const expected = Array.from({ length: page_count }, (_, i) => `${input.doc_id}/masked/segments/${String(i).padStart(4, "0")}.json`);
  const segKeys = (await store.list(input.bucket, `${input.doc_id}/masked/segments/`)).filter((k) => k.endsWith(".json"));
  if (segKeys.join() !== expected.join()) throw new Error(`마스킹 세그먼트 불일치: ${segKeys.length}개 / 기대 ${page_count}개`);
  const texts: string[] = [];
  for (const k of segKeys) texts.push((JSON.parse((await store.get(input.bucket, k)).toString()) as { text: string }).text);
  const content = texts.join("\n");
  if (!content.trim()) throw new Error("게시할 본문이 비어 있음");

  const contentHash = sha256(content);
  const meta = MetadataSidecar.parse({ metadataAttributes: buildMetadata(doc, approvalId, contentHash) });
  const key = `${publishedPrefix(doc)}content.txt`;
  await store.put(input.published_bucket, key, content, "text/plain; charset=utf-8");
  await store.put(input.published_bucket, `${key}.metadata.json`, JSON.stringify(meta));
  // ASL은 status만 넘기므로 게시본 해시는 Documents.published_content_hash에 직접 기록 (검색 재검증 기준)
  await records.setPublishedHash(input.doc_id, contentHash);
  return { status: "OK", output_key: key, content_hash: contentHash };
}
