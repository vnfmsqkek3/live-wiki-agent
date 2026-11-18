// API 실행 진입점 (ECS Fargate / 로컬). 값은 환경변수(SSM)로만 받는다.
import { CHANGE_SCHEMA, CHANGE_SYSTEM } from './steps/change-request.ts';
import { db } from '@hanaeum/db';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { structured } from './model.ts';
import { COMPOSE_SCHEMA, COMPOSE_SYSTEM } from './steps/clarify.ts';
import { LAW_SCHEMA, LAW_SYSTEM, mergeLaws, type LawRef } from './steps/external-laws.ts';
import { cognitoVerifier } from './auth.ts';
import type { DocumentRecord } from './contracts.ts';
import type { Mark, Page } from './library.ts';
import { searchVia, type SearchWiki } from './search.ts';
import { putOriginalOnly, deleteWorkflow, presignGet, env, explanation, pageSummary, structuredPages, headObject, userTool, invokeAgent, invokeAgentStream, pageImage, pageImageList, pages, presignPut, resume, startWorkflow, storeFromEnv, workflowFailure, workflowRuns, workflowSteps, presignView, viewPageList } from './aws.ts';

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

// 검색: let522mj search_wiki (KB Retrieve·Rerank·Documents 재검증). 설정이 없으면 빈 결과
async function searchWiki() {
  const e = process.env;
  if (!e.KB_ID || !e.TABLE_REGULATIONS) return async () => ({ items: [] });
  const { BedrockRetriever, BedrockRewriter, DynamoDocStates, PgDocStates, searchTools } = await import('@hanaeum/search-server');
  const { DynamoClauseStore, regulationTools } = await import('@hanaeum/regulation-server');
  const t = searchTools({ retriever: new BedrockRetriever(e.KB_ID, e.MODEL_RERANK), states: e.GOV_STORE === 'postgres' ? new PgDocStates(db().query) : new DynamoDocStates(env('TABLE_DOCUMENTS')), regulation: regulationTools(new DynamoClauseStore(e.TABLE_REGULATIONS)),
    ...(e.MODEL_HAIKU ? { rewriter: new BedrockRewriter(e.MODEL_HAIKU) } : {}) }); // 질의 재구성 (let522mj PR #24). 없으면 규칙만
  return t.search_wiki as unknown as SearchWiki;
}

// 외부 법령: 본문 「…법」 중 내부 규정 저장소에 없는 것 (let522mj externalLaws) + 바로 뒤 조문 표기
async function externalLaws(text: string) {
  if (!process.env.TABLE_REGULATIONS) return [];
  const reg = (await import('@hanaeum/regulation-server')) as unknown as { externalLaws: (t: string, s: unknown) => Promise<string[]>; externalLawRefs?: (t: string, s: unknown) => Promise<{ law_name: string; clause?: string }[]>; DynamoClauseStore: new (t: string) => unknown };
  const store = new reg.DynamoClauseStore(process.env.TABLE_REGULATIONS);
  // 1) 괄호 표기 (let522mj PR #47 이 있으면 그 결과, 없으면 옛 「」 방식)
  const bracket: LawRef[] = reg.externalLawRefs ? await reg.externalLawRefs(text, store) : (await reg.externalLaws(text, store)).map((law_name) => {
    const m = new RegExp(`「${law_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}」\\s*(제\\d+조(?:의\\d+)?(?:제\\d+항)?)`).exec(text);
    return { law_name, ...(m ? { clause: m[1] } : {}) };
  });
  // 2) 괄호가 없어도 법령을 가리키는 곳 (사용자 지적 11/18): 모델이 뽑고, 내부 규정 저장소에 있는 이름은 뺀다
  const found = await structured<{ laws: LawRef[] }>('HAIKU', LAW_SYSTEM, text.slice(0, 20000), 'submit_laws', LAW_SCHEMA as unknown as Record<string, unknown>).then((r) => r.value.laws ?? []).catch(() => [] as LawRef[]);
  const external = await Promise.all(found.map(async (l) => ((await reg.externalLaws(`「${l.law_name}」`, store).catch(() => [])).length ? l : null)));
  return mergeLaws(bracket, external.filter((x): x is LawRef => !!x));
}

const app = createApp({
  verify: cognitoVerifier(env('COGNITO_USER_POOL_ID'), env('COGNITO_CLIENT_ID')),
  store: storeFromEnv(),
  webOrigins: (process.env.WEB_ORIGINS ?? '').split(',').filter(Boolean),
  presignPut,
  headObject,
  startWorkflow,
  resume,
  deleteWorkflow,
  presignGet,
  guide: (q, t) => invokeAgent(q, t),
  guideStream: invokeAgentStream,
  workflowFailure,
  workflowSteps,
  workflowRuns,
  presignView, viewPageList,
  putOriginal: (key: string, body: Uint8Array) => putOriginalOnly(key, body, 'text/markdown; charset=utf-8'),
  ...(process.env.GOV_STORE === 'postgres' ? { claims: await (async () => {
    const c = await import('./claims.ts');
    const d = db();
    return { list: (id: string) => c.docClaims(d.query, id), counts: (ids: string[]) => c.provisionCounts(d.query, ids), debt: () => c.knowledgeDebt(d.query) };
  })() } : {}),
  ...(process.env.GOV_STORE === 'postgres' ? { categories: await (async () => {
    const c = await import('./categories.ts');
    const d = db();
    return { list: () => c.listCategories(d.query), docMap: () => c.docCategories(d.query), rename: (id: string, name: string, actor: string) => c.renameCategory(d, id, name, actor), merge: (from: string, into: string, actor: string) => c.mergeCategory(d, from, into, actor) };
  })() } : {}),
  ...(process.env.USER_GATEWAY_URL ? { traceImpact: (a: { law: string }, t: string) => userTool('graph___trace_impact', a, t) } : {}),
  pages,
  marks,
  pageImage,
  pageImageList,
  explanation,
  pageSummary,
  structuredPages,
  externalLaws,
  judgeChange: async (prompt: string) => (await structured<{ verdict: 'APPROPRIATE' | 'INAPPROPRIATE' | 'UNKNOWN'; after?: string; reason: string }>('HAIKU', CHANGE_SYSTEM, prompt, 'submit_judgement', CHANGE_SCHEMA as unknown as Record<string, unknown>)).value,
  composeClarify: async (prompt: string) => (await structured<{ edits: { n: number; ok: boolean; after: string; reason?: string }[] }>('HAIKU', COMPOSE_SYSTEM, prompt, 'submit_edits', COMPOSE_SCHEMA as unknown as Record<string, unknown>)).value,
  ...(process.env.USER_GATEWAY_URL ? { officialLaw: (a: { law_name: string; clause?: string }, t: string) => userTool('regulation___fetch_official_law', a, t) } : {}),
  search: searchVia(await searchWiki()),
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
