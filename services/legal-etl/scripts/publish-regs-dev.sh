#!/usr/bin/env bash
# 공유 dev에 규정 기준본 PDF를 실제 파이프라인으로 게시 (업로드 → AgentCore 오케스트레이터 → TrustGate Registry 대조 → 사람 승인(API) → Promote → KbIngest → PUBLISHED)
# 승인 없이 KB에 직접 넣지 않는다 (docs/02 승인 전 검색 제외). 데이터는 SYNTHETIC 합성 규정만.
# 사용: API=http://localhost:8091 services/legal-etl/scripts/publish-regs-dev.sh G-REG-01 G-REV-01 F-002 ...  (이미 올린 문서는 G-REG-01=doc_…)
#       노하우(K-*, G-K*)는 KNOWLEDGE로 분류해 같은 흐름으로 게시한다.
#       EXPECT=block: 위조·공격·충돌 노하우 문서 (충돌 노하우를 기본 모드로 올리면 자동 승인돼 게시된다). 게시 요청이 받아들여지면 승인하지 않고 반려한다 (사람이 막는 경로). 결과에 차단 지점을 남긴다.
# 전제: 승인 API 실행 중, .env.local 로드. 결과는 stdout 표 (id doc_id 상태)
set -euo pipefail
cd "$(dirname "$0")/../../.."
API=${API:-http://localhost:8080}
# HANAEUM_ENV=prod 이면 prod (SSM /hanaeum-mvp/prod/, Secret hanaeum-mvp/demo-users). 기본 dev
ENV_NAME=${HANAEUM_ENV:-dev}
# .env.local 의 개인 dev(dev-{닉네임})는 공유 dev로 본다. 허용: dev*, prod
case "$ENV_NAME" in prod) ;; dev|dev-*) ENV_NAME=dev;; *) echo "HANAEUM_ENV: dev|prod" >&2; exit 1;; esac
ssm() { aws ssm get-parameter --name "/hanaeum-mvp/$ENV_NAME/$1" --query Parameter.Value --output text; }
CLIENT=$(ssm COGNITO_CLIENT_ID)
j() { python3 -c 'import json,sys; d=json.load(sys.stdin)
for k in sys.argv[1].split("."): d=d.get(k) if isinstance(d,dict) else None
print("" if d is None else d)' "$1"; }
secret=$(aws secretsmanager get-secret-value --secret-id "hanaeum-mvp/demo-users$([ "$ENV_NAME" = prod ] || echo -dev)" --query SecretString --output text)
token() { local p; p=$(python3 -c 'import json,sys; v=json.loads(sys.argv[1])[sys.argv[2]]; print(v["password"] if isinstance(v,dict) else v)' "$secret" "$1")
  aws cognito-idp initiate-auth --client-id "$CLIENT" --auth-flow USER_PASSWORD_AUTH --auth-parameters "USERNAME=$1,PASSWORD=$p" --query AuthenticationResult.AccessToken --output text; }
call() { curl -sS -X "$2" "$API$3" -H "authorization: Bearer $1" -H 'content-type: application/json' ${4:+-d "$4"} -w '\n%{http_code}'; }
code() { tail -1 <<<"$1"; }; bodyof() { sed '$d' <<<"$1"; }
pdf() { [ -f "$1" ] && { echo "$1"; return; }; case "$1" in G-*) echo "tests/fixtures/golden/pdf/$1.pdf";; A-002) echo "tests/fixtures/documents/A-002.png";; *) echo "tests/fixtures/documents/pdf/$1.pdf";; esac; }
kind() { case "$1" in K-*|G-K*|G-INJ-*|A-*) echo KNOWLEDGE;; *) echo REGULATION;; esac; }  # 공격 샘플은 노하우 형식
title() { [ "$(kind "$1")" = KNOWLEDGE ] || [ "${EXPECT:-}" = block ] && { python3 -c 'import sys,re
for f in ["tests/fixtures/golden/"+sys.argv[1]+".md","tests/fixtures/documents/"+sys.argv[1]+".md"]:
  try: m=re.search(r"^title: (.*)$",open(f).read(),re.M); print("[SYNTHETIC] "+(m.group(1) if m else sys.argv[1])); sys.exit()
  except FileNotFoundError: pass
print("[SYNTHETIC] "+sys.argv[1])' "$1"; return; }
  python3 -c 'import json,sys,re
for f in ["tests/fixtures/registry/registry.json","tests/fixtures/registry/registry.golden.json"]:
  for r in json.load(open(f))["regulations"]:
    if re.sub(r"^.*/|\.txt$","",r["fixture"])==sys.argv[1]: print("[SYNTHETIC] %s (%s)" % (r["law_name"], r["revision_id"])); sys.exit()' "$1"; }
doc() { call "$AT" GET "/v1/documents/$1"; }

AT=$(token user); PT=$(token admin) # 계정 2종: user(USER+AUTHOR) 업로드·admin 승인 (자기 승인 금지)
declare -A DOC
# 1) 업로드 전부 (파이프라인은 승인 대기까지 병렬로 진행)
IDS=()
for arg in "$@"; do
  id=${arg%%=*}; IDS+=("$id")
  if [[ $arg == *=* ]]; then DOC[$id]=${arg#*=}; echo "기존 $id ${DOC[$id]}"; continue; fi  # 이미 올린 문서 이어서 처리: G-REG-01=doc_…
  f=$(pdf "$id")
  R=$(call "$AT" POST /v1/documents/upload-url "{\"filename\":\"$(basename "$f")\",\"size\":$(wc -c <"$f" | tr -d ' '),\"title\":\"$(title "$id")\",\"dept\":\"공통\",\"acl_groups\":[\"ALL\"]}")
  [ "$(code "$R")" = 201 ] || { echo "$id upload-url 실패 $(bodyof "$R")"; continue; }
  DOC[$id]=$(bodyof "$R" | j doc_id)
  curl -sS -f -X PUT --data-binary @"$f" "$(bodyof "$R" | j url)" >/dev/null && echo "업로드 $id ${DOC[$id]}"
done
# 2) 한 건씩: 승인 대기 도달 → (분류 보정) → 게시 요청 → 승인 → PUBLISHED 확인
for id in "${IDS[@]}"; do
  d=${DOC[$id]:-}; [ -n "$d" ] || continue
  for _ in $(seq 1 90); do R=$(doc "$d"); LC=$(bodyof "$R" | j lifecycle); [ "$LC" = IN_REVIEW ] || [ "$LC" = BLOCKED ] && break; sleep 5; done  # 업로드 직후 초기 상태는 QUARANTINED
  B=$(bodyof "$R")
  if [ "$LC" != IN_REVIEW ]; then echo "결과 $id $d 승인대기 미도달 lifecycle=$LC TrustGate=$(j trust_gate_result <<<"$B")"; continue; fi
  TG=$(j trust_gate_result <<<"$B"); AS=$(j authority_status <<<"$B"); CT=$(j classification.document_type <<<"$B")
  K=$(kind "$id"); [ "$CT" = "$K" ] || call "$AT" POST "/v1/documents/$d/classification" "{\"document_type\":\"$K\",\"reason\":\"평가 세트 정답 분류\"}" >/dev/null
  # 합성 문서의 확인 필요(CLARIFY_NEEDED, 예 "담당자는 어느 부서?")는 올린 사람이 '해당 없음'으로 답한다 (prod 시드 11/18: G-KREV-04). 차단 기대 문서는 건드리지 않음
  [ "${EXPECT:-}" = block ] || for f in $(bodyof "$(call "$AT" GET "/v1/documents/$d/issues")" | python3 -c 'import json,sys; print(" ".join(x["finding_id"] for x in json.load(sys.stdin).get("items",[]) if x.get("code")=="CLARIFY_NEEDED"))'); do
    call "$AT" POST "/v1/documents/$d/findings/$f/ack" '{"reason":"평가 세트 합성 문서(SYNTHETIC): 해당 없음"}' >/dev/null; done
  R=$(call "$AT" POST "/v1/documents/$d/submit"); [ "$(code "$R")" = 201 ] || { echo "$id $d submit 실패 $(bodyof "$R" | head -c 200) (TrustGate=$TG $AS)"; continue; }
  APR=$(bodyof "$R" | j approval_id)
  if [ "${EXPECT:-}" = block ]; then R=$(call "$PT" POST "/v1/approvals/$APR/decision" '{"decision":"REJECT","reason":"평가: 위조·공격 문서 반려"}'); [ "$(code "$R")" = 200 ] && echo "결과 $id $d TrustGate=$TG authority=$AS → 게시 요청 접수, 사람 반려" || echo "결과 $id $d 반려 실패 $(bodyof "$R" | head -c 200)"; continue; fi
  R=$(call "$PT" POST "/v1/approvals/$APR/decision" '{"decision":"APPROVE","reason":"Registry 기준본 해시 일치 확인"}'); [ "$(code "$R")" = 200 ] || { echo "$id $d 승인 실패 $(bodyof "$R" | head -c 200)"; continue; }
  for _ in $(seq 1 120); do LC=$(bodyof "$(doc "$d")" | j lifecycle); [ "$LC" = PUBLISHED ] || [ "$LC" = BLOCKED ] && break; sleep 5; done
  echo "결과 $id $d TrustGate=$TG authority=$AS 분류=$CT → $LC"
done
