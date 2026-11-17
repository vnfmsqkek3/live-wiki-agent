import assert from "node:assert/strict";
import { test } from "node:test";
import { db, fromColumn, pgCode, toParam } from "./index.js";

test("toParam maps JS values to Data API parameters", () => {
  assert.deepEqual(toParam("a", "x"), { name: "a", value: { stringValue: "x" } });
  assert.deepEqual(toParam("a", 3), { name: "a", value: { longValue: 3 } });
  assert.deepEqual(toParam("a", 0.5), { name: "a", value: { doubleValue: 0.5 } });
  assert.deepEqual(toParam("a", false), { name: "a", value: { booleanValue: false } });
  assert.deepEqual(toParam("a", undefined), { name: "a", value: { isNull: true } });
  assert.deepEqual(toParam("a", ["G1"]), { name: "a", value: { stringValue: '["G1"]' }, typeHint: "JSON" });
});

test("fromColumn normalizes timestamptz, jsonb, arrays", () => {
  assert.equal(fromColumn("timestamptz", "2026-11-17 01:59:04.258"), "2026-11-17T01:59:04.258Z");
  assert.equal(fromColumn("timestamptz", "2026-11-17 10:59:04+09"), "2026-11-17T01:59:04.000Z");
  assert.deepEqual(fromColumn("jsonb", '{"a":[1]}'), { a: [1] });
  assert.deepEqual(fromColumn("_text", '{ALL,"여신 부"}'), ["ALL", "여신 부"]);
  assert.deepEqual(fromColumn("_text", "{}"), []);
  assert.deepEqual(fromColumn("_text", ["x"]), ["x"]);
  assert.equal(fromColumn("text", null), null);
});

test("query: parses formattedRecords with metadata; retries while DB resumes", async () => {
  let calls = 0;
  const client = { send: async (cmd) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("resuming"), { name: "DatabaseResumingException" });
    assert.equal(cmd.input.sql, "SELECT 1");
    return { formattedRecords: '[{"doc_id":"doc_1","attrs":"{\\"k\\":1}","updated_at":"2026-11-17 00:00:00"}]', columnMetadata: [{ name: "doc_id", typeName: "text" }, { name: "attrs", typeName: "jsonb" }, { name: "updated_at", typeName: "timestamptz" }] };
  } };
  const d = db({ resourceArn: "arn", secretArn: "s", database: "d", client, sleep: async () => {} });
  assert.deepEqual(await d.query("SELECT 1"), [{ doc_id: "doc_1", attrs: { k: 1 }, updated_at: "2026-11-17T00:00:00.000Z" }]);
  assert.equal(calls, 2);
});

test("tx: rollback on error, commit on success", async () => {
  const seen = [];
  const client = { send: async (cmd) => { seen.push(cmd.constructor.name); return cmd.constructor.name === "BeginTransactionCommand" ? { transactionId: "t1" } : {}; } };
  const d = db({ resourceArn: "arn", secretArn: "s", database: "d", client });
  await d.tx(async (q) => { await q("UPDATE x SET y = 1"); });
  await assert.rejects(d.tx(async () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(seen, ["BeginTransactionCommand", "ExecuteStatementCommand", "CommitTransactionCommand", "BeginTransactionCommand", "RollbackTransactionCommand"]);
});

test("pgCode extracts SQLState", () => {
  assert.equal(pgCode(new Error('ERROR: duplicate key value; SQLState: 23505')), "23505");
  assert.equal(pgCode(new Error("x")), undefined);
});

import { fromDocumentRow, replaceStepFindings, toDocumentRow, UPSERT_DOCUMENT_SQL } from "./index.js";

test("documents row mapping round-trips a DynamoDB item", () => {
  const item = { pk: "DOC#doc_1", sk: "META", doc_id: "doc_1", version: 2, owner: "u", title: "t", dept: "여신", acl_groups: ["ALL"], ext: "pdf", lifecycle: "PUBLISHED",
    authority_status: "VERIFIED", freshness: "CURRENT", created_at: "2026-11-17T00:00:00.000Z", updated_at: "2026-11-17T00:00:00.000Z",
    classification: { document_type: "KNOWHOW" }, summary: "요약", findings: [{ finding_id: "fnd_1", step: "PiiScan", severity: "LOW", code: "X", message: "m", evidence_ref: "e" }] };
  const row = toDocumentRow(item);
  assert.equal(row.pk, undefined); assert.equal(row.findings, undefined);
  assert.deepEqual(row.attrs, { classification: { document_type: "KNOWHOW" }, summary: "요약" });
  const back = fromDocumentRow({ ...row, document_type: null }, [{ finding_id: "fnd_1", step: "PiiScan", severity: "LOW", code: "X", data: { message: "m", evidence_ref: "e" } }]);
  const { pk, sk, ...expected } = item; void pk; void sk;
  assert.deepEqual(back, expected);
  assert.ok(!("document_type" in back));
  assert.match(UPSERT_DOCUMENT_SQL, /ON CONFLICT \(doc_id\) DO UPDATE SET version = EXCLUDED.version/);
  assert.match(UPSERT_DOCUMENT_SQL, /:created_at::timestamptz/);
});

test("replaceStepFindings locks, deletes the step, inserts", async () => {
  const sqls = [];
  const q = async (sql) => { sqls.push(sql.split(" ").slice(0, 2).join(" ")); return [{ doc_id: "doc_1" }]; };
  await replaceStepFindings(q, "doc_1", "PageRender", [{ finding_id: "fnd_1", step: "PageRender", severity: "MEDIUM", code: "C", message: "m" }]);
  assert.deepEqual(sqls, ["SELECT doc_id", "DELETE FROM", "INSERT INTO", "UPDATE documents"]);
  await assert.rejects(replaceStepFindings(async () => [], "doc_x", "S", []), /DocumentNotFound/);
});
