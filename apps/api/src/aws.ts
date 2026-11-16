// API 서버와 단계 Lambda가 함께 쓰는 AWS 어댑터. 값은 환경변수(SSM에서 주입)로만 받는다.
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ExecutionAlreadyExists, SFNClient, SendTaskSuccessCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { DocumentRecord } from './contracts.ts';
import { memoryStore, type Store } from './store.ts';
import { dynamoStore } from './store-dynamo.ts';

export const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const region = () => env('AWS_REGION');
// 운영 교훈 #1: 리전 명시 + SigV4 + virtual-hosted → 307 리다이렉트(CORS 오류처럼 보임) 방지
let s3c: S3Client | undefined;
let sfnc: SFNClient | undefined;
const s3 = () => (s3c ??= new S3Client({ region: region(), forcePathStyle: false }));
const sfn = () => (sfnc ??= new SFNClient({ region: region() }));

export const quarantineKey = (d: Pick<DocumentRecord, 'doc_id' | 'ext'>) => `${d.doc_id}/original.${d.ext}`;

export function storeFromEnv(): Store {
  const e = process.env;
  if (!e.TABLE_DOCUMENTS) return memoryStore(); // ponytail: 로컬 단독 실행용
  return dynamoStore({ documents: env('TABLE_DOCUMENTS'), approvals: env('TABLE_APPROVALS'), feedback: env('TABLE_FEEDBACK'), audit: env('TABLE_AUDIT_EVENTS') });
}

export const presignPut = (key: string, len: number) =>
  getSignedUrl(s3(), new PutObjectCommand({ Bucket: env('BUCKET_QUARANTINE'), Key: key, ContentLength: len }), { expiresIn: 300 });

export async function headObject(key: string) {
  try {
    const h = await s3().send(new HeadObjectCommand({ Bucket: env('BUCKET_QUARANTINE'), Key: key, ChecksumMode: 'ENABLED' }));
    if (!h.VersionId) return undefined; // 버킷 버전관리 필수 (버전 ID가 승인 바인딩의 1차 기준)
    return { s3_version_id: h.VersionId, content_hash: h.ChecksumSHA256 ?? h.ChecksumCRC64NVME ?? h.ETag ?? '' };
  } catch (e) {
    if ((e as { name?: string }).name === 'NotFound') return undefined;
    throw e;
  }
}

/** 객체 바이트. range가 있으면 앞부분만 (type-detection은 8KB). versionId로 검사 대상 버전을 고정한다 */
export async function getObjectBytes(key: string, versionId?: string, range?: number) {
  const r = await s3().send(new GetObjectCommand({ Bucket: env('BUCKET_QUARANTINE'), Key: key, VersionId: versionId, Range: range ? `bytes=0-${range - 1}` : undefined }));
  return new Uint8Array(await r.Body!.transformToByteArray());
}

/** 실행 입력은 문서에서만 만든다. 같은 이름·같은 입력의 재시작은 멱등으로 처리 */
export async function startWorkflow(d: DocumentRecord) {
  const input = {
    workflow_id: d.workflow_id, doc_id: d.doc_id, version: d.version, bucket: env('BUCKET_QUARANTINE'), prefix: `${d.doc_id}/`,
    actor: { sub: d.owner, groups: ['AUTHOR'] },
  };
  try {
    await sfn().send(new StartExecutionCommand({ stateMachineArn: env('SFN_INGEST_ARN'), name: d.workflow_id, input: JSON.stringify(input) }));
  } catch (e) {
    if (!(e instanceof ExecutionAlreadyExists)) throw e; // 다른 입력으로 같은 이름이면 여기로 온다 → 이미 진행 중
  }
}

export async function sendDecision(taskToken: string, decision: 'APPROVE' | 'REJECT' | 'REVALIDATE') {
  await sfn().send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify({ decision }) }));
}
