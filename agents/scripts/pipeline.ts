// AgentCore 파이프라인 실행·검증 CLI. AgentCore Runtime을 InvokeAgentRuntime으로 호출하고 단계 결과(WORKFLOWS)를 표로 보여준다.
// 사용:
//   set -a; . ./.env.local; set +a; eval "$(apps/api/scripts/ssm-env.sh dev)"
//   PIPELINE_RUNTIME_ARN=<arn> node agents/scripts/pipeline.ts start  <doc_id>
//   PIPELINE_RUNTIME_ARN=<arn> node agents/scripts/pipeline.ts resume <doc_id> APPROVE|REJECT
//   node agents/scripts/pipeline.ts status <doc_id>
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };
const [action, docId, decision] = process.argv.slice(2);
if (!action || !docId || !/^doc_[0-9A-HJKMNP-TV-Z]{26}$/.test(docId)) {
  console.error('usage: pipeline.ts start|resume|status <doc_id> [APPROVE|REJECT]');
  process.exit(2);
}
const region = process.env.AWS_REGION ?? 'us-east-1';
const ddb = new DynamoDBClient({ region });

const doc = (await ddb.send(new GetItemCommand({ TableName: env('TABLE_DOCUMENTS'), Key: { pk: { S: `DOC#${docId}` }, sk: { S: 'META' } } }))).Item;
if (!doc) throw new Error(`document not found: ${docId}`);
const wf = doc.workflow_id!.S!;
const input = { workflow_id: wf, doc_id: docId, version: Number(doc.version!.N), bucket: env('BUCKET_QUARANTINE'), prefix: `${docId}/`, actor: { sub: doc.owner!.S!, groups: ['AUTHOR'] } };

async function steps() {
  const r = await ddb.send(new QueryCommand({ TableName: env('TABLE_WORKFLOWS'), KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': { S: `WF#${wf}` } } }));
  return (r.Items ?? []).map((i) => ({ step: i.sk!.S!.replace(/^STEP#/, ''), status: i.status?.S ?? '', error: i.error?.S ?? '', at: i.ended_at?.S ?? '' }))
    .sort((a, b) => a.at.localeCompare(b.at));
}
async function lifecycle() {
  const d = (await ddb.send(new GetItemCommand({ TableName: env('TABLE_DOCUMENTS'), Key: { pk: { S: `DOC#${docId}` }, sk: { S: 'META' } } }))).Item!;
  return `${d.lifecycle?.S} · trust_gate=${d.trust_gate_result?.S ?? '-'} · type=${d.document_type?.S ?? '-'} · authority=${d.authority_status?.S}`;
}

if (action !== 'status') {
  const started = new Date().toISOString();
  const payload = action === 'start' ? { action, input } : { action: 'resume', decision: decision ?? 'APPROVE', input };
  const r = await new BedrockAgentCoreClient({ region }).send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: env('PIPELINE_RUNTIME_ARN'), qualifier: 'DEFAULT', runtimeSessionId: `verify-${wf}-${Date.now()}`.padEnd(40, '0'),
    contentType: 'application/json', accept: 'application/json', payload: new TextEncoder().encode(JSON.stringify(payload)),
  }));
  console.log(`AgentCore Runtime 호출: ${action} → HTTP ${r.statusCode} (session ${r.runtimeSessionId})`);
  // EXECUTION 기록이 이번 호출 이후로 갱신될 때까지 대기 (최대 20분: 악성코드 스캔·KB 색인 폴링 포함)
  for (let i = 0; i < 240; i++) {
    const ex = (await steps()).find((s) => s.step === 'EXECUTION');
    const last = (await steps()).filter((s) => s.at >= started);
    if (ex && ex.at >= started) break;
    if (action === 'start' && last.some((s) => s.step === 'WaitForApproval' || (s.step === 'Finalize' && s.status === 'BLOCKED'))) break;
    process.stdout.write('.');
    await new Promise((res) => setTimeout(res, 5000));
  }
  console.log(`\n단계 결과 (이번 실행, ${started} 이후)`);
  for (const s of (await steps()).filter((x) => x.at >= started)) console.log(`  ${s.at.slice(11, 19)}  ${s.step.padEnd(20)} ${s.status}${s.error ? `  (${s.error})` : ''}`);
} else {
  for (const s of await steps()) console.log(`  ${s.at.slice(11, 19)}  ${s.step.padEnd(20)} ${s.status}${s.error ? `  (${s.error})` : ''}`);
}
console.log(`문서 상태: ${await lifecycle()}`);
process.exit(0);
