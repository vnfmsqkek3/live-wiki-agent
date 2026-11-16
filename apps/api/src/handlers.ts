// Lambda 진입점 (esbuild로 단일 파일 번들). 함수별 handler 이름: handlers.<name>
import { applyGuardrail, getJson, getObjectBytes, headObject, listKeys, purgePrefix, putBytes, putJson, startWorkflow, storeFromEnv } from './aws.ts';
import {
  makeClassify, makeFileStructureCheck, makeFinalize, makeFreshnessSweep, makeInjectionScan, makePiiScan, makeTrustGate, makeTypeDetection, makeWaitForApproval,
  type LambdaDeps, type SegmentDeps,
} from './lambdas.ts';
import { structured } from './model.ts';
import { CLASSIFY_SCHEMA, CLASSIFY_SYSTEM, SUMMARY_SCHEMA, SUMMARY_SYSTEM, type ClassifyOut, type SummaryOut } from './steps/classify.ts';
import { JUDGE_SCHEMA, JUDGE_SYSTEM, judgePrompt, type Judgement } from './steps/knowhow.ts';
import { knowhowDeps, type ClauseStoreLike } from './knowhow-deps.ts';
import { DynamoClauseStore, regulationTools } from '@hanaeum/regulation-server';
import { BedrockRetriever, DynamoDocStates, searchTools } from '@hanaeum/search-server';
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

/** 노하우 검증 실제 Tool (규정 저장소·KB 검색·Sonnet 판정). KB_ID·TABLE_REGULATIONS 있을 때만. 검색은 시스템 행위자(승인자 범위)로 ACL·현재 상태 재검증 */
const e = process.env;
const knowhow: LambdaDeps['knowhow'] = e.TABLE_REGULATIONS && e.KB_ID
  ? (() => {
    const clauses = new DynamoClauseStore(e.TABLE_REGULATIONS);
    const search = searchTools({ retriever: new BedrockRetriever(e.KB_ID, e.MODEL_RERANK), states: new DynamoDocStates(e.TABLE_DOCUMENTS!), regulation: regulationTools(clauses) });
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
      }),
    };
  })()
  : undefined;

const deps: LambdaDeps = { store, headObject, getObjectBytes, startWorkflow, registry, maskedText, maskedPages, knowhow, purge: purgePrefix };
const seg: SegmentDeps = {
  store, listKeys, getJson, putJson, guardrail: applyGuardrail,
  getBytes: (k) => getObjectBytes(k), putBytes, // PiiScan 페이지 이미지 마스킹 (steps Role). 모델 Role은 masked/만 읽음
  classify: (tier, prompt) => structured<ClassifyOut>(tier, CLASSIFY_SYSTEM, prompt, 'submit_classification', CLASSIFY_SCHEMA as unknown as Record<string, unknown>),
  summarize: (prompt) => structured<SummaryOut>('HAIKU', SUMMARY_SYSTEM, prompt, 'submit_summary', SUMMARY_SCHEMA as unknown as Record<string, unknown>),
};

export const typeDetection = makeTypeDetection(deps);
export const fileStructureCheck = makeFileStructureCheck(deps);
export const piiScan = makePiiScan(seg);
export const injectionScan = makeInjectionScan(seg);
export const classify = makeClassify(seg); // 모델 호출 Role (hanaeum-model-caller=true, 원본·work 읽기 거부)
export const trustGate = makeTrustGate(deps);
export const waitForApproval = makeWaitForApproval(deps);
export const awaitReview = waitForApproval; // AgentCore 오케스트레이터 Tool 이름
export const finalize = makeFinalize(deps);
export const freshnessSweep = makeFreshnessSweep(deps); // EventBridge 일 1회 (시행일 도래 개정판)
