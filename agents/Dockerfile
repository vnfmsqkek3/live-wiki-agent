# AgentCore Runtime은 linux/arm64 고정 (docs/04 7장). 빌드 컨텍스트는 저장소 루트:
#   podman build --platform linux/arm64 -f agents/Dockerfile .
FROM node:24-slim
WORKDIR /app/agents
ENV NODE_ENV=production
COPY agents/package.json ./
# 워크스페이스 패키지(@hanaeum/pii)는 레지스트리에 없으므로 빼고 설치한 뒤 소스를 직접 넣는다
RUN npm pkg delete "dependencies.@hanaeum/pii" && npm install --omit=dev --no-audit --no-fund
COPY packages/pii ./node_modules/@hanaeum/pii
COPY agents/src ./src
USER node
EXPOSE 8080
CMD ["node", "src/runtime.ts"]
