// EventBridge "Step Functions Execution Status Change" (FAILED/TIMED_OUT/ABORTED) 수신.
// ASL Catch 를 우회한 실패(타임아웃, 수동 중단, Record 단계 실패)까지 워크플로 테이블에 남긴다 (docs/04 1.2).
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

export type SfnStatusEvent = {
  detail: { executionArn: string; name: string; status: string; stopDate?: number | null; error?: string | null };
};

type Send = (cmd: PutItemCommand) => Promise<unknown>;

export function makeHandler(send: Send, table: string) {
  return async (event: SfnStatusEvent) => {
    const d = event.detail;
    await send(
      new PutItemCommand({
        TableName: table,
        Item: {
          pk: { S: `WF#${d.name}` }, // 실행 이름 = workflow_id
          sk: { S: "EXECUTION" },
          status: { S: d.status },
          error: { S: d.error ?? "" }, // cause 는 원문 노출 위험이 있어 기록하지 않음
          execution_arn: { S: d.executionArn },
          ended_at: { S: new Date(d.stopDate ?? Date.now()).toISOString() },
        },
      }),
    );
    return { recorded: d.name, status: d.status };
  };
}

const client = new DynamoDBClient({});
export const handler = makeHandler((c) => client.send(c), process.env.TABLE_WORKFLOWS ?? "");
