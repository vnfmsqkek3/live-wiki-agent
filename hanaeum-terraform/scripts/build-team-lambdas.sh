#!/usr/bin/env bash
# 다른 Owner 의 Lambda 코드를 빌드해 hanaeum-terraform/.artifacts/ 에 zip 으로 모은다 (stack/team_lambdas.tf 가 배포).
# 각 Owner 의 빌드 명령을 그대로 쓴다. 코드는 수정하지 않는다.
#   dhxorb96: apps/api `npm run build:lambda` → handlers.mjs (handler handlers.<name>)
#   let522mj: `node services/legal-etl/scripts/build-lambdas.ts` → dist/lambda/{name}.zip (handler index.handler)
# 사용: hanaeum-terraform/scripts/build-team-lambdas.sh [dhxorb96_ref=origin/main] [let522mj_ref=origin/main]
#   PR 머지 전에는 origin/dhxorb96, origin/let522mj 처럼 브랜치를 넘긴다.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
OUT="$ROOT/hanaeum-terraform/.artifacts"
WT="$OUT/.src"
REF_D=${1:-origin/main}; REF_L=${2:-origin/main}
git -C "$ROOT" fetch -q origin
mkdir -p "$OUT"

build() { # name ref command...
  local name=$1 ref=$2; shift 2
  rm -rf "$WT/$name"; git -C "$ROOT" worktree prune
  git -C "$ROOT" worktree add -q --detach "$WT/$name" "$ref"
  (cd "$WT/$name" && npm ci --no-audit --no-fund >/dev/null && "$@")
  echo "$name $(git -C "$WT/$name" rev-parse --short HEAD) ($ref)" >> "$OUT/SOURCES.txt"
}

: > "$OUT/SOURCES.txt"
build dhxorb96 "$REF_D" npm run build:lambda -w apps/api --silent
(cd "$WT/dhxorb96/apps/api/dist" && rm -f "$OUT/dhxorb96-handlers.zip" && zip -qj "$OUT/dhxorb96-handlers.zip" handlers.mjs)

build let522mj "$REF_L" node services/legal-etl/scripts/build-lambdas.ts
cp "$WT/let522mj/dist/lambda/"*.zip "$OUT/"

for d in "$WT"/*; do git -C "$ROOT" worktree remove --force "$d"; done
ls -1 "$OUT"/*.zip | xargs -n1 basename
cat "$OUT/SOURCES.txt"
