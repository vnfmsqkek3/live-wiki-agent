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
