#!/usr/bin/env bash
# 워크플로 배선 smoke. 재실행 가능. 구현된 단계: MalwareCheck(GuardDuty). 나머지는 stub 또는 각 Owner Lambda.
#  1) 업로드 이벤트: quarantine/{doc}/original.txt → SQS trigger 수신
#  2) 정상 경로: GuardDuty NO_THREATS_FOUND → WaitForApproval 대기 → 사람 승인(APPROVE) → SUCCEEDED, 단계 기록 15건
#  3) 악성 경로: EICAR 테스트 파일 → GuardDuty THREATS_FOUND → BLOCKED → Finalize(outcome=BLOCKED), Finding MALWARE_DETECTED
#  4) 실패 경로: 실행 중단(ABORTED) → failure-catcher 가 EXECUTION 레코드 기록
# type-detection 대신 Documents 레코드(pk=DOC#id, sk=META)를 직접 만들고 끝나면 지운다.
# 사용: set -a; . ./.env.local; set +a; workflows/scripts/smoke-dev.sh [env=dev]
set -euo pipefail
ENV=${1:-dev}
p() { aws ssm get-parameter --name "/hanaeum-mvp/$ENV/$1" --query Parameter.Value --output text; }
[ "$(aws sts get-caller-identity --query Account --output text)" = "$HANAEUM_ACCOUNT_ID" ] || { echo "계정 불일치" >&2; exit 1; }
SFN=$(p SFN_INGEST_ARN); TABLE=$(p TABLE_WORKFLOWS); DOCS=$(p TABLE_DOCUMENTS); BUCKET=$(p BUCKET_QUARANTINE); QUEUE=$(p SQS_INGEST_TRIGGER)
TS=$(date +%s); ok() { echo "PASS $1"; }; fail() { echo "FAIL $1" >&2; exit 1; }
CLEAN=()
cleanup() {
  for d in "${CLEAN[@]}"; do
    aws s3 rm "s3://$BUCKET/$d/" --recursive >/dev/null 2>&1 || true
    aws dynamodb delete-item --table-name "$DOCS" --key "{\"pk\":{\"S\":\"DOC#$d\"},\"sk\":{\"S\":\"META\"}}" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

new_doc() { # doc_id content
  CLEAN+=("$1")
  aws dynamodb put-item --table-name "$DOCS" --item "{\"pk\":{\"S\":\"DOC#$1\"},\"sk\":{\"S\":\"META\"},\"doc_id\":{\"S\":\"$1\"},\"findings\":{\"L\":[]},\"updated_at\":{\"S\":\"$(date -u +%FT%TZ)\"}}"
  printf '%s' "$2" | aws s3 cp - "s3://$BUCKET/$1/original.txt" --sse aws:kms >/dev/null
}
input() { printf '{"workflow_id":"%s","doc_id":"%s","version":1,"bucket":"%s","prefix":"%s/","actor":{"sub":"smoke","groups":["AUTHOR"]}}' "$1" "$2" "$BUCKET" "$2"; }
wait_exec() { # arn → 최종 상태
  local st
  for _ in $(seq 1 90); do st=$(aws stepfunctions describe-execution --execution-arn "$1" --query status --output text); [ "$st" != RUNNING ] && break; sleep 3; done
  echo "$st"
}
step_status() { aws dynamodb get-item --table-name "$TABLE" --key "{\"pk\":{\"S\":\"WF#$1\"},\"sk\":{\"S\":\"STEP#$2\"}}" --query Item.status.S --output text; }

# 1) 업로드 이벤트
DOC="doc_SMOKE${TS}A"; new_doc "$DOC" "SYNTHETIC smoke 한빛은행"
for _ in $(seq 1 10); do
  BODY=$(aws sqs receive-message --queue-url "$QUEUE" --wait-time-seconds 5 --query 'Messages[0].[ReceiptHandle,Body]' --output text)
  if [[ "$BODY" == *"$DOC/original.txt"* ]]; then aws sqs delete-message --queue-url "$QUEUE" --receipt-handle "${BODY%%$'\t'*}"; break; fi
  [ "$BODY" != "None" ] && [ -n "$BODY" ] && aws sqs change-message-visibility --queue-url "$QUEUE" --receipt-handle "${BODY%%$'\t'*}" --visibility-timeout 0
done
[[ "$BODY" == *"$DOC"* ]] || fail "upload event not received"
ok "upload event -> SQS"

# 2) 정상 경로
WF="wf_SMOKE${TS}A"
EXEC=$(aws stepfunctions start-execution --state-machine-arn "$SFN" --name "$WF" --input "$(input "$WF" "$DOC")" --query executionArn --output text)
TOKEN=None
for _ in $(seq 1 60); do
  TOKEN=$(aws dynamodb get-item --table-name "$TABLE" --key "{\"pk\":{\"S\":\"WF#$WF\"},\"sk\":{\"S\":\"APPROVAL_TOKEN\"}}" --query Item.task_token.S --output text)
  [ "$TOKEN" != "None" ] && break; sleep 3
done
[ "$TOKEN" != "None" ] || fail "WaitForApproval token not stored (MalwareCheck=$(step_status "$WF" MalwareCheck))"
[ "$(step_status "$WF" MalwareCheck)" = OK ] || fail "MalwareCheck not OK"
ok "GuardDuty NO_THREATS_FOUND -> MalwareCheck OK, paused at WaitForApproval"
aws stepfunctions send-task-success --task-token "$TOKEN" --task-output '{"decision":"APPROVE"}'
[ "$(wait_exec "$EXEC")" = SUCCEEDED ] || fail "happy path not SUCCEEDED"
N=$(aws dynamodb query --table-name "$TABLE" --key-condition-expression 'pk = :p and begins_with(sk, :s)' \
  --expression-attribute-values "{\":p\":{\"S\":\"WF#$WF\"},\":s\":{\"S\":\"STEP#\"}}" --query Count --output text)
[ "$N" = 15 ] || fail "step records $N != 15"
ok "happy path SUCCEEDED, 15 step records"

# 3) 악성 경로 (EICAR 표준 테스트 문자열, 무해. 조각으로 조립해 저장소에 원문을 두지 않음)
DOC2="doc_SMOKE${TS}M"; WF2="wf_SMOKE${TS}M"
new_doc "$DOC2" "$(printf '%s%s%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$' 'EICAR-STANDARD-ANTIVIRUS' '-TEST-FILE!$H+H*')"
EXEC2=$(aws stepfunctions start-execution --state-machine-arn "$SFN" --name "$WF2" --input "$(input "$WF2" "$DOC2")" --query executionArn --output text)
[ "$(wait_exec "$EXEC2")" = SUCCEEDED ] || fail "malware path execution not SUCCEEDED"
[ "$(step_status "$WF2" MalwareCheck)" = BLOCKED ] || fail "MalwareCheck not BLOCKED"
[ "$(step_status "$WF2" Finalize)" = BLOCKED ] || fail "Finalize outcome not BLOCKED"
[ "$(step_status "$WF2" WaitForApproval)" = None ] || fail "blocked doc reached approval"
CODE=$(aws dynamodb get-item --table-name "$DOCS" --key "{\"pk\":{\"S\":\"DOC#$DOC2\"},\"sk\":{\"S\":\"META\"}}" --query 'Item.findings.L[0].M.code.S' --output text)
[ "$CODE" = MALWARE_DETECTED ] || fail "finding $CODE"
ok "EICAR -> BLOCKED, skipped approval, Finding MALWARE_DETECTED"

# 4) 실패 경로
WF3="wf_SMOKE${TS}B"
EXEC3=$(aws stepfunctions start-execution --state-machine-arn "$SFN" --name "$WF3" --input "$(input "$WF3" "$DOC")" --query executionArn --output text)
sleep 3; aws stepfunctions stop-execution --execution-arn "$EXEC3" --error Smoke.Abort >/dev/null
R=None
for _ in $(seq 1 30); do
  R=$(aws dynamodb get-item --table-name "$TABLE" --key "{\"pk\":{\"S\":\"WF#$WF3\"},\"sk\":{\"S\":\"EXECUTION\"}}" --query Item.status.S --output text)
  [ "$R" != "None" ] && break; sleep 2
done
[ "$R" = ABORTED ] || fail "failure-catcher record $R"
ok "abort -> failure-catcher EXECUTION=ABORTED"
echo "ALL PASS ($ENV)"
