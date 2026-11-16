# API(Hono) → ECS Fargate (ALB 대상, 헬스체크 GET /healthz). 빌드 컨텍스트는 저장소 루트:
#   docker buildx build --platform linux/arm64 -f apps/api/Dockerfile .
# 실행 env: docs 참고 (COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, TABLE_*, BUCKET_QUARANTINE, PIPELINE_RUNTIME_ARN, AGENT_RUNTIME_ARN, WEB_ORIGINS 등)
FROM node:24-slim AS build
WORKDIR /src
COPY . .
RUN npm ci -w apps/api --no-audit --no-fund && npm run build:server -w apps/api

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /src/apps/api/dist/server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
