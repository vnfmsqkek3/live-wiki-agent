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
require("fs").writeFileSync(".lambda/package.json", JSON.stringify({ type: "module", private: true, dependencies: p.dependencies }, null, 2));
'
npm install --prefix .lambda --omit=dev --no-package-lock --no-audit --no-fund --os=linux --cpu=arm64 --libc=glibc >/dev/null
ls .lambda/node_modules/@napi-rs/ | grep -q canvas-linux-arm64-gnu || { echo "linux arm64 canvas binary missing" >&2; exit 1; }
du -sh .lambda | cut -f1
