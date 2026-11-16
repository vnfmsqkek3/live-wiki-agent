// Lambda 진입점 (esbuild로 단일 파일 번들). 함수별 handler 이름: handlers.<name>
import { applyGuardrail, getJson, getObjectBytes, headObject, listKeys, putJson, startWorkflow, storeFromEnv } from './aws.ts';
import {
  makeClassify, makeFileStructureCheck, makeFinalize, makeInjectionScan, makePiiScan, makeTrustGate, makeTypeDetection, makeWaitForApproval,
  type LambdaDeps, type SegmentDeps,
} from './lambdas.ts';
import { structured } from './model.ts';
import { CLASSIFY_SCHEMA, CLASSIFY_SYSTEM, type ClassifyOut } from './steps/classify.ts';

const store = storeFromEnv();
/** 마스킹 본문 (masked/segments, 페이지 순) */
const maskedText = async (d: { doc_id: string }) => {
  const keys = (await listKeys(`${d.doc_id}/masked/segments/`)).filter((k) => k.endsWith('.json'));
  return (await Promise.all(keys.map((k) => getJson<{ text: string }>(k)))).map((x) => x.text).join('\n');
};

/** Trusted Registry 대조 (let522mj @hanaeum/regulation-server registryMatch, PR #4). 없으면 대조 생략 → REGULATION은 REVIEW_REQUIRED */
const registry: LambdaDeps['registry'] = process.env.TABLE_REGULATIONS
  ? async (hash, text) => {
    const m = (await import('@hanaeum/regulation-server')) as Record<string, unknown>;
    if (typeof m.registryMatch !== 'function' || typeof m.DynamoClauseStore !== 'function') return {};
    const Store = m.DynamoClauseStore as new (table: string) => unknown;
    return (m.registryMatch as (s: unknown, h: string, t?: string) => ReturnType<NonNullable<LambdaDeps['registry']>>)(new Store(process.env.TABLE_REGULATIONS!), hash, text);
  }
  : undefined;

const deps: LambdaDeps = { store, headObject, getObjectBytes, startWorkflow, registry, maskedText };
const seg: SegmentDeps = {
  store, listKeys, getJson, putJson, guardrail: applyGuardrail,
  classify: (tier, prompt) => structured<ClassifyOut>(tier, CLASSIFY_SYSTEM, prompt, 'submit_classification', CLASSIFY_SCHEMA as unknown as Record<string, unknown>),
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
