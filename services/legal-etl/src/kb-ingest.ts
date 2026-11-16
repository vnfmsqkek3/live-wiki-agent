// 단계 12 KbIngest: StartIngestionJob → (SFN Wait 루프) → COMPLETE + 실패 0건일 때만 OK (docs/04 4.2)
// ASL 계약: action=start → ingestion.state=STARTED, action=check → IN_PROGRESS | COMPLETE. FAILED·실패 문서는 예외.
import { BedrockAgentClient, StartIngestionJobCommand, GetIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import type { StepInput, StepOutput } from "@hanaeum/schemas";

export interface IngestionApi {
  start(kbId: string, dsId: string, token: string): Promise<string>;
  get(kbId: string, dsId: string, jobId: string): Promise<{ status: string; failed: number; failureReasons: string[] }>;
}

export class BedrockIngestionApi implements IngestionApi {
  private readonly c: BedrockAgentClient;
  constructor(c = new BedrockAgentClient({})) { this.c = c; }
  async start(knowledgeBaseId: string, dataSourceId: string, clientToken: string) {
    const r = await this.c.send(new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId, clientToken }));
    return r.ingestionJob!.ingestionJobId!;
  }
  async get(knowledgeBaseId: string, dataSourceId: string, ingestionJobId: string) {
    const r = await this.c.send(new GetIngestionJobCommand({ knowledgeBaseId, dataSourceId, ingestionJobId }));
    const j = r.ingestionJob!;
    return { status: j.status!, failed: j.statistics?.numberOfDocumentsFailed ?? 0, failureReasons: j.failureReasons ?? [] };
  }
}

export interface KbIngestInput extends StepInput {
  action: "start" | "check";
  document_type: "REGULATION" | "KNOWHOW" | "MANUAL";
  ingestion?: { job_id: string; data_source_id: string };
}
export type KbIngestOutput = StepOutput & { ingestion: { job_id: string; data_source_id: string; state: "STARTED" | "IN_PROGRESS" | "COMPLETE" } };

export async function kbIngestStep(input: KbIngestInput, api: IngestionApi, env: { KB_ID: string; KB_DS_LEGAL_ID: string; KB_DS_KNOWLEDGE_ID: string }): Promise<KbIngestOutput> {
  if (input.action === "start") {
    const ds = input.document_type === "REGULATION" ? env.KB_DS_LEGAL_ID : env.KB_DS_KNOWLEDGE_ID;
    // clientToken 결정적: 같은 실행의 재시도는 같은 Job (멱등). 데이터 소스당 동시 Job 충돌(ConflictException)은 SFN Retry 대상
    const job_id = await api.start(env.KB_ID, ds, `${input.workflow_id}-${input.doc_id}-v${input.version}`.slice(0, 256));
    return { status: "OK", ingestion: { job_id, data_source_id: ds, state: "STARTED" } };
  }
  if (!input.ingestion) throw new Error("check에는 ingestion.job_id 필요");
  const j = await api.get(env.KB_ID, input.ingestion.data_source_id, input.ingestion.job_id);
  if (j.status === "FAILED" || j.status === "STOPPED") throw Object.assign(new Error(`Ingestion ${j.status}: ${j.failureReasons.join("; ")}`), { name: "IngestionFailed" });
  if (j.status !== "COMPLETE") return { status: "OK", ingestion: { ...input.ingestion, state: "IN_PROGRESS" } };
  // 참고 구현 사고 교훈: "워크플로 성공인데 벡터 없음" 방지 — 실패 문서가 1건이라도 있으면 실패
  if (j.failed > 0) throw Object.assign(new Error(`Ingestion COMPLETE이지만 실패 문서 ${j.failed}건`), { name: "IngestionFailed" });
  return { status: "OK", ingestion: { ...input.ingestion, state: "COMPLETE" } };
}
