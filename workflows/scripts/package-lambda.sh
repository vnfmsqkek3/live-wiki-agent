#!/usr/bin/env bash
# workflows Lambda 배포 디렉터리 workflows/.lambda 를 만든다 (Terraform sfn 모듈이 zip).
# 런타임 의존성(pdfjs-dist + @napi-rs/canvas)은 Lambda(linux arm64, glibc)용 바이너리로 설치한다. AWS SDK 는 런타임 내장.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build --silent
rm -rf .lambda && mkdir -p .lambda
cp -R dist/. .lambda/
node -e '
const p = require("./package.json");
// 팀 워크스페이스 패키지(@hanaeum/*)는 레지스트리에서 받지 않는다 (같은 이름 외부 패키지 설치 방지) → 아래에서 소스 복사
const deps = Object.fromEntries(Object.entries(p.dependencies).filter(([n]) => !n.startsWith("@hanaeum/")));
require("fs").writeFileSync(".lambda/package.json", JSON.stringify({ type: "module", private: true, dependencies: deps }, null, 2));
'
npm install --prefix .lambda --omit=dev --no-package-lock --no-audit --no-fund --os=linux --cpu=arm64 --libc=glibc >/dev/null
mkdir -p .lambda/node_modules/@hanaeum/pii .lambda/node_modules/@hanaeum/db && cp ../packages/pii/package.json ../packages/pii/index.js .lambda/node_modules/@hanaeum/pii/ && cp ../packages/db/package.json ../packages/db/index.js .lambda/node_modules/@hanaeum/db/
ls .lambda/node_modules/@napi-rs/ | grep -q canvas-linux-arm64-gnu || { echo "linux arm64 canvas binary missing" >&2; exit 1; }
du -sh .lambda | cut -f1
