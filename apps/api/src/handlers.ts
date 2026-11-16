// Lambda 진입점 (esbuild로 단일 파일 번들). 함수별 handler 이름: handlers.<name>
import { getObjectBytes, headObject, startWorkflow, storeFromEnv } from './aws.ts';
import { makeFileStructureCheck, makeFinalize, makeTrustGate, makeTypeDetection, makeWaitForApproval, type LambdaDeps } from './lambdas.ts';

const deps: LambdaDeps = { store: storeFromEnv(), headObject, getObjectBytes, startWorkflow };

export const typeDetection = makeTypeDetection(deps);
export const fileStructureCheck = makeFileStructureCheck(deps);
export const trustGate = makeTrustGate(deps);
export const waitForApproval = makeWaitForApproval(deps);
export const finalize = makeFinalize(deps);
