# ConvertToPdf 컨테이너 Lambda (arm64). 빌드: terraform apply → CodeBuild(podman), 컨텍스트 = 저장소 루트.
# LibreOffice(writer, GUI 없음) + 한글 글꼴(noto-cjk·nanum) + Java(H2Orestart HWPX 필터) + Node 24(handler.ts 타입 제거 실행)
# 참고: megazone-idp format-parser 와 같은 방식(LibreOffice headless 컨테이너 Lambda). Docker Hub 대신 ECR Public 미러
FROM public.ecr.aws/docker/library/debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 HOME=/tmp
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-java-common default-jre-headless \
      fonts-noto-cjk fonts-nanum ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Node 24 LTS (11/17 조회: v24.22.3, 2026-11-10)
ARG NODE_VERSION=24.22.3
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" | tar -xJ -C /usr/local --strip-components=1 \
 && node --version

# HWPX 필터 H2Orestart (11/17 조회: v0.8.0, 2026-10-18). 설치 실패해도 이미지는 만든다 → HWPX 는 기존 방식(XML 글자)으로 계속
ARG H2O_VERSION=v0.8.0
RUN (curl -fsSL -o /tmp/H2Orestart.oxt "https://github.com/ebandal/H2Orestart/releases/download/${H2O_VERSION}/H2Orestart.oxt" \
      && unopkg add --shared /tmp/H2Orestart.oxt && echo "H2Orestart ${H2O_VERSION} installed") \
    || echo "H2Orestart install failed: HWPX falls back to XML text" ; rm -f /tmp/H2Orestart.oxt

WORKDIR /var/task
COPY services/convert-pdf/package.json ./
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock
COPY packages/db/package.json packages/db/index.js node_modules/@hanaeum/db/
COPY services/convert-pdf/handler.ts services/convert-pdf/index.ts services/convert-pdf/runtime.mjs services/convert-pdf/registrymodifications.xcu ./

# 첫 호출 지연을 줄이려고 빌드 때 LibreOffice 프로필을 한 번 만들어 둔다 (런타임은 /tmp 프로필 사용)
RUN timeout 120 soffice --headless --norestore --terminate_after_init -env:UserInstallation=file:///tmp/lo-warm || true

ENTRYPOINT ["node", "/var/task/runtime.mjs"]
