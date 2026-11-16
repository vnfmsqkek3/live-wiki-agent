// Lambda 핸들러 (단계 3a·5·11·12). 환경변수 이름은 interfaces.md 4장.
import { StepInput } from "@hanaeum/schemas";
import { S3ObjectStore, DynamoRecords } from "./store.ts";
import { textLayerStep } from "./text-layer.ts";
import { segmentStep } from "./segment.ts";
import { promoteStep } from "./promote.ts";
import type { PromoteInput } from "./promote.ts";
import { kbIngestStep, BedrockIngestionApi } from "./kb-ingest.ts";
import type { KbIngestInput } from "./kb-ingest.ts";

export * from "./store.ts";
export * from "./text-layer.ts";
export * from "./segment.ts";
export * from "./promote.ts";
export * from "./kb-ingest.ts";

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`환경변수 ${k} 없음`); return v; };
let store: S3ObjectStore | undefined;
const s3 = () => (store ??= new S3ObjectStore());

export const textLayerHandler = (e: unknown) => textLayerStep(StepInput.parse(e), s3());
export const segmentHandler = (e: unknown) => segmentStep(StepInput.parse(e), s3());
export const promoteHandler = (e: PromoteInput) =>
  promoteStep({ ...StepInput.parse(e), approval_id: e.approval_id, published_bucket: env("BUCKET_PUBLISHED") }, s3(),
    new DynamoRecords({ documents: env("TABLE_DOCUMENTS"), approvals: env("TABLE_APPROVALS") }));
export const kbIngestHandler = (e: KbIngestInput) =>
  kbIngestStep({ ...e, ...StepInput.parse(e) }, new BedrockIngestionApi(),
    { KB_ID: env("KB_ID"), KB_DS_LEGAL_ID: env("KB_DS_LEGAL_ID"), KB_DS_KNOWLEDGE_ID: env("KB_DS_KNOWLEDGE_ID") });
