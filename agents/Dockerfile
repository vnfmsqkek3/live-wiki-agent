# AgentCore Runtime은 linux/arm64 고정 (docs/04 7장)
FROM --platform=linux/arm64 node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/runtime.ts"]
