// 실행 진입점. 실제 AWS 어댑터를 연결한다. 값은 환경변수(SSM에서 주입)로만 받는다.
import { serve } from '@hono/node-server';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SFNClient, SendTaskSuccessCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { createApp } from './app.ts';
import { cognitoVerifier } from './auth.ts';
import { memoryStore } from './store.ts';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const region = env('AWS_REGION');
const bucket = env('BUCKET_QUARANTINE');
// 운영 교훈 #1: 리전 명시 + SigV4 + virtual-hosted → 307 리다이렉트(CORS 오류처럼 보임) 방지
const s3 = new S3Client({ region, forcePathStyle: false });
const sfn = new SFNClient({ region });

const app = createApp({
  verify: cognitoVerifier(env('COGNITO_USER_POOL_ID'), env('COGNITO_CLIENT_ID')),
  store: memoryStore(), // ponytail: DynamoDB 구현은 테이블 배포 후 교체
  presignPut: (key, len) =>
    getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentLength: len }), { expiresIn: 300 }),
  headObject: async (key) => {
    try {
      const h = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }));
      if (!h.VersionId) return undefined; // 버킷 버전관리 필수 (버전 ID가 바인딩의 1차 기준)
      // S3 기본 체크섬(CRC64NVME) 또는 SHA256. 둘 다 없으면 ETag
      return { s3_version_id: h.VersionId, content_hash: h.ChecksumSHA256 ?? h.ChecksumCRC64NVME ?? h.ETag ?? '' };
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound') return undefined;
      throw e;
    }
  },
  startWorkflow: async (i) => {
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: env('SFN_INGEST_ARN'),
      name: i.workflow_id,
      input: JSON.stringify({ workflow_id: i.workflow_id, doc_id: i.doc_id, version: i.version, bucket, prefix: `${i.doc_id}/`, actor: { sub: i.actor.sub, groups: i.actor.groups } }),
    }));
  },
  sendDecision: async (taskToken, decision) => {
    await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify({ decision }) }));
  },
  search: async () => [], // ponytail: let522mj search Tool 연동 전 빈 결과 (11/18)
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
