// Lambda 연결: S3 + 거버넌스 저장소(PostgreSQL, @hanaeum/db). runtime.mjs 가 handler 를 부른다
import { randomBytes } from "node:crypto";
import { CopyObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db, replaceStepFindings } from "@hanaeum/db";
import { libreOffice, makeHandler } from "./handler.ts";

const s3 = new S3Client({});
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () => { let t = ""; for (let i = 0, n = Date.now(); i < 10; i++, n = Math.floor(n / 32)) t = B32[n % 32] + t; const r = randomBytes(16); let s = ""; for (let i = 0; i < 16; i++) s += B32[r[i]! % 32]; return t + s; };
let pg: ReturnType<typeof db> | undefined;

export const handler = makeHandler({
  findOriginal: async (Bucket, doc_id) => (await s3.send(new ListObjectsV2Command({ Bucket, Prefix: `${doc_id}/original.`, MaxKeys: 1 }))).Contents?.[0]?.Key,
  get: async (Bucket, Key) => (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body!.transformToByteArray(),
  copy: async (Bucket, from, Key) => { await s3.send(new CopyObjectCommand({ Bucket, Key, CopySource: `${Bucket}/${encodeURIComponent(from)}`, ServerSideEncryption: "aws:kms", MetadataDirective: "REPLACE", ContentType: "application/pdf", TaggingDirective: "REPLACE" })); },
  put: async (Bucket, Key, Body) => { await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: "application/pdf", ServerSideEncryption: "aws:kms" })); },
  office: libreOffice,
  // ponytail: 거버넌스 저장소는 dev·prod 모두 PostgreSQL(11/17 전환). DynamoDB 경로는 두지 않음
  saveFindings: (doc_id, step, findings) => (pg ??= db()).tx((q) => replaceStepFindings(q, doc_id, step, findings)),
  newId: ulid,
});
