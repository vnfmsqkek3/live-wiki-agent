// Lambda 핸들러 (단계 3a·5·11·12). 환경변수 이름은 interfaces.md 4장.
import { StepInput } from "@hanaeum/schemas";
import type { Finding, StepOutput } from "@hanaeum/schemas";
import { S3ObjectStore } from "./store.ts";
import type { Records } from "./store.ts";
import { recordsFromEnv } from "./store-pg.ts";
import { textLayerStep } from "./text-layer.ts";
import { segmentStep } from "./segment.ts";
import { promoteStep } from "./promote.ts";
import type { PromoteInput } from "./promote.ts";
import { kbIngestStep, BedrockIngestionApi } from "./kb-ingest.ts";

export * from "./store.ts";
export * from "./store-pg.ts";
export * from "./text-layer.ts";
export * from "./segment.ts";
export * from "./promote.ts";
export * from "./kb-ingest.ts";

// ASL은 공통 입력 6필드만 넘긴다 (interfaces.md 6장). 나머지는 환경변수·DynamoDB에서 읽는다.
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`환경변수 ${k} 없음`); return v; };
let store: S3ObjectStore | undefined;
let records: Records | undefined;
const s3 = () => (store ??= new S3ObjectStore());
const db = () => (records ??= recordsFromEnv()); // GOV_STORE=postgres|dynamo

/** 단계 결과의 Finding을 문서에 저장한 뒤 돌려준다 (오케스트레이터는 상태만 기록하고 Finding은 저장하지 않음 → 차단 사유가 화면에 비어 보였음, 11/17) */
const withFindings = async (step: string, docId: string, out: Promise<StepOutput>) => {
  const r = await out;
  await db().saveFindings(docId, step, (r.findings ?? []) as Finding[]);
  return r;
};
export const textLayerHandler = (e: unknown) => { const i = StepInput.parse(e); return withFindings("TextLayerExtract", i.doc_id, textLayerStep(i, s3())); };
export const segmentHandler = (e: unknown) => { const i = StepInput.parse(e); return withFindings("SegmentBuild", i.doc_id, segmentStep(i, s3())); };
export const promoteHandler = (e: PromoteInput) =>
  promoteStep({ ...StepInput.parse(e), approval_id: e.approval_id, published_bucket: env("BUCKET_PUBLISHED") }, s3(), db());
export const kbIngestHandler = (e: unknown) =>
  kbIngestStep(StepInput.parse(e), new BedrockIngestionApi(), db(), s3(),
    { KB_ID: env("KB_ID"), KB_DS_LEGAL_ID: env("KB_DS_LEGAL_ID"), KB_DS_KNOWLEDGE_ID: env("KB_DS_KNOWLEDGE_ID"), BUCKET_ARTIFACT: env("BUCKET_ARTIFACT") },
    (e as { action?: unknown }).action === "delete"); // action은 StepInput.parse가 지움
