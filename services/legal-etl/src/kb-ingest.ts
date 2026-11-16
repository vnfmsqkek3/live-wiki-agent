// 단계 12 KbIngest (폴링 단계, interfaces.md 6장): ASL이 같은 공통 입력으로 15초마다 다시 호출한다.
// 첫 호출: StartIngestionJob → Job ID를 artifact 버킷에 저장 → PENDING
// 이후 호출: 저장된 Job 상태 조회 → 진행 중이면 PENDING, COMPLETE + 실패 0건이면 OK, 실패면 예외
import { createHash } from "node:crypto";
import { BedrockAgentClient, StartIngestionJobCommand, GetIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import { stepFailure } from "@hanaeum/schemas";
import type { StepInput, StepOutput } from "@hanaeum/schemas";
import type { ObjectStore, Records } from "./store.ts";

/** StartIngestionJob clientToken: 영숫자·하이픈만, 33~256자 → 워크플로·문서·버전의 sha256 hex (결정적) */
export const ingestToken = (i: Pick<StepInput, "workflow_id" | "doc_id" | "version">) =>
  createHash("sha256").update(`${i.workflow_id}/${i.doc_id}/v${i.version}`).digest("hex");

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

export interface KbEnv { KB_ID: string; KB_DS_LEGAL_ID: string; KB_DS_KNOWLEDGE_ID: string; BUCKET_ARTIFACT: string }
interface JobState { job_id: string; data_source_id: string }

export const jobStateKey = (input: Pick<StepInput, "workflow_id" | "doc_id" | "version">) => `kb-ingest/${input.workflow_id}/${input.doc_id}-v${input.version}.json`;

export async function kbIngestStep(input: StepInput, api: IngestionApi, records: Records, store: ObjectStore, env: KbEnv): Promise<StepOutput> {
  const key = jobStateKey(input);
  let state: JobState | undefined;
  try { state = JSON.parse((await store.get(env.BUCKET_ARTIFACT, key)).toString()) as JobState; }
  catch (e) { if ((e as Error).name !== "NoSuchKey") throw e; }

  if (!state) {
    const doc = await records.getDocument(input.doc_id);
    if (!doc) throw new Error(`Documents 레코드 없음: ${input.doc_id}`);
    const ds = doc.document_type === "REGULATION" ? env.KB_DS_LEGAL_ID : env.KB_DS_KNOWLEDGE_ID;
    // clientToken 결정적: 저장 전에 Lambda가 죽어 재호출돼도 같은 Job (멱등).
    // 데이터 소스당 동시 Job은 1개 → 다른 문서 색인 중(ConflictException)이면 PENDING으로 돌려 오케스트레이터가 재호출 (여러 문서 동시 게시)
    let job_id: string;
    try { job_id = await api.start(env.KB_ID, ds, ingestToken(input)); }
    catch (e) { if ((e as Error).name === "ConflictException") return { status: "PENDING" }; throw e; }
    await store.put(env.BUCKET_ARTIFACT, key, JSON.stringify({ job_id, data_source_id: ds } satisfies JobState));
    return { status: "PENDING" };
  }
  const j = await api.get(env.KB_ID, state.data_source_id, state.job_id);
  if (j.status === "FAILED" || j.status === "STOPPED") throw stepFailure("IngestionFailed", `검색 색인에 실패했습니다(${j.status}: ${j.failureReasons.join("; ").slice(0, 160)}).`, "문서는 승인된 상태로 남아 있습니다. 관리자에게 재색인을 요청해 주세요.");
  if (j.status !== "COMPLETE") return { status: "PENDING" };
  // 참고 구현 사고 교훈: "워크플로 성공인데 벡터 없음" 방지 — 실패 문서가 1건이라도 있으면 실패
  if (j.failed > 0) throw stepFailure("IngestionFailed", `검색 색인 중 ${j.failed}건이 실패했습니다(문서 형식이 색인 계약과 다를 수 있음).`, "관리자에게 재색인을 요청해 주세요. 반복되면 문서를 다시 올려 주세요.");
  return { status: "OK" };
}
