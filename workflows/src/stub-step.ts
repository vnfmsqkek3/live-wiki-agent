// 단계 Owner 의 Lambda 가 배포되기 전까지 쓰는 dev 전용 stub (mock).
// 모든 단계는 { status: "OK" } 를 돌려준다.
// WaitForApproval 은 task_token 을 워크플로 테이블에 저장만 한다. 승인은 사람이 workflows/scripts/smoke-dev.sh 처럼 SendTaskSuccess 로 보낸다.
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

export type StepInput = { workflow_id: string; doc_id: string; task_token?: string };

type Send = (cmd: PutItemCommand) => Promise<unknown>;

export function makeHandler(send: Send, table: string) {
  return async (event: StepInput) => {
    if (event.task_token) {
      await send(
        new PutItemCommand({
          TableName: table,
          Item: {
            pk: { S: `WF#${event.workflow_id}` },
            sk: { S: "APPROVAL_TOKEN" },
            doc_id: { S: event.doc_id },
            task_token: { S: event.task_token },
          },
        }),
      );
      return { status: "PENDING" };
    }
    return { status: "OK" };
  };
}

const client = new DynamoDBClient({});
export const handler = makeHandler((c) => client.send(c), process.env.TABLE_WORKFLOWS ?? "");
