// 오케스트레이터의 AWS 연결: 파이프라인 Gateway(inbound AWS_IAM)를 SigV4로 MCP tools/call, WORKFLOWS 단계 기록.
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { PipelineDeps, StepOutput } from './orchestrator.ts';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };
const region = () => env('AWS_REGION');

let id = 0;
/** Gateway MCP tools/call (SigV4, service bedrock-agentcore). interfaces.md 6.1: Tool 이름 `{target}___{단계키}`, target = 단계 키의 `_`→`-` (예 `malware-check___malware_check`) */
export async function callTool(step: string, args: Record<string, unknown>): Promise<StepOutput> {
  const url = new URL(env('PIPELINE_GATEWAY_URL'));
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: `${step.replace(/_/g, '-')}___${step}`, arguments: args } });
  const signer = new SignatureV4({ service: 'bedrock-agentcore', region: region(), credentials: defaultProvider(), sha256: Sha256 });
  const req = await signer.sign({
    method: 'POST', protocol: url.protocol, hostname: url.hostname, path: url.pathname,
    headers: { host: url.hostname, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body,
  });
  const r = await fetch(url, { method: 'POST', headers: req.headers as Record<string, string>, body, signal: AbortSignal.timeout(900_000) });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`gateway ${r.status}`), { name: 'GatewayError' });
  const json = JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : text) as {
    error?: { message: string }; result?: { isError?: boolean; content?: { type: string; text?: string }[] };
  };
  if (json.error) throw Object.assign(new Error(json.error.message.slice(0, 200)), { name: 'ToolError' });
  const out = json.result?.content?.find((c) => c.type === 'text')?.text ?? '{}';
  const parsed = JSON.parse(out) as StepOutput & { errorType?: string; errorMessage?: string };
  if (json.result?.isError || parsed.errorType) throw Object.assign(new Error((parsed.errorMessage ?? 'step failed').slice(0, 300)), { name: parsed.errorType ?? 'StepError' });
  return parsed;
}

let ddb: DynamoDBClient | undefined;
export async function record(workflow_id: string, doc_id: string, step: string, status: string, error?: string, message?: string) {
  ddb ??= new DynamoDBClient({ region: region() });
  await ddb.send(new PutItemCommand({
    TableName: env('TABLE_WORKFLOWS'),
    Item: {
      pk: { S: `WF#${workflow_id}` }, sk: { S: step === 'EXECUTION' ? 'EXECUTION' : `STEP#${step}` },
      doc_id: { S: doc_id }, status: { S: status }, ended_at: { S: new Date().toISOString() },
      ...(error ? { error: { S: error } } : {}), // 원문·Cause는 기록하지 않는다
      ...(message ? { message: { S: message } } : {}), // Tool 오류 문장(let522mj: '사유 (조치: …)'). 화면 표시 여부는 API가 정한다
    },
  }));
}

const STALE_MS = 30 * 60_000; // 30분 넘게 RUNNING이면 죽은 실행으로 보고 다시 허용

/** WORKFLOWS `WF#{id}` / `LOCK#{phase}` 조건부 쓰기. 없거나 FAILED거나 오래된 RUNNING일 때만 가져간다 (DONE이면 중복 실행) */
export async function claim(workflow_id: string, phase: string): Promise<boolean> {
  ddb ??= new DynamoDBClient({ region: region() });
  try {
    await ddb.send(new PutItemCommand({
      TableName: env('TABLE_WORKFLOWS'),
      Item: { pk: { S: `WF#${workflow_id}` }, sk: { S: `LOCK#${phase}` }, status: { S: 'RUNNING' }, started_at: { S: new Date().toISOString() } },
      ConditionExpression: 'attribute_not_exists(pk) OR #s = :failed OR (#s = :running AND started_at < :stale)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':failed': { S: 'FAILED' }, ':running': { S: 'RUNNING' }, ':stale': { S: new Date(Date.now() - STALE_MS).toISOString() } },
    }));
    return true;
  } catch (e) {
    if ((e as Error).name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}
export async function release(workflow_id: string, phase: string, status: 'DONE' | 'FAILED') {
  ddb ??= new DynamoDBClient({ region: region() });
  await ddb.send(new PutItemCommand({ TableName: env('TABLE_WORKFLOWS'), Item: { pk: { S: `WF#${workflow_id}` }, sk: { S: `LOCK#${phase}` }, status: { S: status }, ended_at: { S: new Date().toISOString() } } }));
}

export const awsDeps: PipelineDeps = { callTool, record, claim, release, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), referenceCheck: process.env.REFERENCE_CHECK === 'on', imageDescribe: process.env.IMAGE_DESCRIBE === 'on', pageSummarize: process.env.PAGE_SUMMARIZE === 'on' };
