// API 서버와 단계 Lambda가 함께 쓰는 AWS 어댑터. 값은 환경변수(SSM에서 주입)로만 받는다.
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { DocumentRecord } from './contracts.ts';
import { memoryStore, type Store } from './store.ts';
import { dynamoStore } from './store-dynamo.ts';

export const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const region = () => env('AWS_REGION');
// 운영 교훈 #1: 리전 명시 + SigV4 + virtual-hosted → 307 리다이렉트(CORS 오류처럼 보임) 방지
let s3c: S3Client | undefined;
const s3 = () => (s3c ??= new S3Client({ region: region(), forcePathStyle: false }));

export const quarantineKey = (d: Pick<DocumentRecord, 'doc_id' | 'ext'>) => `${d.doc_id}/original.${d.ext}`;

export function storeFromEnv(): Store {
  const e = process.env;
  if (!e.TABLE_DOCUMENTS) return memoryStore(); // ponytail: 로컬 단독 실행용
  return dynamoStore({ documents: env('TABLE_DOCUMENTS'), approvals: env('TABLE_APPROVALS'), feedback: env('TABLE_FEEDBACK'), audit: env('TABLE_AUDIT_EVENTS') });
}

export const presignPut = (key: string, len: number) =>
  getSignedUrl(s3(), new PutObjectCommand({ Bucket: env('BUCKET_QUARANTINE'), Key: key, ContentLength: len }), { expiresIn: 300 });

export async function headObject(key: string) {
  try {
    const h = await s3().send(new HeadObjectCommand({ Bucket: env('BUCKET_QUARANTINE'), Key: key }));
    if (!h.VersionId) return undefined; // 버킷 버전관리 필수. 버전 ID는 불변이라 "검사 후 변경" 판정 기준
    return { s3_version_id: h.VersionId };
  } catch (e) {
    if ((e as { name?: string }).name === 'NotFound') return undefined;
    throw e;
  }
}

/** 객체 바이트. range가 있으면 앞부분만 (type-detection은 8KB). versionId로 검사 대상 버전을 고정한다 */
export async function getObjectBytes(key: string, versionId?: string, range?: number) {
  const r = await s3().send(new GetObjectCommand({ Bucket: env('BUCKET_QUARANTINE'), Key: key, VersionId: versionId, Range: range ? `bytes=0-${range - 1}` : undefined }));
  return new Uint8Array(await r.Body!.transformToByteArray());
}

// ---- AgentCore 오케스트레이터 (사용자 결정 11/16: Step Functions 폐기) ----
const stepInput = (d: DocumentRecord) => ({
  workflow_id: d.workflow_id, doc_id: d.doc_id, version: d.version, bucket: env('BUCKET_QUARANTINE'), prefix: `${d.doc_id}/`, actor: { sub: d.owner, groups: ['AUTHOR'] },
});
export async function invokePipeline(payload: Record<string, unknown>, workflow_id: string) {
  const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = await import('@aws-sdk/client-bedrock-agentcore');
  const r = await new BedrockAgentCoreClient({ region: region() }).send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: env('PIPELINE_RUNTIME_ARN'), qualifier: 'DEFAULT',
    runtimeSessionId: `pipeline-${workflow_id}-${Date.now()}`.padEnd(40, '0'), // 실행마다 새 세션 (상태는 DynamoDB)
    contentType: 'application/json', accept: 'application/json', payload: new TextEncoder().encode(JSON.stringify(payload)),
  }));
  if ((r.statusCode ?? 200) >= 300) throw new Error(`pipeline runtime ${r.statusCode}`);
}

/** 문서 처리 시작: AgentCore 오케스트레이터 start (실행 세션마다 새 ID, 상태는 DynamoDB) */
export async function startWorkflow(d: DocumentRecord) {
  await invokePipeline({ action: 'start', input: stepInput(d) }, d.workflow_id!);
}

/** 사람 결정 후 재개: AgentCore 오케스트레이터 resume. 이전 SFN task token은 무시한다 */
export async function resume(d: DocumentRecord, decision: 'APPROVE' | 'REJECT' | 'REVALIDATE') {
  if (!d.workflow_id) return false;
  await invokePipeline({ action: 'resume', decision, input: stepInput(d) }, d.workflow_id);
  return true;
}

/** 가이드 Agent 호출. AGENT_RUNTIME_ARN이면 AgentCore Runtime(JWT authorizer), AGENT_URL이면 로컬 컨테이너 */
export async function invokeAgent(question: string, accessToken: string, stream = false) {
  const arn = process.env.AGENT_RUNTIME_ARN;
  const url = arn
    ? `https://bedrock-agentcore.${region()}.amazonaws.com/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`
    : env('AGENT_URL');
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(stream ? { accept: 'text/event-stream' } : {}),
      authorization: `Bearer ${accessToken}`,
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': `guide-${crypto.randomUUID()}`, // 요청마다 독립 세션 (Memory 미사용)
    },
    body: JSON.stringify({ prompt: question }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`agent ${r.status}`);
  return stream ? r.body! : r.json();
}
/** 스트리밍 가이드: Runtime SSE 본문을 그대로 넘긴다 */
export const invokeAgentStream = (question: string, accessToken: string) => invokeAgent(question, accessToken, true) as Promise<ReadableStream<Uint8Array>>;

/** WORKFLOWS 테이블에서 실패한 단계 (오류 이름만, 원문 없음) */
export async function workflowFailure(workflow_id: string) {
  const { DynamoDBClient, QueryCommand } = await import('@aws-sdk/client-dynamodb');
  const r = await new DynamoDBClient({ region: region() }).send(new QueryCommand({
    TableName: env('TABLE_WORKFLOWS'), KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': { S: `WF#${workflow_id}` } },
  }));
  const failed = (r.Items ?? []).find((i) => i.status?.S === 'FAILED' && i.sk?.S?.startsWith('STEP#'));
  return failed ? { step: failed.sk!.S!.slice(5), error: failed.error?.S ?? 'Unknown' } : undefined;
}

// ---- quarantine 버킷 JSON 입출력 (단계 6·7·8) ----
export async function listKeys(prefix: string) {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const out: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const r = await s3().send(new ListObjectsV2Command({ Bucket: env('BUCKET_QUARANTINE'), Prefix: prefix, ContinuationToken }));
    for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
    ContinuationToken = r.NextContinuationToken;
  } while (ContinuationToken);
  return out.sort();
}
export async function getJson<T>(key: string): Promise<T> {
  const r = await s3().send(new GetObjectCommand({ Bucket: env('BUCKET_QUARANTINE'), Key: key }));
  return JSON.parse(await r.Body!.transformToString()) as T;
}
export async function putJson(key: string, v: unknown) {
  await s3().send(new PutObjectCommand({ Bucket: env('BUCKET_QUARANTINE'), Key: key, Body: JSON.stringify(v), ContentType: 'application/json' }));
}

/** Guardrails ApplyGuardrail (모델 추론 아님). GUARDRAIL_ID 없으면 undefined → 정규식 단계만 */
export async function applyGuardrail(text: string) {
  const id = process.env.GUARDRAIL_ID;
  if (!id) return undefined;
  const { ApplyGuardrailCommand, BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
  const r = await new BedrockRuntimeClient({ region: region() }).send(new ApplyGuardrailCommand({
    guardrailIdentifier: id, // INPUT은 ANONYMIZE를 적용하지 않음(실측 11/16: action NONE). 마스킹 결과를 받으려면 OUTPUT
    guardrailVersion: process.env.GUARDRAIL_VERSION ?? 'DRAFT', source: 'OUTPUT', content: [{ text: { text } }],
  }));
  // 탐지 값(match)과 유형만 돌려준다. 원문 덮어쓰기 여부는 호출자가 유형별로 정한다 (규정 원문 훼손 방지, 11/17)
  const entities = (r.assessments ?? []).flatMap((a) => [
    ...(a.sensitiveInformationPolicy?.piiEntities ?? []).map((e) => ({ type: String(e.type), match: e.match ?? '' })),
    ...(a.sensitiveInformationPolicy?.regexes ?? []).map((e) => ({ type: `REGEX_${e.name}`, match: e.match ?? '' })),
  ]).filter((e) => e.match);
  return { text: r.outputs?.[0]?.text ?? text, detected: entities.length, entities };
}

/** 문서보관함: 마스킹본 페이지만 읽는다 (masked/segments). 원본·work는 읽지 않는다 */
export async function pages(doc_id: string) {
  const keys = (await listKeys(`${doc_id}/masked/segments/`)).filter((k) => k.endsWith('.json'));
  const segs = await Promise.all(keys.map((k) => getJson<{ page_index: number; text: string }>(k)));
  return segs.map((s) => ({ page: s.page_index, text: s.text }));
}

/** WORKFLOWS 단계 기록 (업로드 진행바). 상태·종료 시각만, 오류는 이름만 */
export async function workflowSteps(workflow_id: string) {
  const { DynamoDBClient, QueryCommand } = await import('@aws-sdk/client-dynamodb');
  const r = await new DynamoDBClient({ region: region() }).send(new QueryCommand({
    TableName: env('TABLE_WORKFLOWS'), KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': { S: `WF#${workflow_id}` } },
  }));
  return (r.Items ?? []).filter((i) => i.sk?.S?.startsWith('STEP#'))
    .map((i) => ({ step: i.sk!.S!.slice(5), status: i.status?.S ?? '', ended_at: i.ended_at?.S ?? '', error: i.error?.S }));
}
export async function putBytes(key: string, body: Uint8Array, contentType: string) {
  await s3().send(new PutObjectCommand({ Bucket: env('BUCKET_QUARANTINE'), Key: key, Body: body, ContentType: contentType }));
}
