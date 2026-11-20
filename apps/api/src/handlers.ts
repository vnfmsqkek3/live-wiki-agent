// Lambda 진입점 (esbuild로 단일 파일 번들). 함수별 handler 이름: handlers.<name>
import { applyGuardrail, getJson, getObjectBytes, headObject, listKeys, purgePrefix, putBytes, putJson, startWorkflow, storeFromEnv } from './aws.ts';
import {
  makeClassify, makeReferenceCheck, makeFileStructureCheck, makeFinalize, makeFreshnessSweep, makeInjectionScan, makePiiScan, makeTrustGate, makeTypeDetection, makeWaitForApproval,
  type LambdaDeps, type SegmentDeps,
} from './lambdas.ts';
import { structured, embed } from './model.ts';
import { STRUCTURE_SCHEMA, STRUCTURE_SYSTEM } from './steps/structure.ts';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { CLARIFY_SCHEMA, CLARIFY_SYSTEM, SUGGEST_CLARIFY_SCHEMA, SUGGEST_CLARIFY_SYSTEM, type ClarifyCandidate, type WikiHit } from './steps/clarify.ts';
import { AgentCoreWebSearcher } from './web-search.ts';
import { CLASSIFY_SCHEMA, CLASSIFY_SYSTEM, SUMMARY_SCHEMA, SUMMARY_SYSTEM, type ClassifyOut, type SummaryOut } from './steps/classify.ts';
import { JUDGE_SCHEMA, JUDGE_SYSTEM, judgePrompt, SUGGEST_SCHEMA, SUGGEST_SYSTEM, suggestPrompt, type Judgement } from './steps/knowhow.ts';
import { knowhowDeps, type ClauseStoreLike } from './knowhow-deps.ts';
import { findExternalLaws } from './law-refs.ts';
import { DynamoClauseStore, regulationTools } from '@hanaeum/regulation-server';
import { BedrockRetriever, DynamoDocStates, PgDocStates, searchTools } from '@hanaeum/search-server';
import { db } from '@hanaeum/db';
import { extractCitations } from '@hanaeum/graph-server';

const store = storeFromEnv();
/** 마스킹 본문 (masked/segments, 페이지 순) */
const maskedPages = async (d: { doc_id: string }) => {
  const keys = (await listKeys(`${d.doc_id}/masked/segments/`)).filter((k) => k.endsWith('.json'));
  return (await Promise.all(keys.map((k) => getJson<{ page_index: number; text: string }>(k)))).map((x) => ({ page: x.page_index, text: x.text })).sort((a, b) => a.page - b.page);
};
const maskedText = async (d: { doc_id: string }) => (await maskedPages(d)).map((x) => x.text).join('\n');

/** Trusted Registry 대조 (let522mj @hanaeum/regulation-server registryMatch, PR #4). 없으면 대조 생략 → REGULATION은 REVIEW_REQUIRED */
const registry: LambdaDeps['registry'] = process.env.TABLE_REGULATIONS
  ? async (hash, text) => {
    const m = (await import('@hanaeum/regulation-server')) as Record<string, unknown>;
    if (typeof m.registryMatch !== 'function' || typeof m.DynamoClauseStore !== 'function') return {};
    const Store = m.DynamoClauseStore as new (table: string) => unknown;
    return (m.registryMatch as (s: unknown, h: string, t?: string) => ReturnType<NonNullable<LambdaDeps['registry']>>)(new Store(process.env.TABLE_REGULATIONS!), hash, text);
  }
  : undefined;

/** mcp-regulation fetch_official_law 를 Lambda 직접 호출 (clarifyWiki 와 같은 방식). 오류·없음은 null */
const fetchOfficialLawVia = (fn: string) => {
  const lambda = new LambdaClient({});
  return async (a: { law_name: string; clause: string }) => {
    const r = await lambda.send(new InvokeCommand({ FunctionName: fn,
      ClientContext: Buffer.from(JSON.stringify({ custom: { bedrockAgentCoreToolName: 'fetch_official_law' } })).toString('base64'),
      Payload: Buffer.from(JSON.stringify({ law_name: a.law_name, clause: a.clause, __actor: { sub: 'system:trust-gate', groups: [] } })) }));
    const out = JSON.parse(Buffer.from(r.Payload ?? new Uint8Array()).toString('utf8') || '{}') as { error?: unknown; clause?: { path: string; text: string } | null; url?: string; effective_from?: string };
    return out.error || r.FunctionError ? null : { clause: out.clause ?? null, ...(out.url ? { url: out.url } : {}), ...(out.effective_from ? { effective_from: out.effective_from } : {}) };
  };
};

/** 노하우 검증 실제 Tool (규정 저장소·KB 검색·Sonnet 판정). KB_ID·TABLE_REGULATIONS 있을 때만. 검색은 시스템 행위자(승인자 범위)로 ACL·현재 상태 재검증 */
const e = process.env;
const knowhow: LambdaDeps['knowhow'] = e.TABLE_REGULATIONS && e.KB_ID
  ? (() => {
    const clauses = new DynamoClauseStore(e.TABLE_REGULATIONS);
    const search = searchTools({ retriever: new BedrockRetriever(e.KB_ID, e.MODEL_RERANK), states: e.GOV_STORE === 'postgres' ? new PgDocStates(db().query) : new DynamoDocStates(e.TABLE_DOCUMENTS!), regulation: regulationTools(clauses) });
    const system = { sub: 'system:trust-gate', groups: ['REG_APPROVER'] };
    return {
      maskedText,
      ...knowhowDeps({
        store: clauses as unknown as ClauseStoreLike,
        extract: (t, st, asOf) => extractCitations(t, st as never, asOf),
        searchProvisionIds: async (q) => ((await search.search_wiki({ query: q, index_groups: ['legal-clauses'], top_k: 5 }, system)).items ?? [])
          .filter((i) => i.search_status === 'FOUND').map((i) => i.provision_id).filter(Boolean),
        judge: async (t, cl) => {
          const r = await structured<{ items: Judgement[] }>('SONNET', JUDGE_SYSTEM, judgePrompt(t, cl), 'submit_judgement', JUDGE_SCHEMA as unknown as Record<string, unknown>);
          return { items: r.value.items, model: r.model };
        },
        suggest: async (items) => (await structured<{ suggestions: string[] }>('HAIKU', SUGGEST_SYSTEM, suggestPrompt(items), 'submit_suggestions', SUGGEST_SCHEMA as unknown as Record<string, unknown>)).value.suggestions,
      }),
      // 외부 법령 대조 (AI팀 PR #76): 찾기는 문서보관함 '외부 법령 참고'와 같은 로직, 원문은 mcp-regulation Lambda fetch_official_law 직접 Invoke
      // (Browser 권한·1일 캐시는 그 Lambda 쪽에. 이 Lambda 는 lambda:InvokeFunction 만). MCP_REGULATION_FN 없으면 외부 대조 생략
      ...(e.MCP_REGULATION_FN ? { external: { findLaws: findExternalLaws, fetchLaw: fetchOfficialLawVia(e.MCP_REGULATION_FN), timeoutMs: 60_000 } } : {}),
    };
  })()
  : undefined;

const deps: LambdaDeps = {
  store, headObject, getObjectBytes, startWorkflow, registry, maskedText, maskedPages, knowhow, purge: purgePrefix,
  ...(process.env.GOV_STORE === 'postgres' ? { saveClaims: async (doc_id: string, items: import('./steps/knowhow.ts').KnowhowValidation['items'], pageOf: (s: string) => number | null, revisedTo?: (pid: string) => Promise<string | undefined>) => {
    const [{ db }, c] = await Promise.all([import('@hanaeum/db'), import('./claims.ts')]);
    return c.saveClaims(db().tx, doc_id, items, pageOf, revisedTo);
  } } : {}),
};
const seg: SegmentDeps = {
  store, listKeys, getJson, putJson, guardrail: applyGuardrail,
  getBytes: (k) => getObjectBytes(k), putBytes, // PiiScan 페이지 이미지 마스킹 (steps Role). 모델 Role은 masked/만 읽음
  classify: (tier, prompt) => structured<ClassifyOut>(tier, CLASSIFY_SYSTEM, prompt, 'submit_classification', CLASSIFY_SCHEMA as unknown as Record<string, unknown>),
  summarize: (prompt) => structured<SummaryOut>('HAIKU', SUMMARY_SYSTEM, prompt, 'submit_summary', SUMMARY_SCHEMA as unknown as Record<string, unknown>),
  ...(process.env.GOV_STORE === 'postgres' && process.env.MODEL_EMBED ? {
    category: async (doc: { doc_id: string; title: string; summary?: string }) => {
      const [{ db }, c] = await Promise.all([import('@hanaeum/db'), import('./categories.ts')]);
      const d = db();
      return c.assignCategory({ q: d.query, tx: d.tx, embed, choose: (p) => structured<import('./categories.ts').Choice>('HAIKU', c.CHOOSE_SYSTEM, p, 'submit_category', c.CHOOSE_SCHEMA as unknown as Record<string, unknown>) }, doc);
    },
  } : {}),
  structure: (prompt) => structured<{ markdown: string }>('HAIKU', STRUCTURE_SYSTEM, prompt, 'submit_page', STRUCTURE_SCHEMA as unknown as Record<string, unknown>),
};

export const typeDetection = makeTypeDetection(deps);
export const fileStructureCheck = makeFileStructureCheck(deps);
export const piiScan = makePiiScan(seg);
export const injectionScan = makeInjectionScan(seg);
export const classify = makeClassify(seg);
// 확인 필요 Clarify (6.5, 6.4 확장): Lambda reference-check, handler handlers.referenceCheck. REFERENCE_CHECK=on 일 때만.
// 위키 검색은 KB_ID 가 있을 때(search-server search_wiki, 일반 직원 권한으로 게시 문서만), 웹은 Browser 권한
const clarifyWiki = process.env.MCP_SEARCH_FN
  ? (() => {
    // mcp-search Lambda 직접 Invoke (let522mj 제안·yoyo0704 확정 11/18). __actor groups [] = ACL ALL 공개 문서만. 원문·검색어는 로그에 남기지 않는다
    const lambda = new LambdaClient({});
    const call = async (query: string, category?: string): Promise<WikiHit[]> => {
      const r = await lambda.send(new InvokeCommand({ FunctionName: process.env.MCP_SEARCH_FN,
        ClientContext: Buffer.from(JSON.stringify({ custom: { bedrockAgentCoreToolName: 'search_wiki' } })).toString('base64'),
        Payload: Buffer.from(JSON.stringify({ query, top_k: 5, rewrite: false, ...(category ? { category } : {}), __actor: { sub: 'system:reference-check', groups: [] } })) }));
      const out = JSON.parse(Buffer.from(r.Payload ?? new Uint8Array()).toString('utf8') || '{}') as { error?: string; items?: { doc_id: string; title: string; page?: number; snippet: string; quotable?: boolean }[] };
      if (out.error) throw new Error('mcp-search error');
      return (out.items ?? []).filter((h) => h.quotable !== false).map((h, n) => ({ id: `w${n + 1}`, doc_id: h.doc_id, title: h.title, text: h.snippet, ...(h.page ? { page: h.page } : {}) }));
    };
    // 같은 분류에서 한 번, 비면 분류 없이 한 번
    return async (query: string, category?: string) => { const first = category ? await call(query, category) : []; return first.length ? first : call(query); };
  })()
  : undefined;
export const referenceCheck = makeReferenceCheck({
  ...seg,
  ...(process.env.REFERENCE_CHECK === 'on' ? {
    findClarify: (prompt: string) => structured<{ items: ClarifyCandidate[] }>('HAIKU', CLARIFY_SYSTEM, prompt, 'submit_clarify', CLARIFY_SCHEMA as unknown as Record<string, unknown>),
    suggestClarify: (prompt: string) => structured<{ suggestions: { n: number; value: string; after: string; source_id: string }[] }>('HAIKU', SUGGEST_CLARIFY_SYSTEM, prompt, 'submit_suggestions', SUGGEST_CLARIFY_SCHEMA as unknown as Record<string, unknown>),
    ...(clarifyWiki ? { wiki: clarifyWiki } : {}),
    ...(e.GOV_STORE === 'postgres' ? { categoryOf: async (id: string) => (await db().query<{ path: string }>('SELECT c.path FROM documents d JOIN categories c ON c.category_id = d.category_id WHERE d.doc_id = :id', { id }))[0]?.path } : {}),
    web: new AgentCoreWebSearcher(),
  } : {}),
}); // 모델 호출 Role (hanaeum-model-caller=true, 원본·work 읽기 거부)
export const trustGate = makeTrustGate(deps);
export const waitForApproval = makeWaitForApproval(deps);
export const awaitReview = waitForApproval; // AgentCore 오케스트레이터 Tool 이름
export const finalize = makeFinalize(deps);
export const freshnessSweep = makeFreshnessSweep(deps); // EventBridge 일 1회 (시행일 도래 개정판)
