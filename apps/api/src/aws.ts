// API 서버와 단계 Lambda가 함께 쓰는 AWS 어댑터. 값은 환경변수(SSM에서 주입)로만 받는다.
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { DocumentRecord } from './contracts.ts';
import { memoryStore, type Store } from './store.ts';
import { dynamoStore } from './store-dynamo.ts';
import { postgresStore } from './store-postgres.ts';

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
  // 거버넌스 저장소 전환 (사용자 결정 11/17): GOV_STORE=postgres면 Aurora(Data API, DB_CLUSTER_ARN·DB_SECRET_ARN·DB_NAME)
  if (e.GOV_STORE === 'postgres') return postgresStore();
  if (!e.TABLE_DOCUMENTS) return memoryStore(); // ponytail: 로컬 단독 실행용
  return dynamoStore({ documents: env('TABLE_DOCUMENTS'), approvals: env('TABLE_APPROVALS'), feedback: env('TABLE_FEEDBACK'), audit: env('TABLE_AUDIT_EVENTS') });
}

/** 원본 내려받기 (사용자 요청 11/17): 승인된 버전 그대로, 60초, 첨부로 저장. URL은 로그·감사에 남기지 않는다 */
export const presignGet = (key: string, versionId: string | undefined, filename: string) =>
  getSignedUrl(s3(), new GetObjectCommand({
    Bucket: env('BUCKET_QUARANTINE'), Key: key, ...(versionId ? { VersionId: versionId } : {}),
    ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  }), { expiresIn: 60 });
/** 원본 보기 쪽 이미지 (masked/view, 개인정보만 가림). 5분, 화면에 바로 표시. URL은 로그·감사에 남기지 않는다 */
export const presignView = (key: string) =>
  getSignedUrl(s3(), new GetObjectCommand({ Bucket: env('BUCKET_QUARANTINE'), Key: key, ResponseContentType: 'image/png' }), { expiresIn: 300 });
/** masked/view 가 있는 쪽 (page_index) */
export async function viewPageList(doc_id: string) {
  return (await listKeys(`${doc_id}/masked/view/`)).map((k) => Number(/(\d{4})\.png$/.exec(k)?.[1] ?? NaN)).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
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
  // 위키 수정본(md): 변환·쪽 이미지·OCR 을 건너뛴다 (interfaces 6.2 보정, yoyo0704 34fcd5a)
  await invokePipeline({ action: 'start', input: stepInput(d), ...(d.ext === 'md' ? { text_only: true } : {}) }, d.workflow_id!);
}

/** 사용자 삭제 정리 (interfaces 6.0): 새 workflow_id로 오케스트레이터 delete 실행 */
export async function deleteWorkflow(d: DocumentRecord) {
  await invokePipeline({ action: 'delete', input: { ...stepInput(d), workflow_id: d.delete_workflow_id! } }, d.delete_workflow_id!);
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
    // Agent Tool 선택(최대 60초) + 작성 시간. 스트리밍은 15초 ping으로 연결 유지
    signal: AbortSignal.timeout(stream ? 180_000 : 120_000),
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
  // 사용자에게는 한국어 안내 문장만 (AWS·런타임 영문 오류에는 ARN·경로가 섞일 수 있어 숨김)
  const msg = failed?.message?.S;
  return failed ? { step: failed.sk!.S!.slice(5), error: failed.error?.S ?? 'Unknown', ...(msg && /[가-힣]/.test(msg) ? { message: msg } : {}) } : undefined;
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
  const segs = await Promise.all(keys.map((k) => getJson<{ page_index: number; text: string; figures?: { image_key?: string }[] }>(k)));
  // figure_keys: 그림 k(1부터)의 잘라낸 이미지 키 (ImageDescribe masked/figures, 없으면 null)
  return segs.map((s) => ({ page: s.page_index, text: s.text, figure_keys: (s.figures ?? []).map((f) => (f.image_key && /\/masked\/figures\//.test(f.image_key) ? f.image_key : null)) }));
}

/** 관리 > Agent 실행 기록: WORKFLOWS 전체를 실행 단위로 묶는다 (EXECUTION·STEP#·LOCK#). 오류는 이름만
 *  ponytail: Scan — 실행 수천 건 전까지. 늘면 gsi1(최근순) Query로 */
export async function workflowRuns() {
  const { DynamoDBClient, ScanCommand } = await import('@aws-sdk/client-dynamodb');
  const c = new DynamoDBClient({ region: region() });
  const by = new Map<string, { workflow_id: string; doc_id?: string; status?: string; ended_at?: string; kind?: string; steps: { step: string; status: string; ended_at: string; error?: string }[] }>();
  let ExclusiveStartKey: Record<string, import('@aws-sdk/client-dynamodb').AttributeValue> | undefined;
  do {
    const r = await c.send(new ScanCommand({ TableName: env('TABLE_WORKFLOWS'), ExclusiveStartKey }));
    for (const i of r.Items ?? []) {
      const id = i.pk?.S?.replace(/^WF#/, ''); const sk = i.sk?.S ?? '';
      if (!id) continue;
      const run = by.get(id) ?? { workflow_id: id, steps: [] };
      run.doc_id ??= i.doc_id?.S;
      if (sk === 'EXECUTION') { run.status = i.status?.S; run.ended_at = i.ended_at?.S; }
      else if (sk.startsWith('LOCK#')) run.kind = sk.slice(5);
      else if (sk.startsWith('STEP#')) run.steps.push({ step: sk.slice(5), status: i.status?.S ?? '', ended_at: i.ended_at?.S ?? '', ...(i.error?.S ? { error: i.error.S } : {}) });
      by.set(id, run);
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return [...by.values()];
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

/** 마스킹된 쪽 이미지 (PiiScan이 만든 masked/pages). API Task Role은 masked/만 읽는다 */
export async function pageImage(doc_id: string, page_index: number) {
  return getObjectBytes(`${doc_id}/masked/pages/${String(page_index).padStart(4, '0')}.png`);
}
export async function pageImageList(doc_id: string) {
  return (await listKeys(`${doc_id}/masked/pages/`)).map((k) => Number(/(\d{4})\.png$/.exec(k)?.[1] ?? NaN)).filter((n) => Number.isInteger(n));
}
/** AI로 다시 배치한 쪽 본문 (Classify, masked/structured/{nnnn}.json). page_index → markdown */
export async function structuredPages(doc_id: string) {
  const keys = (await listKeys(`${doc_id}/masked/structured/`)).filter((k) => k.endsWith('.json'));
  const rows = await Promise.all(keys.map((k) => getJson<{ page_index: number; markdown: string; source?: string }>(k).catch(() => undefined)));
  return new Map(rows.filter((r): r is { page_index: number; markdown: string; source?: string } => !!r).map((r) => [r.page_index, { markdown: r.markdown, source: r.source === 'VISION' ? 'VISION' as const : r.source === 'TEXT' ? 'TEXT' as const : 'AI' as const }])); // source 없는 이전 기록은 AI 재구성
}
export async function pageSummary(doc_id: string) {
  return getJson<{ pages?: import('./app.ts').PageMeta[] }>(`${doc_id}/masked/summary.json`);
}
export async function explanation(doc_id: string) {
  return getJson<unknown>(`${doc_id}/masked/explanation.json`);
}

/** 사용자 Gateway Tool 호출 (사용자 access token 그대로 → interceptor가 신원 주입, Policy·감사 일원화). 결과 JSON */
export async function userTool(name: string, args: Record<string, unknown>, accessToken: string): Promise<unknown> {
  const r = await fetch(env('USER_GATEWAY_URL'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(90_000), // Browser 첫 조회 ~22초 (let522mj)
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`gateway ${r.status}`), { name: 'GatewayError' });
  const json = JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : text) as
    { error?: { message: string }; result?: { isError?: boolean; content?: { type: string; text?: string }[] } };
  if (json.error || json.result?.isError) throw Object.assign(new Error('tool error'), { name: 'ToolError' });
  return JSON.parse(json.result?.content?.find((c) => c.type === 'text')?.text ?? 'null');
}

/** prefix 아래 모든 객체의 모든 버전·삭제 표시를 지운다 (버전 관리 버킷에서 실제 삭제). 지운 수 */
export async function purgePrefix(prefix: string): Promise<number> {
  const { ListObjectVersionsCommand, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  let n = 0, KeyMarker: string | undefined, VersionIdMarker: string | undefined;
  do {
    const r = await s3().send(new ListObjectVersionsCommand({ Bucket: env('BUCKET_QUARANTINE'), Prefix: prefix, KeyMarker, VersionIdMarker }));
    const objs = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].filter((v) => v.Key).map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
    for (let i = 0; i < objs.length; i += 1000) {
      await s3().send(new DeleteObjectsCommand({ Bucket: env('BUCKET_QUARANTINE'), Delete: { Objects: objs.slice(i, i + 1000), Quiet: true } }));
    }
    n += objs.length;
    KeyMarker = r.IsTruncated ? r.NextKeyMarker : undefined; VersionIdMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
  } while (KeyMarker);
  return n;
}
