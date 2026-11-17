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

const RETRYABLE = /DatabaseResuming|Communications link failure|is resuming/i;

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
    const r = await send(new ExecuteStatementCommand({
      resourceArn, secretArn, database, sql, transactionId,
      parameters: Object.entries(params).map(([k, v]) => toParam(k, v)),
      formatRecordsAs: "JSON", includeResultMetadata: true,
    }));
    if (!r.formattedRecords) return [];
    const types = Object.fromEntries((r.columnMetadata ?? []).map((c) => [c.label ?? c.name, c.typeName]));
    return JSON.parse(r.formattedRecords).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fromColumn(types[k], v)])));
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
