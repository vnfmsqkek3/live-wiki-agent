// 단계 PurgeDocument (사용자 결정 11/17 "문서 삭제 시 모든 저장소에서 삭제", Owner yoyo0704).
// 삭제 흐름(오케스트레이터 deleteGraph): API 가 lifecycle=DELETED·감사 기록 → PurgeDocument → KbIngest(재색인으로 KB 에서 제거)
//   → GraphUpsert(action=delete, Neptune deleteDoc) → 끝. 문서 기록(Documents)·승인·감사 기록은 감사 목적으로 남긴다.
// 이 단계: published/{legal|knowledge}/{doc_id}/ 와 quarantine/{doc_id}/ 의 모든 객체·모든 버전·삭제 마커를 지운다.
// 안전장치: Documents lifecycle 이 DELETED 가 아니면 아무것도 지우지 않고 예외 (Gateway 로 잘못 불려도 게시 문서 보호).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { StepInput, StepOutput } from "./common.js";

export type Deps = {
  lifecycle: (doc_id: string) => Promise<string | undefined>;
  /** 접두어 아래 모든 버전·삭제 마커 삭제. 지운 개수 반환 */
  purge: (bucket: string, prefix: string) => Promise<number>;
  buckets: { published: string; quarantine: string };
};

export function makeHandler(d: Deps) {
  return async (e: StepInput): Promise<StepOutput> => {
    if (!/^doc_[0-9A-Z]{26}$/.test(e.doc_id)) throw new Error(`InvalidDocId: ${e.doc_id}`); // 접두어 넓히기(빈 값·와일드카드) 차단
    const lc = await d.lifecycle(e.doc_id);
    if (lc !== "DELETED") throw new Error(`NotDeleted: lifecycle=${lc ?? "none"}`);
    let n = 0;
    for (const p of ["legal", "knowledge"]) n += await d.purge(d.buckets.published, `${p}/${e.doc_id}/`);
    n += await d.purge(d.buckets.quarantine, `${e.doc_id}/`);
    console.log(JSON.stringify({ step: "PurgeDocument", doc_id: e.doc_id, deleted_versions: n }));
    return { status: "OK" };
  };
}

const s3 = new S3Client({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function purgePrefix(Bucket: string, Prefix: string): Promise<number> {
  let n = 0;
  let KeyMarker: string | undefined, VersionIdMarker: string | undefined;
  do {
    const r = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix, KeyMarker, VersionIdMarker }));
    const Objects = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
    if (Objects.length) {
      const out = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
      if (out.Errors?.length) throw new Error(`PurgeFailed: ${out.Errors.length} objects (${out.Errors[0]?.Code})`);
      n += Objects.length;
    }
    KeyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
    VersionIdMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
  } while (KeyMarker);
  return n;
}

export const handler = makeHandler({
  lifecycle: async (doc_id) =>
    (await db.send(new GetCommand({ TableName: process.env.TABLE_DOCUMENTS, Key: { pk: `DOC#${doc_id}`, sk: "META" }, ConsistentRead: true }))).Item?.lifecycle as string | undefined,
  purge: purgePrefix,
  buckets: { published: process.env.BUCKET_PUBLISHED ?? "", quarantine: process.env.BUCKET_QUARANTINE ?? "" },
});
