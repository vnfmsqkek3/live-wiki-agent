// Documents 레코드(pk=DOC#{doc_id}, sk=META, 테이블 Owner dhxorb96)의 findings 에서 해당 단계 것만 교체한다.
// 같은 문서를 병렬 단계가 동시에 고칠 수 있어 updated_at 조건부 쓰기 + 재시도.
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
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
