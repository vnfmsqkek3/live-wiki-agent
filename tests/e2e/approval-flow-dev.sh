#!/usr/bin/env bash
# 공유 dev E2E: 업로드 → type-detection → (단계 Lambda 직접 호출) → 게시 요청 → 승인 → SFN 재개 → Finalize
# 전제: API 로컬 실행 중(API=http://localhost:8080), 단계 Lambda hanaeum-mvp-lambda-*-$NICK 배포.
# 단계 Lambda가 SFN에 연결되기 전에는 WaitForApproval stub이 저장한 실제 task token을 읽어 우리 Lambda에 넘긴다.
set -euo pipefail
API=${API:-http://localhost:8080}; NICK=${NICK:-dhxorb96}
: "${COGNITO_CLIENT_ID:?}" "${TABLE_WORKFLOWS:?}" "${SFN_INGEST_ARN:?}"
fail() { echo "FAIL: $*" >&2; exit 1; }
secret=$(aws secretsmanager get-secret-value --secret-id hanaeum-mvp/demo-users-dev --query SecretString --output text)
token() { local p; p=$(python3 -c 'import json,sys; v=json.loads(sys.argv[1])[sys.argv[2]]; print(v["password"] if isinstance(v,dict) else v)' "$secret" "$1")
  aws cognito-idp initiate-auth --client-id "$COGNITO_CLIENT_ID" --auth-flow USER_PASSWORD_AUTH --auth-parameters "USERNAME=$1,PASSWORD=$p" --query AuthenticationResult.AccessToken --output text; }
call() { curl -sS -X "$2" "$API$3" -H "authorization: Bearer $1" -H 'content-type: application/json' ${4:+-d "$4"} -w '\n%{http_code}'; }
# 성공이면 200, 함수 오류면 오류 이름 출력
inv() { local o; o=$(mktemp); aws lambda invoke --function-name "hanaeum-mvp-lambda-$1-$NICK" --cli-binary-format raw-in-base64-out --payload "$2" "$o" --query 'FunctionError || `200`' --output text; rm -f "$o"; }

AT=$(token demo-author); PT=$(token demo-approver); UT=$(token demo-user)
F=$(mktemp); printf '%%PDF-1.7\n%% SYNTHETIC 한빛은행 담보평가 체크리스트 (E2E)\n' > "$F"
R=$(call "$AT" POST /v1/documents/upload-url "{\"filename\":\"e2e.pdf\",\"size\":$(wc -c <"$F" | tr -d ' '),\"title\":\"[SYNTHETIC] E2E 체크리스트\",\"dept\":\"loan\",\"acl_groups\":[\"ALL\"]}")
[ "$(tail -1 <<<"$R")" = 201 ] || fail "upload-url $R"
DOC=$(head -1 <<<"$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["doc_id"])'); URL=$(head -1 <<<"$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["url"])')
curl -sS -f -X PUT --data-binary @"$F" "$URL" >/dev/null || fail "S3 PUT (presigned)"
echo "1 upload OK  $DOC"
KEY="$DOC/original.pdf"
[ "$(inv type-detection "{\"Records\":[{\"body\":\"{\\\"detail\\\":{\\\"object\\\":{\\\"key\\\":\\\"$KEY\\\"}}}\"}]}")" = 200 ] || fail type-detection
R=$(call "$AT" GET "/v1/documents/$DOC"); WF=$(head -1 <<<"$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["workflow_id"])')
ARN="${SFN_INGEST_ARN/:stateMachine:/:execution:}:$WF"
aws stepfunctions describe-execution --execution-arn "$ARN" --query status --output text | grep -q RUNNING || fail "execution not running"
echo "2 type-detection → SFN RUNNING  $WF"
IN="{\"workflow_id\":\"$WF\",\"doc_id\":\"$DOC\",\"version\":1,\"bucket\":\"x\",\"prefix\":\"$DOC/\",\"actor\":{\"sub\":\"x\",\"groups\":[\"AUTHOR\"]}}"
[ "$(inv file-structure-check "$IN")" = 200 ] || fail file-structure-check; [ "$(inv trust-gate "$IN")" = 200 ] || fail trust-gate
for _ in $(seq 1 30); do TOK=$(aws dynamodb get-item --table-name "$TABLE_WORKFLOWS" --key "{\"pk\":{\"S\":\"WF#$WF\"},\"sk\":{\"S\":\"APPROVAL_TOKEN\"}}" --query Item.task_token.S --output text); [ "$TOK" != None ] && break; sleep 3; done
[ "$TOK" != None ] || fail "no task token"
inv wait-for-approval "$(python3 -c 'import json,sys;d=json.loads(sys.argv[1]);d["task_token"]=sys.argv[2];print(json.dumps(d))' "$IN" "$TOK")" | grep -q 200 || fail wait-for-approval
echo "3 단계 2·9·10 OK (task token 저장)"
R=$(call "$UT" GET "/v1/documents/$DOC"); [ "$(tail -1 <<<"$R")" = 404 ] || fail "미승인 문서가 일반 사용자에게 보임"
R=$(call "$AT" POST "/v1/documents/$DOC/submit"); [ "$(tail -1 <<<"$R")" = 201 ] || fail "submit $R"
APR=$(head -1 <<<"$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["approval_id"])')
R=$(call "$UT" POST "/v1/approvals/$APR/decision" '{"decision":"APPROVE","reason":"x"}'); [ "$(tail -1 <<<"$R")" = 403 ] || fail "user approve should 403"
R=$(call "$PT" POST "/v1/approvals/$APR/decision" '{"decision":"APPROVE","reason":"E2E 근거 확인"}'); [ "$(tail -1 <<<"$R")" = 200 ] || fail "approve $R"
R=$(call "$PT" POST "/v1/approvals/$APR/decision" '{"decision":"APPROVE","reason":"again"}'); [ "$(tail -1 <<<"$R")" = 409 ] || fail "double approve should 409"
echo "4 게시 요청·승인 OK (일반 사용자 403, 중복 409)"
for _ in $(seq 1 40); do ST=$(aws stepfunctions describe-execution --execution-arn "$ARN" --query status --output text); [ "$ST" != RUNNING ] && break; sleep 3; done
[ "$ST" = SUCCEEDED ] || fail "execution $ST"
inv finalize "$(python3 -c 'import json,sys;d=json.loads(sys.argv[1]);d["outcome"]="PUBLISHED";print(json.dumps(d))' "$IN")" | grep -q 200 || fail finalize
R=$(call "$UT" GET "/v1/documents/$DOC"); [ "$(tail -1 <<<"$R")" = 200 ] || fail "게시 후 일반 사용자 조회 $R"
echo "5 SFN 재개 → SUCCEEDED, Finalize PUBLISHED, 일반 사용자 조회 가능"
echo "ALL PASS"
