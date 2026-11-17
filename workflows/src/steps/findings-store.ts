// Documents 레코드(pk=DOC#{doc_id}, sk=META, 테이블 Owner dhxorb96)의 findings 에서 해당 단계 것만 교체한다.
// 같은 문서를 병렬 단계가 동시에 고칠 수 있어 updated_at 조건부 쓰기 + 재시도.
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { db, fromDocumentRow, replaceStepFindings, type Db } from "@hanaeum/db";
import type { Finding } from "./common.js";

export type FindingsStore = (doc_id: string, step: string, findings: Finding[]) => Promise<void>;

export function dynamoFindingsStore(db: DynamoDBDocumentClient, table: string): FindingsStore {
  return async (doc_id, step, findings) => {
    const Key = { pk: `DOC#${doc_id}`, sk: "META" };
    for (let attempt = 0; attempt < 5; attempt++) {
      const doc = (await db.send(new GetCommand({ TableName: table, Key, ConsistentRead: true }))).Item;
      if (!doc) throw new Error(`DocumentNotFound: ${doc_id}`); // type-detection 이 먼저 만든다
      const next = [...((doc.findings as Finding[] | undefined) ?? []).filter((f) => f.step !== step), ...findings];
      try {
        await db.send(new UpdateCommand({
          TableName: table, Key,
          UpdateExpression: "SET findings = :f, updated_at = :now",
          ConditionExpression: "updated_at = :prev",
          ExpressionAttributeValues: { ":f": next, ":now": new Date().toISOString(), ":prev": doc.updated_at },
        }));
        return;
      } catch (e) {
        if (!(e instanceof ConditionalCheckFailedException)) throw e;
      }
    }
    throw new Error(`FindingsWriteConflict: ${doc_id}`);
  };
}

// ---------- 거버넌스 저장소 선택 (interfaces.md 10장, GOV_STORE=dynamo|postgres) ----------
// postgres: 문서 행 잠금 트랜잭션으로 단계 findings 교체 (@hanaeum/db replaceStepFindings)
export function pgFindingsStore(d: Db): FindingsStore {
  return (doc_id, step, findings) => d.tx((q) => replaceStepFindings(q, doc_id, step, findings));
}

const usePg = () => process.env.GOV_STORE === "postgres";
let ddb: DynamoDBDocumentClient | undefined;
const dynamo = () => (ddb ??= DynamoDBDocumentClient.from(new DynamoDBClient({})));
let pg: Db | undefined;
const pgDb = () => (pg ??= db());

/** 단계 Lambda 공통: 현재 설정의 findings 저장소 */
export function findingsStore(): FindingsStore {
  return usePg() ? pgFindingsStore(pgDb()) : dynamoFindingsStore(dynamo(), process.env.TABLE_DOCUMENTS ?? "");
}

/** 단계 Lambda 공통: 문서 레코드 읽기 (findings 포함, DynamoDB 때와 같은 모양) */
export async function getDocument<T = Record<string, unknown>>(doc_id: string): Promise<T | undefined> {
  if (!usePg()) {
    return (await dynamo().send(new GetCommand({ TableName: process.env.TABLE_DOCUMENTS, Key: { pk: `DOC#${doc_id}`, sk: "META" }, ConsistentRead: true }))).Item as T | undefined;
  }
  const [row] = await pgDb().query("SELECT * FROM documents WHERE doc_id = :doc_id", { doc_id });
  if (!row) return undefined;
  return fromDocumentRow<T>(row, await pgDb().query("SELECT * FROM findings WHERE doc_id = :doc_id ORDER BY created_at, finding_id", { doc_id }));
}
