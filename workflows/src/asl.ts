// Step Functions "hanaeum-mvp-sfn-ingest" 정의 생성기 (docs/04 1.1, interfaces.md 6장).
// 실행: node workflows/src/asl.ts  → workflows/asl/ingest.asl.json
// ${...} 자리는 Terraform templatefile 이 채운다 (Lambda ARN, 테이블 이름).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Step = { name: string; fn: string; poll?: boolean };

// 단계 순서. fn 은 Terraform 변수 step_functions 의 키.
// poll: 같은 Lambda 를 PENDING 이 끝날 때까지 Wait 후 재호출 (Lambda 는 멱등이어야 함).
export const STEPS_BEFORE_APPROVAL: (Step | [Step, Step])[] = [
  { name: "MalwareCheck", fn: "malware_check", poll: true },
  { name: "FileStructureCheck", fn: "file_structure_check" },
  [
    { name: "TextLayerExtract", fn: "text_layer_extract" },
    { name: "PageRender", fn: "page_render" },
  ],
  { name: "OcrIfNeeded", fn: "ocr_if_needed", poll: true },
  { name: "SegmentBuild", fn: "segment_build" },
  { name: "PiiScan", fn: "pii_scan" },
  { name: "InjectionScan", fn: "injection_scan" },
  { name: "Classify", fn: "classify" },
  { name: "TrustGate", fn: "trust_gate" },
];
export const STEPS_AFTER_APPROVAL: Step[] = [
  { name: "Promote", fn: "promote" },
  { name: "KbIngest", fn: "kb_ingest", poll: true },
  { name: "GraphUpsert", fn: "graph_upsert" },
];

const CTX_FIELDS = ["workflow_id", "doc_id", "version", "bucket", "prefix", "actor"];
const POLL_SECONDS = 15;

type State = Record<string, unknown>;
const states: Record<string, State> = {};

function payload(extra: Record<string, string> = {}) {
  const p: Record<string, string> = {};
  for (const f of CTX_FIELDS) p[`${f}.$`] = `$.ctx.${f}`;
  return { ...p, ...extra };
}

const RETRY = [
  {
    ErrorEquals: ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"],
    IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2, JitterStrategy: "FULL",
  },
  {
    // Bedrock 호출 단계 (docs/04 1.2)
    ErrorEquals: ["ThrottlingException", "TooManyRequestsException", "ServiceUnavailableException"],
    IntervalSeconds: 10, MaxAttempts: 2, BackoffRate: 2, JitterStrategy: "FULL",
  },
];

const wfKey = { "S.$": "States.Format('WF#{}', $.ctx.workflow_id)" };

function record(step: string, statusPath: string, next: string): State {
  return {
    Type: "Task",
    Resource: "arn:aws:states:::dynamodb:putItem",
    Parameters: {
      TableName: "${table_workflows}",
      Item: {
        pk: wfKey,
        sk: { S: `STEP#${step}` },
        doc_id: { "S.$": "$.ctx.doc_id" },
        status: { "S.$": statusPath },
        ended_at: { "S.$": "$$.State.EnteredTime" },
      },
    },
    ResultPath: null,
    Next: next,
  };
}

function failHandler(step: string): string {
  const name = `HandleError_${step}`;
  states[name] = {
    Type: "Task",
    Resource: "arn:aws:states:::dynamodb:putItem",
    Parameters: {
      TableName: "${table_workflows}",
      Item: {
        pk: wfKey,
        sk: { S: `STEP#${step}` },
        doc_id: { "S.$": "$.ctx.doc_id" },
        status: { S: "FAILED" },
        // Cause 는 기록하지 않는다 (원문 노출 위험). 상세는 실행 이력에서 확인.
        error: { "S.$": "$.error.Error" },
        ended_at: { "S.$": "$$.State.EnteredTime" },
      },
    },
    ResultPath: null,
    Next: "Failed",
  };
  return name;
}

// 단계 1개: Task → Record → (poll: PENDING 이면 Wait → Task) → BLOCKED 면 Blocked → next
function addStep(s: Step, next: string): string {
  const rec = `Record_${s.name}`;
  const check = `Check_${s.name}`;
  states[s.name] = {
    Type: "Task",
    Resource: "arn:aws:states:::lambda:invoke",
    Parameters: { FunctionName: `\${fn_${s.fn}}`, Payload: payload() },
    ResultSelector: { "status.$": "$.Payload.status" },
    ResultPath: "$.last",
    Retry: RETRY,
    Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: failHandler(s.name) }],
    Next: rec,
  };
  states[rec] = record(s.name, "$.last.status", check);
  const choices: State[] = [{ Variable: "$.last.status", StringEquals: "BLOCKED", Next: "Blocked" }];
  if (s.poll) {
    const wait = `Wait_${s.name}`;
    states[wait] = { Type: "Wait", Seconds: POLL_SECONDS, Next: s.name };
    choices.push({ Variable: "$.last.status", StringEquals: "PENDING", Next: wait });
  }
  states[check] = { Type: "Choice", Choices: choices, Default: next };
  return s.name;
}

// 두 단계 병렬: 각 브랜치는 Task 1개, 결과 status 둘 중 BLOCKED 가 있으면 Blocked
function addParallel(name: string, pair: [Step, Step], next: string): string {
  const branch = (s: Step) => ({
    StartAt: s.name,
    States: {
      [s.name]: {
        Type: "Task",
        Resource: "arn:aws:states:::lambda:invoke",
        Parameters: { FunctionName: `\${fn_${s.fn}}`, Payload: payload() },
        ResultSelector: { "status.$": "$.Payload.status" },
        Retry: RETRY,
        End: true,
      },
    },
  });
  const rec0 = `Record_${pair[0].name}`;
  const rec1 = `Record_${pair[1].name}`;
  const check = `Check_${name}`;
  states[name] = {
    Type: "Parallel",
    Branches: pair.map(branch),
    ResultSelector: { "a.$": "$[0].status", "b.$": "$[1].status" },
    ResultPath: "$.par",
    Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: failHandler(name) }],
    Next: rec0,
  };
  states[rec0] = record(pair[0].name, "$.par.a", rec1);
  states[rec1] = record(pair[1].name, "$.par.b", check);
  states[check] = {
    Type: "Choice",
    Choices: [
      { Or: [{ Variable: "$.par.a", StringEquals: "BLOCKED" }, { Variable: "$.par.b", StringEquals: "BLOCKED" }], Next: "Blocked" },
    ],
    Default: next,
  };
  return name;
}

export function buildIngestAsl() {
  for (const k of Object.keys(states)) delete states[k];

  // 끝에서부터 만든다 (각 단계가 다음 단계 이름을 알아야 함)
  states.Finalize = {
    Type: "Task",
    Resource: "arn:aws:states:::lambda:invoke",
    Parameters: { FunctionName: "${fn_finalize}", Payload: payload({ "outcome.$": "$.outcome" }) },
    ResultSelector: { "status.$": "$.Payload.status" },
    ResultPath: "$.last",
    Retry: RETRY,
    Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: failHandler("Finalize") }],
    Next: "Record_Finalize",
  };
  states.Record_Finalize = record("Finalize", "$.outcome", "Done");
  states.Done = { Type: "Succeed" };
  states.Failed = { Type: "Fail", Error: "IngestStepFailed" };
  states.Blocked = { Type: "Pass", Result: "BLOCKED", ResultPath: "$.outcome", Next: "Finalize" };
  states.Rejected = { Type: "Pass", Result: "REJECTED", ResultPath: "$.outcome", Next: "Finalize" };

  let next = "Finalize";
  for (const s of [...STEPS_AFTER_APPROVAL].reverse()) next = addStep(s, next);

  // 사람 승인. 승인 API 가 SendTaskSuccess({ decision: APPROVE|REJECT|REVALIDATE }) 를 보낸다 (interfaces.md 7장)
  states.WaitForApproval = {
    Type: "Task",
    Resource: "arn:aws:states:::lambda:invoke.waitForTaskToken",
    Parameters: { FunctionName: "${fn_wait_for_approval}", Payload: payload({ "task_token.$": "$$.Task.Token" }) },
    ResultPath: "$.approval",
    Retry: RETRY,
    Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: failHandler("WaitForApproval") }],
    Next: "Record_WaitForApproval",
  };
  states.Record_WaitForApproval = record("WaitForApproval", "$.approval.decision", "Check_WaitForApproval");
  states.Check_WaitForApproval = {
    Type: "Choice",
    Choices: [{ Variable: "$.approval.decision", StringEquals: "APPROVE", Next: next }],
    Default: "Rejected",
  };
  next = "WaitForApproval";

  for (const s of [...STEPS_BEFORE_APPROVAL].reverse()) {
    next = Array.isArray(s) ? addParallel("ParallelPreprocess", s, next) : addStep(s, next);
  }

  // 입력 { workflow_id, doc_id, version, bucket, prefix, actor } 를 $.ctx 로 보존. 실행 이름 = workflow_id.
  states.Init = {
    Type: "Pass",
    Parameters: { "ctx.$": "$", outcome: "PUBLISHED" },
    Next: next,
  };

  return {
    Comment: "Living Wiki 문서 처리 14단계 (생성 파일: workflows/src/asl.ts 를 수정하고 다시 생성)",
    StartAt: "Init",
    TimeoutSeconds: 86400,
    States: { ...states },
  };
}

export const ASL_PATH = fileURLToPath(new URL("../asl/ingest.asl.json", import.meta.url));
export const render = () => JSON.stringify(buildIngestAsl(), null, 2) + "\n";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(ASL_PATH, render());
  console.log(`written ${ASL_PATH}`);
}
