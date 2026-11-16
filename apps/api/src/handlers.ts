// Lambda 진입점 (esbuild로 단일 파일 번들). 함수별 handler 이름: handlers.<name>
import { applyGuardrail, getJson, getObjectBytes, headObject, listKeys, putJson, startWorkflow, storeFromEnv } from './aws.ts';
import {
  makeClassify, makeFileStructureCheck, makeFinalize, makeInjectionScan, makePiiScan, makeTrustGate, makeTypeDetection, makeWaitForApproval,
  type LambdaDeps, type SegmentDeps,
} from './lambdas.ts';
import { structured } from './model.ts';
import { CLASSIFY_SCHEMA, CLASSIFY_SYSTEM, type ClassifyOut } from './steps/classify.ts';

const store = storeFromEnv();
const deps: LambdaDeps = { store, headObject, getObjectBytes, startWorkflow };
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
export const finalize = makeFinalize(deps);
