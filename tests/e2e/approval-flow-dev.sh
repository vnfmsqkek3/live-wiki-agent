#!/usr/bin/env bash
# 공유 dev E2E: 업로드 → type-detection → (단계 Lambda 직접 호출) → 게시 요청 → 승인 → SFN 재개 → Finalize
# 전제: API 로컬 실행 중(API=http://localhost:8080). 단계 Lambda는 SFN에 연결되어 있다 (yoyo0704, 11/16).
set -euo pipefail
API=${API:-http://localhost:8080}; NICK=${NICK:-dhxorb96}
: "${COGNITO_CLIENT_ID:?}" "${TABLE_WORKFLOWS:?}" "${SFN_INGEST_ARN:?}"
fail() { echo "FAIL: $*" >&2; exit 1; }
secret=$(aws secretsmanager get-secret-value --secret-id hanaeum-mvp/demo-users-dev --query SecretString --output text)
token() { local p; p=$(python3 -c 'import json,sys; v=json.loads(sys.argv[1])[sys.argv[2]]; print(v["password"] if isinstance(v,dict) else v)' "$secret" "$1")
  aws cognito-idp initiate-auth --client-id "$COGNITO_CLIENT_ID" --auth-flow USER_PASSWORD_AUTH --auth-parameters "USERNAME=$1,PASSWORD=$p" --query AuthenticationResult.AccessToken --output text; }
call() { curl -sS -X "$2" "$API$3" -H "authorization: Bearer $1" -H 'content-type: application/json' ${4:+-d "$4"} -w '\n%{http_code}'; }

AT=$(token demo-author); PT=$(token demo-approver); UT=$(token demo-user)
F="$(dirname "$0")/../fixtures/documents/pdf/K-001.pdf"   # 텍스트 레이어 합성 PDF (let522mj)
R=$(call "$AT" POST /v1/documents/upload-url "{\"filename\":\"K-001.pdf\",\"size\":$(wc -c <"$F" | tr -d ' '),\"title\":\"[SYNTHETIC] E2E 담보평가 노하우\",\"dept\":\"여신\",\"acl_groups\":[\"ALL\"]}")
[ "$(tail -1 <<<"$R")" = 201 ] || fail "upload-url $R"
DOC=$(head -1 <<<"$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["doc_id"])'); URL=$(head -1 <<<"$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["url"])')
curl -sS -f -X PUT --data-binary @"$F" "$URL" >/dev/null || fail "S3 PUT (presigned)"
echo "1 upload OK  $DOC"
# S3 이벤트 → type-detection → SFN(Malware·FileStructure·TextLayer·…·TrustGate·WaitForApproval) 실제 파이프라인
for _ in $(seq 1 80); do
  R=$(call "$AT" GET "/v1/documents/$DOC"); LC=$(head -1 <<<"$R" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("lifecycle",""), d.get("trust_gate_result",""))')
  [[ "$LC" == IN_REVIEW\ * && "$LC" != "IN_REVIEW " ]] && break; [[ "$LC" == BLOCKED* ]] && fail "pipeline BLOCKED"; sleep 3
done
[[ "$LC" == IN_REVIEW\ * ]] || fail "IN_REVIEW 도달 실패 ($LC)"
WF=$(head -1 <<<"$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["workflow_id"])')
ARN="${SFN_INGEST_ARN/:stateMachine:/:execution:}:$WF"
echo "2·3 파이프라인 → IN_REVIEW ($LC)  $WF"
R=$(call "$UT" GET "/v1/documents/$DOC"); [ "$(tail -1 <<<"$R")" = 404 ] || fail "미승인 문서가 일반 사용자에게 보임"
R=$(call "$AT" POST "/v1/documents/$DOC/submit"); [ "$(tail -1 <<<"$R")" = 201 ] || fail "submit $R"
APR=$(head -1 <<<"$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["approval_id"])')
R=$(call "$UT" POST "/v1/approvals/$APR/decision" '{"decision":"APPROVE","reason":"x"}'); [ "$(tail -1 <<<"$R")" = 403 ] || fail "user approve should 403"
R=$(call "$PT" POST "/v1/approvals/$APR/decision" '{"decision":"APPROVE","reason":"E2E 근거 확인"}'); [ "$(tail -1 <<<"$R")" = 200 ] || fail "approve $R"
R=$(call "$PT" POST "/v1/approvals/$APR/decision" '{"decision":"APPROVE","reason":"again"}'); [ "$(tail -1 <<<"$R")" = 409 ] || fail "double approve should 409"
echo "4 게시 요청·승인 OK (일반 사용자 403, 중복 409)"
for _ in $(seq 1 120); do ST=$(aws stepfunctions describe-execution --execution-arn "$ARN" --query status --output text); [ "$ST" != RUNNING ] && break; sleep 3; done
[ "$ST" = SUCCEEDED ] || fail "execution $ST"
R=$(call "$UT" GET "/v1/documents/$DOC"); [ "$(tail -1 <<<"$R")" = 200 ] || fail "게시 후 일반 사용자 조회 $R"
echo "5 SFN 재개 → SUCCEEDED, Finalize PUBLISHED, 일반 사용자 조회 가능"
echo "ALL PASS"
