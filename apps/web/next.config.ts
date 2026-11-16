import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

// ECS Fargate 컨테이너 배포용 standalone 출력 (모노레포 루트 기준 의존성 추적)
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
};
export default config;
