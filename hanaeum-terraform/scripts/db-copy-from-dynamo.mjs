#!/usr/bin/env node
// 거버넌스 데이터 1회 복사 DynamoDB → Aurora PostgreSQL (interfaces.md 10장 전환 절차). 여러 번 돌려도 같은 결과(멱등).
// documents·findings·drafts·approvals·feedback 은 upsert, audit_events 는 대상이 비어 있을 때만 복사(추가 전용 테이블).
// 사용: set -a; . ./.env.local; set +a; node hanaeum-terraform/scripts/db-copy-from-dynamo.mjs dev [--apply]   (기본은 건수만 출력)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { db, replaceStepFindings, toDocumentRow, UPSERT_DOCUMENT_SQL } from "@hanaeum/db";

const env = process.argv[2] ?? "dev";
const apply = process.argv.includes("--apply");
const ssm = new SSMClient({});
const p = async (n) => (await ssm.send(new GetParameterCommand({ Name: `/hanaeum-mvp/${env}/${n}` }))).Parameter.Value;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
async function scan(TableName) {
  const out = []; let ExclusiveStartKey;
  do { const r = await ddb.send(new ScanCommand({ TableName, ExclusiveStartKey })); out.push(...(r.Items ?? [])); ExclusiveStartKey = r.LastEvaluatedKey; } while (ExclusiveStartKey);
  return out;
}

const [docsT, aprT, fbT, audT] = await Promise.all(["TABLE_DOCUMENTS", "TABLE_APPROVALS", "TABLE_FEEDBACK", "TABLE_AUDIT_EVENTS"].map(p));
const d = db({ resourceArn: await p("DB_CLUSTER_ARN"), secretArn: await p("DB_SECRET_ARN"), database: await p("DB_NAME") });
const items = await scan(docsT);
const docs = items.filter((i) => i.sk === "META");
const drafts = items.filter((i) => String(i.sk).startsWith("DRAFT#"));
const approvals = (await scan(aprT)).filter((i) => String(i.pk).startsWith("APR#"));
const feedback = await scan(fbT);
const audits = await scan(audT);
console.log(JSON.stringify({ env, documents: docs.length, findings: docs.reduce((n, x) => n + (x.findings?.length ?? 0), 0), drafts: drafts.length, approvals: approvals.length, feedback: feedback.length, audit_events: audits.length }));
if (!apply) { console.log("(건수만. 복사하려면 --apply)"); process.exit(0); }

const now = new Date().toISOString();
let n = 0;
for (const x of docs) {
  // 옛 항목 보정: 필수 열 기본값 (스키마 CHECK 를 통과하도록, 값은 바꾸지 않고 비어 있는 것만)
  const row = toDocumentRow({ authority_status: "UNVERIFIED", freshness: "CURRENT", dept: "", ext: "", title: x.doc_id, created_at: x.updated_at ?? now, updated_at: x.created_at ?? now, ...x });
  await d.tx(async (q) => {
    await q(UPSERT_DOCUMENT_SQL, row);
    // 단계별 교체 함수로 모든 단계의 findings 를 그대로 옮긴다
    const bySteps = new Map();
    for (const f of x.findings ?? []) bySteps.set(f.step, [...(bySteps.get(f.step) ?? []), f]);
    await q("DELETE FROM findings WHERE doc_id = :doc_id", { doc_id: x.doc_id });
    for (const [step, fs] of bySteps) await replaceStepFindings(q, x.doc_id, step, fs);
    await q("UPDATE documents SET updated_at = :u::timestamptz WHERE doc_id = :doc_id", { doc_id: x.doc_id, u: row.updated_at }); // replaceStepFindings 의 now() 되돌림
  });
  if (++n % 25 === 0) console.log(`  documents ${n}/${docs.length}`);
}
const ids = new Set(docs.map((x) => x.doc_id));
for (const x of drafts.filter((x) => ids.has(x.doc_id)))
  await d.query("INSERT INTO drafts (draft_id, doc_id, base_version, proposed_text, basis, created_by, status, created_at) VALUES (:draft_id, :doc_id, :base_version, :proposed_text, ARRAY(SELECT jsonb_array_elements_text(:basis::jsonb)), :created_by, :status, :created_at::timestamptz) ON CONFLICT (draft_id) DO NOTHING",
    { draft_id: x.draft_id, doc_id: x.doc_id, base_version: x.base_version, proposed_text: x.proposed_text, basis: x.basis ?? [], created_by: x.created_by, status: x.status ?? "DRAFT", created_at: x.created_at });
let skipped = 0;
for (const a of approvals) {
  if (!ids.has(a.doc_id)) { skipped++; continue; } // 문서가 없는 승인(시험 잔여)은 FK 위반 → 건너뜀
  await d.query(`INSERT INTO approvals (approval_id, doc_id, version, s3_version_id, content_hash, author_sub, approver_sub, status, reason, decided_at, created_at)
    VALUES (:approval_id, :doc_id, :version, :s3_version_id, :content_hash, :author_sub, :approver_sub, :status, :reason, :decided_at::timestamptz, :created_at::timestamptz)
    ON CONFLICT (approval_id) DO UPDATE SET status = EXCLUDED.status, approver_sub = EXCLUDED.approver_sub, reason = EXCLUDED.reason, decided_at = EXCLUDED.decided_at`,
    { approval_id: a.approval_id, doc_id: a.doc_id, version: a.version, s3_version_id: a.s3_version_id ?? "", content_hash: a.content_hash ?? "", author_sub: a.author_sub,
      approver_sub: a.approver_sub ?? null, status: a.status, reason: a.reason ?? null, decided_at: a.status === "PENDING" ? null : (a.decided_at ?? a.created_at), created_at: a.created_at });
}
for (const f of feedback.filter((f) => ids.has(f.doc_id)))
  await d.query("INSERT INTO feedback (doc_id, user_sub, stars, useful, updated_at) VALUES (:doc_id, :user_sub, :stars, :useful, :updated_at::timestamptz) ON CONFLICT (doc_id, user_sub) DO UPDATE SET stars = EXCLUDED.stars, useful = EXCLUDED.useful, updated_at = EXCLUDED.updated_at",
    { doc_id: f.doc_id, user_sub: f.user_sub, stars: f.stars ?? null, useful: !!f.useful, updated_at: f.updated_at });
const [{ c }] = await d.query("SELECT count(*)::int AS c FROM audit_events");
if (c === 0) {
  for (const e of audits.sort((a, b) => String(a.at).localeCompare(String(b.at))))
    await d.query("INSERT INTO audit_events (at, actor, action, resource, result, trace_id, detail) VALUES (:at::timestamptz, :actor, :action, :resource, :result, :trace_id, :detail::jsonb)",
      { at: e.at, actor: e.actor ?? "", action: e.action ?? "", resource: e.resource ?? "", result: e.result === "DENIED" ? "DENIED" : "OK", trace_id: e.trace_id ?? "", detail: Object.fromEntries(Object.entries(e).filter(([k]) => !["pk", "sk", "at", "actor", "action", "resource", "result", "trace_id"].includes(k))) });
}
const counts = await d.query("SELECT (SELECT count(*) FROM documents)::int AS documents, (SELECT count(*) FROM findings)::int AS findings, (SELECT count(*) FROM drafts)::int AS drafts, (SELECT count(*) FROM approvals)::int AS approvals, (SELECT count(*) FROM feedback)::int AS feedback, (SELECT count(*) FROM audit_events)::int AS audit_events");
console.log(JSON.stringify({ copied: counts[0], approvals_skipped_no_document: skipped, audit_copied: c === 0 }));
