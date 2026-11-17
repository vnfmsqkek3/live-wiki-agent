// 거버넌스 저장소(Aurora PostgreSQL) RDS Data API 클라이언트. Owner yoyo0704. 계약: docs/interfaces.md 10장
import { BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand, RDSDataClient, RollbackTransactionCommand } from "@aws-sdk/client-rds-data";

/** JS 값 → Data API 파라미터 */
export function toParam(name, v) {
  if (v === null || v === undefined) return { name, value: { isNull: true } };
  if (typeof v === "string") return { name, value: { stringValue: v } };
  if (typeof v === "boolean") return { name, value: { booleanValue: v } };
  if (typeof v === "number") return Number.isInteger(v) ? { name, value: { longValue: v } } : { name, value: { doubleValue: v } };
  return { name, value: { stringValue: JSON.stringify(v) }, typeHint: "JSON" };
}

/** Data API Field → JS 값 */
export function fieldValue(f) {
  if (!f || f.isNull) return null;
  if ("stringValue" in f) return f.stringValue;
  if ("longValue" in f) return Number(f.longValue);
  if ("doubleValue" in f) return f.doubleValue;
  if ("booleanValue" in f) return f.booleanValue;
  if ("arrayValue" in f) {
    const a = f.arrayValue;
    return a.stringValues ?? a.longValues?.map(Number) ?? a.doubleValues ?? a.booleanValues ?? (a.arrayValues ?? []).map((x) => fieldValue({ arrayValue: x }));
  }
  if ("blobValue" in f) return f.blobValue;
  return null;
}

const PG_ARRAY = /^\{(.*)\}$/s;
/** PostgreSQL 배열 리터럴 {a,"b c"} → JS 배열 (Data API 가 문자열로 줄 때) */
function pgArray(s) {
  const m = PG_ARRAY.exec(s);
  if (!m) return s;
  if (m[1] === "") return [];
  const out = [];
  for (const t of m[1].match(/"((?:[^"\\]|\\.)*)"|[^,]+/g) ?? []) out.push(t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, "$1") : t === "NULL" ? null : t);
  return out;
}

/** 결과 값 정규화: 열 타입 기준 (timestamptz → ISO Z, jsonb → 객체, 배열 → JS 배열) */
export function fromColumn(typeName, v) {
  if (v === null || v === undefined) return null;
  const t = (typeName ?? "").toLowerCase();
  if ((t === "timestamptz" || t === "timestamp") && typeof v === "string") {
    // Data API: "2026-11-17 01:59:04.258"(UTC, 오프셋 없음) 또는 "…+09" → JS 가 읽는 "+09:00" 으로
    const iso = v.replace(" ", "T").replace(/([+-]\d\d)(\d\d)?$/, (_m, h, mm) => `${h}:${mm ?? "00"}`);
    return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`).toISOString();
  }
  if ((t === "jsonb" || t === "json") && typeof v === "string") return JSON.parse(v);
  if (t.startsWith("_") && typeof v === "string") return pgArray(v);
  return v;
}

// 요청이 DB 에 닿지 않은 경우만 재시도. Communications link failure 는 실행 여부를 알 수 없어 제외 (감사 INSERT 중복 위험, let522mj 리뷰)
const RETRYABLE = /DatabaseResuming|is resuming/i;

export function db(cfg = {}) {
  const resourceArn = cfg.resourceArn ?? process.env.DB_CLUSTER_ARN;
  const secretArn = cfg.secretArn ?? process.env.DB_SECRET_ARN;
  const database = cfg.database ?? process.env.DB_NAME;
  const client = cfg.client ?? new RDSDataClient({});
  const sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!resourceArn || !secretArn || !database) throw new Error("DB_CLUSTER_ARN·DB_SECRET_ARN·DB_NAME 필요");

  async function send(cmd) {
    for (let i = 0; ; i++) {
      try { return await client.send(cmd); }
      catch (e) {
        if (i >= 11 || !RETRYABLE.test(`${e?.name} ${e?.message}`)) throw e;
        await sleep(5000); // ponytail: 고정 5초 × 12회 = 60초. 재개가 더 걸리면 min_acu > 0
      }
    }
  }

  async function query(sql, params = {}, transactionId) {
    // formatRecordsAs JSON 은 열 타입(columnMetadata)을 주지 않는다 (11/17 실측) → 타입이 있는 기본 레코드 형식
    const r = await send(new ExecuteStatementCommand({
      resourceArn, secretArn, database, sql, transactionId,
      parameters: Object.entries(params).map(([k, v]) => toParam(k, v)),
      includeResultMetadata: true,
    }));
    const cols = (r.columnMetadata ?? []).map((c) => [c.label || c.name, c.typeName]);
    return (r.records ?? []).map((rec) => Object.fromEntries(rec.map((f, i) => [cols[i][0], fromColumn(cols[i][1], fieldValue(f))])));
  }

  /** 트랜잭션: fn 이 throw 하면 롤백. fn 안에서는 받은 q 만 쓴다 */
  async function tx(fn) {
    const { transactionId } = await send(new BeginTransactionCommand({ resourceArn, secretArn, database }));
    try {
      const out = await fn((sql, params) => query(sql, params, transactionId));
      await send(new CommitTransactionCommand({ resourceArn, secretArn, transactionId }));
      return out;
    } catch (e) {
      await send(new RollbackTransactionCommand({ resourceArn, secretArn, transactionId })).catch(() => {});
      throw e;
    }
  }

  return { query: (sql, params) => query(sql, params), tx };
}

/** 고유·조건 위반(23505 unique, 23503 FK, 23514 CHECK) 판별: Data API 는 오류 메시지에 SQLState 를 담는다 */
export const pgCode = (e) => /SQLState: (\w{5})/.exec(String(e?.message))?.[1];

// ---------- documents 행 ↔ DocumentRecord (세 Owner 공통 변환. 스키마 db/migrations/001) ----------
/** 열로 둔 필드. 나머지는 attrs jsonb (findings 는 별도 테이블) */
export const DOC_COLUMNS = ["doc_id", "version", "owner", "title", "dept", "acl_groups", "ext", "lifecycle", "document_type", "authority_status", "freshness",
  "trust_gate_result", "workflow_id", "s3_version_id", "content_hash", "published_content_hash", "law_id", "revision_id", "created_at", "updated_at"];
const DROP = new Set(["pk", "sk", "gsi1pk", "gsi1sk", "findings"]);

/** DocumentRecord(또는 DynamoDB 항목) → { 열 값, attrs } */
export function toDocumentRow(doc) {
  const row = {}; const attrs = {};
  for (const [k, v] of Object.entries(doc)) {
    if (DROP.has(k) || v === undefined) continue;
    if (DOC_COLUMNS.includes(k)) row[k] = v; else attrs[k] = v;
  }
  for (const c of DOC_COLUMNS) if (!(c in row)) row[c] = null; // UPSERT_DOCUMENT_SQL 이 모든 열 파라미터를 요구 (11/17 실측: Cannot find parameter)
  row.acl_groups = row.acl_groups ?? [];
  return { ...row, attrs };
}

/** documents 행(+ findings 행) → DocumentRecord. null 열은 키를 만들지 않는다 (DynamoDB 때와 같은 모양) */
export function fromDocumentRow(row, findingRows = []) {
  const doc = { ...(row.attrs ?? {}) };
  for (const k of DOC_COLUMNS) if (row[k] !== null && row[k] !== undefined) doc[k] = row[k];
  doc.findings = findingRows.map((f) => ({ finding_id: f.finding_id, step: f.step, severity: f.severity, code: f.code, ...(f.data ?? {}) }));
  return doc;
}

/** Finding → findings 행 */
export function toFindingRow(doc_id, f) {
  const { finding_id, step, severity, code, ...data } = f;
  return { finding_id, doc_id, step, severity, code, data };
}

/** documents upsert SQL (created_at 외 전체 열 교체 — DynamoDB PutItem 과 같은 의미). 파라미터는 toDocumentRow 결과 그대로 */
export const UPSERT_DOCUMENT_SQL = `INSERT INTO documents (${DOC_COLUMNS.join(", ")}, attrs) VALUES (` +
  DOC_COLUMNS.map((c) => c === "acl_groups" ? "ARRAY(SELECT jsonb_array_elements_text(:acl_groups::jsonb))" : c.endsWith("_at") ? `:${c}::timestamptz` : `:${c}`).join(", ") +
  `, :attrs::jsonb) ON CONFLICT (doc_id) DO UPDATE SET ` + [...DOC_COLUMNS.filter((c) => c !== "doc_id" && c !== "created_at"), "attrs"].map((c) => `${c} = EXCLUDED.${c}`).join(", ");

/** 한 단계의 findings 교체 (문서 행 잠금으로 병렬 단계 직렬화). q 는 tx 안의 query */
export async function replaceStepFindings(q, doc_id, step, findings) {
  const locked = await q("SELECT doc_id FROM documents WHERE doc_id = :doc_id FOR UPDATE", { doc_id });
  if (!locked.length) throw new Error(`DocumentNotFound: ${doc_id}`);
  await q("DELETE FROM findings WHERE doc_id = :doc_id AND step = :step", { doc_id, step });
  for (const f of findings) {
    const r = toFindingRow(doc_id, f);
    await q("INSERT INTO findings (finding_id, doc_id, step, severity, code, data) VALUES (:finding_id, :doc_id, :step, :severity, :code, :data::jsonb) ON CONFLICT (finding_id) DO UPDATE SET step = EXCLUDED.step, severity = EXCLUDED.severity, code = EXCLUDED.code, data = EXCLUDED.data", r);
  }
  await q("UPDATE documents SET updated_at = now() WHERE doc_id = :doc_id", { doc_id });
}
