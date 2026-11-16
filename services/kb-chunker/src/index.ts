// Bedrock KB Custom Transformation Lambda (POST_CHUNKING, chunkingStrategy=NONE)
// [확인 필요] 이벤트·출력 JSON 형식은 AWS 문서 "custom transformation Lambda" 기준으로 작성. 배포 전 실제 이벤트로 재검증.
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

export async function transform(event: TransformEvent, io: Io) {
  const outputFiles = [];
  for (const f of event.inputFiles) {
    // 메타데이터 검증 (docs/01 8.3 6단계): 누락·형식 오류는 격리 대상 → 예외로 Ingestion 실패 처리
    const meta = DocumentMetadata.parse(f.fileMetadata ?? {});
    if (meta.lifecycle !== "PUBLISHED") throw new Error(`PUBLISHED 아닌 문서 색인 시도: ${meta.doc_id}`);
    const parts: string[] = [];
    for (const b of f.contentBatches) {
      const batch = JSON.parse(await io.read(event.bucketName, b.key)) as BatchFile;
      for (const c of batch.fileContents) parts.push(c.contentBody);
    }
    const chunks = chunkDocument(parts.join("\n"), meta);
    if (!chunks.length) throw new Error(`청크 0개: ${meta.doc_id}`);
    const outKey = `${f.contentBatches[0]!.key}.hanaeum-chunks.json`;
    const out: BatchFile = {
      fileContents: chunks.map((c) => ({ contentBody: c.augmented_search_text, contentType: "string", contentMetadata: c.metadata })),
    };
    await io.write(event.bucketName, outKey, JSON.stringify(out));
    outputFiles.push({ originalFileLocation: f.originalFileLocation, fileMetadata: f.fileMetadata, contentBatches: [{ key: outKey }] });
  }
  return { outputFiles };
}

const s3 = new S3Client({});
const s3Io: Io = {
  async read(Bucket, Key) { return (await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body!.transformToString()); },
  async write(Bucket, Key, Body) { await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: "application/json" })); },
};
export const handler = (event: TransformEvent) => transform(event, s3Io);
