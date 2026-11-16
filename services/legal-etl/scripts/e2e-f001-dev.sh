#!/usr/bin/env bash
# 공유 dev E2E 1건 (docs/05 11/18 조건): F-001 PDF 업로드 → SFN(3a·5·TrustGate) → 분류·게시 요청·승인(API) → Promote → KbIngest → 검색
# 전제: 승인 API 로컬 실행 중(API, 기본 http://localhost:8080, dhxorb96 apps/api), .env.local 로드. 데이터는 SYNTHETIC 합성 문서만.
set -euo pipefail
cd "$(dirname "$0")/../../.."
API=${API:-http://localhost:8080}
ssm() { aws ssm get-parameter --name "/hanaeum-mvp/dev/$1" --query Parameter.Value --output text; }
CLIENT=$(ssm COGNITO_CLIENT_ID); SFN=$(ssm SFN_INGEST_ARN)
PDF=tests/fixtures/documents/pdf/F-001.pdf
fail() { echo "FAIL: $*" >&2; exit 1; }
j() { python3 -c 'import json,sys; d=json.load(sys.stdin)
for k in sys.argv[1].split("."): d=d.get(k) if isinstance(d,dict) else None
print("" if d is None else d)' "$1"; }
secret=$(aws secretsmanager get-secret-value --secret-id hanaeum-mvp/demo-users-dev --query SecretString --output text)
token() { local p; p=$(python3 -c 'import json,sys; v=json.loads(sys.argv[1])[sys.argv[2]]; print(v["password"] if isinstance(v,dict) else v)' "$secret" "$1")
  aws cognito-idp initiate-auth --client-id "$CLIENT" --auth-flow USER_PASSWORD_AUTH --auth-parameters "USERNAME=$1,PASSWORD=$p" --query AuthenticationResult.AccessToken --output text; }
call() { curl -sS -X "$2" "$API$3" -H "authorization: Bearer $1" -H 'content-type: application/json' ${4:+-d "$4"} -w '\n%{http_code}'; }
code() { tail -1 <<<"$1"; }; bodyof() { sed '$d' <<<"$1"; }
AT=$(token demo-author); PT=$(token demo-approver); UT=$(token demo-user)

# 1 업로드 (presigned PUT → S3 이벤트 → SQS → type-detection → SFN 시작)
R=$(call "$AT" POST /v1/documents/upload-url "{\"filename\":\"F-001.pdf\",\"size\":$(wc -c <"$PDF" | tr -d ' '),\"title\":\"[SYNTHETIC] 한빛은행 기업여신 심사규정\",\"dept\":\"여신\",\"acl_groups\":[\"ALL\"]}")
[ "$(code "$R")" = 201 ] || fail "upload-url $R"
DOC=$(bodyof "$R" | j doc_id); URL=$(bodyof "$R" | j url)
curl -sS -f -X PUT --data-binary @"$PDF" "$URL" >/dev/null || fail "S3 PUT"
echo "1 업로드 $DOC"

# 2 SFN이 승인 대기(문서 IN_REVIEW)까지 진행
for _ in $(seq 1 60); do R=$(call "$AT" GET "/v1/documents/$DOC"); LC=$(bodyof "$R" | j lifecycle); WF=$(bodyof "$R" | j workflow_id)
  [ "$LC" = IN_REVIEW ] && break; [ "$LC" = BLOCKED ] && fail "BLOCKED $(bodyof "$R")"; sleep 5; done
[ "$LC" = IN_REVIEW ] || fail "승인 대기 미도달: $LC $(bodyof "$R")"
ARN="${SFN/:stateMachine:/:execution:}:$WF"
echo "2 SFN 승인 대기 $WF (trust_gate=$(bodyof "$R" | j trust_gate_result))"
[ "$(code "$(call "$UT" GET "/v1/documents/$DOC")")" = 404 ] || fail "미승인 문서가 일반 사용자에게 보임"

# 3 분류(사람) → 게시 요청 → 승인
R=$(call "$AT" POST "/v1/documents/$DOC/classification" '{"document_type":"REGULATION","reason":"E2E: 공식 규정"}'); [ "$(code "$R")" = 200 ] || fail "classification $R"
R=$(call "$AT" POST "/v1/documents/$DOC/submit"); [ "$(code "$R")" = 201 ] || fail "submit $R"
APR=$(bodyof "$R" | j approval_id)
R=$(call "$PT" POST "/v1/approvals/$APR/decision" '{"decision":"APPROVE","reason":"E2E 근거 확인"}'); [ "$(code "$R")" = 200 ] || fail "approve $R"
echo "3 승인 $APR"

# 4 Promote → KbIngest(폴링) → … → 종료
for _ in $(seq 1 120); do ST=$(aws stepfunctions describe-execution --execution-arn "$ARN" --query status --output text); [ "$ST" != RUNNING ] && break; sleep 5; done
[ "$ST" = SUCCEEDED ] || fail "execution $ST"
APS=$(aws dynamodb get-item --table-name "$(ssm TABLE_APPROVALS)" --key "{\"pk\":{\"S\":\"APR#$APR\"},\"sk\":{\"S\":\"META\"}}" --query Item.status.S --output text)
[ "$APS" = USED ] || fail "승인 1회 사용 미기록: $APS"
echo "4 SFN SUCCEEDED, 승인 USED"

# 5 검색 (search Tool Lambda, 일반 사용자 신원)
OUT=$(mktemp)
aws lambda invoke --function-name hanaeum-mvp-lambda-mcp-search-let522mj --cli-binary-format raw-in-base64-out \
  --client-context "$(printf '{"custom":{"bedrockAgentCoreToolName":"search___search_wiki"}}' | base64)" \
  --payload "{\"query\":\"여신 금액 5억원 이상 승인 기준\",\"top_k\":5,\"__actor\":{\"sub\":\"e2e-user\",\"groups\":[\"USER\"],\"dept\":\"여신\"}}" "$OUT" >/dev/null
python3 - "$OUT" "$DOC" <<'PY'
import json,sys; r=json.load(open(sys.argv[1])); r=json.loads(r["body"]) if isinstance(r,dict) and "body" in r else r
ids=[i["doc_id"] for i in r.get("items",[])]; print("5 검색", r.get("search_status"), len(ids), "건, E2E 문서 포함" if sys.argv[2] in ids else "E2E 문서 없음")
for i in r.get("items",[])[:3]: print("  ", i.get("provision") or i.get("title"), i.get("effective_from"), i.get("authority_status"))
sys.exit(0 if sys.argv[2] in ids else 1)
PY
echo "ALL PASS $DOC $WF"
