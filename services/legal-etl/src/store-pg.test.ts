import { test } from "node:test";
import assert from "node:assert/strict";
import type { Query } from "@hanaeum/db";
import { PgRecords, recordsFromEnv } from "./store-pg.ts";
import { DynamoRecords } from "./store.ts";

/** SQL·인자 기록 + 미리 정한 행 반환 */
const fake = (rows: Record<string, unknown>[][]) => {
  const calls: { sql: string; params?: Record<string, unknown> }[] = [];
  const q = (async (sql: string, params?: Record<string, unknown>) => { calls.push({ sql, ...(params ? { params } : {}) }); return rows.shift() ?? []; }) as Query;
  return { q, calls };
};

test("PgRecords.getDocument: 행 → DynamoDB 때와 같은 DocumentRecord (attrs 펼침, classification 유형, 날짜 숫자)", async () => {
  const { q } = fake([[{ doc_id: "doc_X", version: 2, owner: "u", title: "T", dept: "여신", acl_groups: ["ALL"], ext: "pdf", lifecycle: "PUBLISHED",
    document_type: null, authority_status: "VERIFIED", freshness: "CURRENT", law_id: null, created_at: "2026-11-17T00:00:00Z", updated_at: "2026-11-17T00:00:00Z",
    attrs: { classification: { document_type: "KNOWHOW", business_path: ["여신"] }, effective_from: "2026-11-01" } }], []]);
  const r = new PgRecords(q);
  const d = (await r.getDocument("doc_X"))!;
  assert.equal(d.document_type, "KNOWHOW");
  assert.equal(d.effective_from, 20261101);
  assert.deepEqual(d.business_path, ["여신"]);
  assert.equal(d.lifecycle, "PUBLISHED");
  assert.ok(!("law_id" in d), "null 열은 키 없음");
  assert.equal(await r.getDocument("doc_none"), undefined);
});

test("PgRecords.consumeApproval: 조건부 UPDATE 1회, 0행이면 ApprovalBindingError, 같은 워크플로 재시도 조건 포함", async () => {
  const { q, calls } = fake([[{ approval_id: "apr_1", status: "USED", used_by: "wf" }], []]);
  const r = new PgRecords(q);
  const a = { approval_id: "apr_1", doc_id: "doc_X", version: 1, content_hash: "sha256:a", workflow_id: "wf" };
  assert.equal((await r.consumeApproval(a)).status, "USED");
  assert.match(calls[0]!.sql, /status = 'APPROVED' OR \(status = 'USED' AND used_by = :wf\)/u);
  assert.deepEqual(calls[0]!.params, { id: "apr_1", d: "doc_X", v: 1, h: "sha256:a", wf: "wf" });
  await assert.rejects(r.consumeApproval(a), { name: "ApprovalBindingError" });
});

test("PgRecords.setPublishedHash: published_at은 처음만(attrs), 문서 없으면 오류", async () => {
  const { q, calls } = fake([[{ doc_id: "doc_X" }], []]);
  const r = new PgRecords(q);
  await r.setPublishedHash("doc_X", "sha256:b", "2026-11-17T01:00:00Z");
  assert.match(calls[0]!.sql, /CASE WHEN attrs \? 'published_at' THEN attrs/u);
  await assert.rejects(r.setPublishedHash("doc_none", "sha256:b"), /레코드 없음/u);
});

test("recordsFromEnv: GOV_STORE=postgres면 PostgreSQL, 아니면 DynamoDB", () => {
  assert.ok(recordsFromEnv({ GOV_STORE: "dynamo", TABLE_DOCUMENTS: "t" }) instanceof DynamoRecords);
  assert.ok(recordsFromEnv({ GOV_STORE: "postgres", DB_CLUSTER_ARN: "arn:c", DB_SECRET_ARN: "arn:s", DB_NAME: "d" }) instanceof PgRecords);
});

test("PgRecords.saveFindings: 트랜잭션 안에서 그 단계 Finding만 교체 (replaceStepFindings)", async () => {
  const { q, calls } = fake([[{ doc_id: "doc_X" }], [], [], []]);
  let inTx = 0;
  const r = new PgRecords(q, { query: q, tx: async (fn) => { inTx++; return fn(q); } });
  await r.saveFindings("doc_X", "SegmentBuild", [{ finding_id: "fnd_1", step: "SegmentBuild", severity: "HIGH", code: "NO_TEXT", message: "m", evidence_ref: "e", user_message: "글자를 찾지 못했습니다" }]);
  assert.equal(inTx, 1);
  assert.ok(calls.some((c) => /findings/u.test(c.sql)), "findings 테이블에 씀");
});
