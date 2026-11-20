#!/usr/bin/env bash
# 하나이음 QA 실행 (.claude/agents/hanaeum-qa.md). 헤드리스 Chrome을 띄우고 qa-flow.mjs에 계정 비밀번호를 stdin으로 넘긴다(출력 안 함).
#   set -a; . ./.env.local; set +a; tests/e2e/qa-run.sh
#   prod 단일 환경(11/20): QA_BASE=https://<prod CloudFront> tests/e2e/qa-run.sh  (데모: QA_SCRIPT=qa-demo.mjs)
set -euo pipefail
cd "$(dirname "$0")/../.."
export QA_OUT=${QA_OUT:-${TMPDIR:-/tmp}/hanaeum-qa-$(date +%Y%m%d-%H%M)}
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
mkdir -p "$QA_OUT"
"$CHROME" --headless=new --disable-gpu --remote-debugging-port=${QA_CDP:-9333} --user-data-dir="$QA_OUT/chrome" --window-size=520,1200 about:blank >/dev/null 2>&1 &
CPID=$!
trap 'kill $CPID 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do curl -s "http://127.0.0.1:${QA_CDP:-9333}/json/version" >/dev/null && break; sleep 0.5; done
aws secretsmanager get-secret-value --secret-id "${QA_SECRET:-hanaeum-mvp/demo-users}" --query SecretString --output text \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k:(v["password"] if isinstance(v,dict) else v) for k,v in d.items()}))' \
  | node tests/e2e/${QA_SCRIPT:-qa-flow.mjs}
echo "QA_OUT=$QA_OUT"
