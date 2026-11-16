# 웹(Next.js standalone) → ECS Fargate. 빌드 컨텍스트는 저장소 루트:
#   docker buildx build --platform linux/arm64 -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_COGNITO_CLIENT_ID=<client id> .
# NEXT_PUBLIC_* 는 빌드 시 고정된다. API_URL 기본값 ''= 같은 도메인(CloudFront /v1/* → API ALB 대상)
FROM node:24-slim AS build
WORKDIR /src
COPY . .
RUN npm ci -w apps/web --no-audit --no-fund
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_AWS_REGION=us-east-1
ARG NEXT_PUBLIC_COGNITO_CLIENT_ID
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_AWS_REGION=$NEXT_PUBLIC_AWS_REGION NEXT_PUBLIC_COGNITO_CLIENT_ID=$NEXT_PUBLIC_COGNITO_CLIENT_ID NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/web

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /src/apps/web/.next/standalone ./
COPY --from=build /src/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
