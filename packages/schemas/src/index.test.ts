import { test } from "node:test";
import assert from "node:assert/strict";
import { DocId, ProvisionId, LawRevisionId, DocumentMetadata, SearchStatus, isoFromDotted, ymd } from "./index.ts";

test("ID 정규식", () => {
  assert.ok(DocId.safeParse("doc_01JD3ABCDEFGHJKMNPQRSTVWXY").success);
  assert.ok(!DocId.safeParse("doc_01JD3ABCDEFGHJKMNPQRSTVWXI").success); // I는 ULID 문자 아님
  assert.ok(LawRevisionId.safeParse("SYN-LOAN-001@2026-11-01").success);
  assert.ok(ProvisionId.safeParse("SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:2/ITEM:3/SUBITEM:GA").success);
  assert.ok(ProvisionId.safeParse("SYN-LOAN-001@2026-11-01/ARTICLE:12-2").success);
  assert.ok(ProvisionId.safeParse("SYN-LOAN-001@2026-11-01/ARTICLE:12/SUBITEM:CHA").success === true);
  assert.ok(!ProvisionId.safeParse("SYN-LOAN-001@2026-11-01/ARTICLE:12/SUBITEM:XX").success);
});

test("메타데이터: REGULATION은 law_id 필수, 날짜 범위", () => {
  const base = {
    doc_id: "F-001", title: "기업여신 심사규정 v1", document_type: "REGULATION", index_group: "legal-clauses",
    authority_status: "VERIFIED", freshness: "CURRENT", lifecycle: "PUBLISHED",
    law_id: "SYN-LOAN-001", revision_id: "2026-11-01", effective_from: 20261101, effective_to: 99991231,
    acl_groups: ["ALL"], dept: "여신", approval_id: "apr_x", content_hash: "sha256:" + "a".repeat(64),
  };
  assert.ok(DocumentMetadata.safeParse(base).success);
  assert.ok(!DocumentMetadata.safeParse({ ...base, law_id: undefined }).success);
  assert.ok(!DocumentMetadata.safeParse({ ...base, effective_from: 20270101, effective_to: 20261231 }).success);
  assert.ok(!DocumentMetadata.safeParse({ ...base, acl_groups: [] }).success);
});

test("enum·날짜 헬퍼", () => {
  assert.equal(SearchStatus.options.length, 6);
  assert.equal(isoFromDotted("2013. 12. 3."), "2013-12-03");
  assert.equal(ymd("2026-11-01"), 20261101);
});
