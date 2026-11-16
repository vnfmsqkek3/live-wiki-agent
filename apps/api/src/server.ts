// API 실행 진입점 (ECS Fargate / 로컬). 값은 환경변수(SSM)로만 받는다.
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { cognitoVerifier } from './auth.ts';
import type { DocumentRecord } from './contracts.ts';
import type { Mark, Page } from './library.ts';
import { env, headObject, invokeAgent, pages, presignPut, resume, startWorkflow, storeFromEnv, workflowFailure } from './aws.ts';

// 문서보관함 밑줄: let522mj buildMarks (PR #8). 패키지에 없으면 밑줄 없이 동작
type BuildMarks = (pages: string[], src: Record<string, unknown>, store: unknown) => Promise<Mark[]>;
async function marks(pages: Page[], d: DocumentRecord): Promise<Mark[]> {
  const reg = (await import('@hanaeum/regulation-server')) as unknown as { buildMarks?: BuildMarks; registryMatch: (s: unknown, h?: string, t?: string) => Promise<unknown>; DynamoClauseStore: new (t: string) => unknown };
  if (!reg.buildMarks || !process.env.TABLE_REGULATIONS) return [];
  const store = new reg.DynamoClauseStore(process.env.TABLE_REGULATIONS);
  const texts = pages.map((p) => p.text);
  const registry = d.document_type === 'REGULATION' ? await reg.registryMatch(store, d.content_hash ?? '', texts.join('\n')) : undefined;
  return reg.buildMarks(texts, { knowhow: d.knowhow_validation, registry, findings: d.findings }, store);
}

const app = createApp({
  verify: cognitoVerifier(env('COGNITO_USER_POOL_ID'), env('COGNITO_CLIENT_ID')),
  store: storeFromEnv(),
  webOrigins: (process.env.WEB_ORIGINS ?? '').split(',').filter(Boolean),
  presignPut,
  headObject,
  startWorkflow,
  resume,
  guide: invokeAgent,
  workflowFailure,
  pages,
  marks,
  search: async () => [], // ponytail: let522mj search Tool 연동 전 빈 결과 (11/18)
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
