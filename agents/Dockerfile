# AgentCore Runtime은 linux/arm64 고정 (docs/04 7장). 빌드 컨텍스트는 저장소 루트:
#   podman build --platform linux/arm64 -f agents/Dockerfile .
FROM node:24-slim
WORKDIR /app/agents
ENV NODE_ENV=production
COPY agents/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY agents/src ./src
# 질의·답변 PII 검사는 API 단계 6과 같은 순수 함수를 쓴다 (의존성 없음)
COPY apps/api/src/steps/pii-detect.ts /app/apps/api/src/steps/pii-detect.ts
USER node
EXPOSE 8080
CMD ["node", "src/runtime.ts"]
