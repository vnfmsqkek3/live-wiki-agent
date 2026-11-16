// Bedrock KB Custom Transformation Lambda (POST_CHUNKING, chunkingStrategy=NONE)
// 이벤트·출력 JSON 형식: AWS 문서 "Use a custom transformation Lambda function" (kb-custom-transformation.html, 11/16 확인).
// contentType은 enum(TEXT, PDF …). 실제 이벤트 1건으로 재검증은 Lambda 연결 후.
//   입력: { bucketName, inputFiles: [{ originalFileLocation, fileMetadata, contentBatches: [{ key }] }] }
//   배치 파일: { fileContents: [{ contentBody, contentType, contentMetadata }] }
//   출력: { outputFiles: [{ originalFileLocation, fileMetadata, contentBatches: [{ key }] }] }
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { DocumentMetadata } from "@hanaeum/schemas";
import { chunkDocument } from "./chunk.ts";

export * from "./chunk.ts";

export interface BatchFile { fileContents: { contentBody: string; contentType: string; contentMetadata?: Record<string, unknown> }[] }
export interface InputFile { originalFileLocation: unknown; fileMetadata?: Record<string, unknown>; contentBatches: { key: string }[] }
export interface TransformEvent { bucketName: string; inputFiles: InputFile[]; knowledgeBaseId?: string; dataSourceId?: string; ingestionJobId?: string; priorTask?: string }
export interface Io { read(bucket: string, key: string): Promise<string>; write(bucket: string, key: string, body: string): Promise<void> }

/** fileMetadata 숫자 필드가 문자열로 와도 처리 (KB 전달 형식 보장 문서 없음) */
const NUM_FIELDS = ["effective_from", "effective_to"];
export const coerceMeta = (m: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, NUM_FIELDS.includes(k) && typeof v === "string" && /^\d+$/u.test(v) ? Number(v) : v]));

/** 색인 제외 사유 로그: 위치·오류 이름·zod 경로만 (본문·메타데이터 값은 남기지 않음) */
const rejectLog = (loc: unknown, e: unknown) => {
  const err = e as Error & { issues?: { path: PropertyKey[] }[] };
  console.error(JSON.stringify({ msg: "KB 색인 제외 (메타데이터 계약 위반 또는 처리 불가)", file: (loc as { s3_location?: { uri?: string } })?.s3_location?.uri ?? null, error: err.name, issues: err.issues?.map((i) => i.path.join(".")) ?? [], reason: err.issues ? undefined : err.message.slice(0, 200) }));
};

async function transformFile(f: InputFile, bucket: string, io: Io) {
  // 메타데이터 검증 (docs/01 8.3 6단계): 누락·형식 오류·미게시 문서는 색인하지 않는다 (원문 그대로 넘기지 않음 — ACL·lifecycle 없는 청크 금지)
  const meta = DocumentMetadata.parse(coerceMeta(f.fileMetadata ?? {}));
  if (meta.lifecycle !== "PUBLISHED") throw new Error(`PUBLISHED 아닌 문서 색인 시도: ${meta.doc_id}`);
  const parts: string[] = [];
  for (const b of f.contentBatches) {
    const batch = JSON.parse(await io.read(bucket, b.key)) as BatchFile;
    for (const c of batch.fileContents) parts.push(c.contentBody);
  }
  const chunks = chunkDocument(parts.join("\n"), meta);
  if (!chunks.length) throw new Error(`청크 0개: ${meta.doc_id}`);
  const outKey = `${f.contentBatches[0]!.key}.hanaeum-chunks.json`;
  const out: BatchFile = {
    fileContents: chunks.map((c) => ({ contentBody: c.augmented_search_text, contentType: "TEXT", contentMetadata: c.metadata })),
  };
  await io.write(bucket, outKey, JSON.stringify(out));
  return { originalFileLocation: f.originalFileLocation, fileMetadata: f.fileMetadata, contentBatches: [{ key: outKey }] };
}

/** 파일 단위 격리: 한 파일이 실패해도 같은 호출의 다른 파일은 색인. 실패 파일은 outputFiles에서 빠지고(색인 안 됨) 사유를 로그로 남긴다 */
export async function transform(event: TransformEvent, io: Io) {
  const outputFiles = [];
  for (const f of event.inputFiles) {
    try { outputFiles.push(await transformFile(f, event.bucketName, io)); } catch (e) { rejectLog(f.originalFileLocation, e); }
  }
  return { outputFiles };
}

const s3 = new S3Client({});
const s3Io: Io = {
  async read(Bucket, Key) { return (await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body!.transformToString()); },
  async write(Bucket, Key, Body) { await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: "application/json" })); },
};
export const handler = (event: TransformEvent) => transform(event, s3Io);
