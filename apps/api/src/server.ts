// API 실행 진입점 (ECS Fargate / 로컬). 값은 환경변수(SSM)로만 받는다.
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { cognitoVerifier } from './auth.ts';
import { env, headObject, presignPut, sendDecision, startWorkflow, storeFromEnv } from './aws.ts';

const app = createApp({
  verify: cognitoVerifier(env('COGNITO_USER_POOL_ID'), env('COGNITO_CLIENT_ID')),
  store: storeFromEnv(),
  presignPut,
  headObject,
  startWorkflow,
  sendDecision,
  search: async () => [], // ponytail: let522mj search Tool 연동 전 빈 결과 (11/18)
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
