// Lambda 진입점 (esbuild 번들)
import { storeFromEnv } from '../../../apps/api/src/aws.ts';
import { makeHandler } from './index.ts';

export const handler = makeHandler(storeFromEnv());
