import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DocumentMetadata } from "@hanaeum/schemas";
import { chunkDocument, transform, MAX_CHUNK_CHARS } from "./index.ts";
import type { Io } from "./index.ts";

const FIX = new URL("../../../tests/fixtures/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, FIX), "utf8");
const meta = (o: Partial<DocumentMetadata> = {}): DocumentMetadata => ({
  doc_id: "F-001", title: "한빛은행 기업여신 심사규정", law_name: "한빛은행 기업여신 심사규정", document_type: "REGULATION", index_group: "legal-clauses",
  authority_status: "VERIFIED", freshness: "CURRENT", lifecycle: "PUBLISHED", law_id: "SYN-LOAN-001", revision_id: "2026-11-01",
  effective_from: 20261101, effective_to: 99991231, acl_groups: ["ALL"], dept: "여신", approval_id: "apr_1", content_hash: "sha256:" + "0".repeat(64), ...o,
});

test("법령: 항 단위 청크, 항 없는 조는 조 전체, 문맥 헤더에 법령명·시행일·장·조 제목", () => {
  const chunks = chunkDocument(read("documents/F-001.txt"), meta());
  const ids = chunks.map((c) => c.metadata.provision_id.split("/").slice(1).join("/"));
  assert.ok(ids.includes("ARTICLE:12/PARAGRAPH:1"));
  assert.ok(ids.includes("ARTICLE:11")); // 항 없는 조
  assert.ok(!ids.includes("ARTICLE:12")); // 항이 있는 조는 Parent로만 (청크 아님)
  assert.ok(ids.includes("ARTICLE:10/PARAGRAPH:1"));
  assert.ok(!ids.some((i) => i.includes("ITEM")), "짧은 항의 호는 항 청크에 포함");
  const c = chunks.find((x) => x.metadata.provision_id.endsWith("ARTICLE:12/PARAGRAPH:1"))!;
  assert.equal(c.augmented_search_text.split("\n")[0], "[한빛은행 기업여신 심사규정 · 시행 2026-11-01 · 제2장 심사 절차 · 제12조(승인 기준) · 제12조제1항]");
  assert.equal(c.metadata.parent_id, "SYN-LOAN-001@2026-11-01/ARTICLE:12");
  assert.equal(c.metadata.provision_path, "제12조제1항");
});

test("임베딩 입력(contentBody)에 실제 본문이 들어감 — 헤더만 임베딩되는 사고 방지", () => {
  for (const c of chunkDocument(read("documents/F-001.txt"), meta())) {
    const body = c.augmented_search_text.split("\n").slice(1).join("\n");
    if (c.metadata.provision_status === "DELETED") continue;
    assert.ok(body.replace(/\s/gu, "").length >= 10, `${c.metadata.provision_id} 본문 없음`);
    assert.ok(c.metadata.original_text.length > 0);
  }
  const c = chunkDocument(read("documents/F-001.txt"), meta()).find((x) => x.metadata.provision_id.endsWith("ARTICLE:12/PARAGRAPH:1"))!;
  assert.match(c.augmented_search_text, /5억원 이상인 경우 본부 여신심사위원회/u);
  assert.match(c.metadata.original_text, /^① 여신 금액이 5억원/u);
});

test("호 포함 항: 원문에 하위 호가 함께 들어감, 삭제 조항은 DELETED 상태 청크", () => {
  const chunks = chunkDocument(read("legal/source/L-001.txt"), meta({ doc_id: "L-001", law_id: "SYN-VLOAN-001", law_name: "가상여신거래법", title: "가상여신거래법" }));
  const p2 = chunks.find((c) => c.metadata.provision_id.endsWith("ARTICLE:12/PARAGRAPH:2"))!;
  assert.match(p2.metadata.original_text, /1의2\. 국채담보대출/u);
  const del = chunks.find((c) => c.metadata.provision_id.endsWith("ARTICLE:12/PARAGRAPH:4"))!;
  assert.equal(del.metadata.provision_status, "DELETED");
  assert.ok(chunks.some((c) => c.metadata.provision_id.includes("SUPPLEMENTARY:1/ARTICLE:2")));
  assert.ok(chunks.some((c) => c.metadata.provision_id.endsWith("ANNEX:1")));
});

test("긴 항은 호 단위로 분할", () => {
  const long = "가".repeat(MAX_CHUNK_CHARS);
  const text = `제1조(목적) ① 다음 각 호를 따른다.\n1. ${long}\n2. 둘째 호 내용입니다.\n② 둘째 항.`;
  const chunks = chunkDocument(text, meta({ law_id: "SYN-T-1", revision_id: "2026-01-01" }));
  const ids = chunks.map((c) => c.metadata.provision_id.split("/").slice(1).join("/"));
  assert.deepEqual(ids, ["ARTICLE:1/PARAGRAPH:1", "ARTICLE:1/PARAGRAPH:1/ITEM:1", "ARTICLE:1/PARAGRAPH:1/ITEM:2", "ARTICLE:1/PARAGRAPH:2"]);
  assert.match(chunks[2]!.augmented_search_text, /^\[.*제1조제1항제2호\]\n2\. 둘째 호/u);
});

test("노하우: 섹션 단위, front matter 제거", () => {
  const chunks = chunkDocument(read("documents/K-001.md"), meta({ doc_id: "K-001", title: "부동산 담보평가 실무 노하우", document_type: "KNOWHOW", index_group: "wiki-knowledge", law_id: undefined, revision_id: undefined, law_name: undefined }));
  assert.deepEqual(chunks.map((c) => c.metadata.provision_path), ["부동산 담보평가 실무 노하우", "적용 조건", "절차", "실패 사례"]);
  assert.ok(!chunks.some((c) => c.augmented_search_text.includes("cites:")));
  assert.match(chunks[2]!.augmented_search_text, /^\[부동산 담보평가 실무 노하우 · 노하우 · 절차\]/u);
});

test("Lambda transform: 배치 읽기 → 청크 배치 쓰기, 메타데이터 누락·미게시 문서는 실패", async () => {
  const files = new Map<string, string>([["in/F-001.json", JSON.stringify({ fileContents: [{ contentBody: read("documents/F-001.txt"), contentType: "string" }] })]]);
  const io: Io = { read: async (_b, k) => files.get(k)!, write: async (_b, k, v) => { files.set(k, v); } };
  const loc = { type: "S3", s3_location: { uri: "s3://p/legal/F-001/content.txt" } };
  const out = await transform({ bucketName: "inter", inputFiles: [{ originalFileLocation: loc, fileMetadata: meta(), contentBatches: [{ key: "in/F-001.json" }] }] }, io);
  const key = out.outputFiles[0]!.contentBatches[0]!.key;
  const batch = JSON.parse(files.get(key)!);
  assert.ok(batch.fileContents.length > 5);
  assert.equal(batch.fileContents[0].contentType, "TEXT");
  assert.ok(batch.fileContents[0].contentMetadata.provision_id);
  // 숫자 필드가 문자열로 와도 처리
  const strMeta = { ...meta(), effective_from: "20261101", effective_to: "99991231" } as unknown as Record<string, unknown>;
  assert.equal((await transform({ bucketName: "inter", inputFiles: [{ originalFileLocation: loc, fileMetadata: strMeta, contentBatches: [{ key: "in/F-001.json" }] }] }, io)).outputFiles.length, 1);
  await assert.rejects(transform({ bucketName: "inter", inputFiles: [{ originalFileLocation: loc, fileMetadata: { doc_id: "x" }, contentBatches: [{ key: "in/F-001.json" }] }] }, io));
  await assert.rejects(transform({ bucketName: "inter", inputFiles: [{ originalFileLocation: loc, fileMetadata: meta({ lifecycle: "IN_REVIEW" }), contentBatches: [{ key: "in/F-001.json" }] }] }, io), /PUBLISHED 아닌/u);
});
