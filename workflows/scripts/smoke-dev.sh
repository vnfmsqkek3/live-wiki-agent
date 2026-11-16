#!/usr/bin/env bash
# 워크플로 배선 smoke (stub 단계 기준). 재실행 가능.
#  1) 업로드 이벤트: quarantine/{doc}/original.txt → SQS trigger 수신
#  2) 정상 경로: 실행 → WaitForApproval 에서 대기 → 사람 승인(SendTaskSuccess APPROVE) → SUCCEEDED, 단계 기록 15건
#  3) 실패 경로: 실행 중단(ABORTED) → failure-catcher 가 EXECUTION 레코드 기록
# 사용: set -a; . ./.env.local; set +a; workflows/scripts/smoke-dev.sh [env=dev]
set -euo pipefail
ENV=${1:-dev}
p() { aws ssm get-parameter --name "/hanaeum-mvp/$ENV/$1" --query Parameter.Value --output text; }
[ "$(aws sts get-caller-identity --query Account --output text)" = "$HANAEUM_ACCOUNT_ID" ] || { echo "계정 불일치" >&2; exit 1; }
SFN=$(p SFN_INGEST_ARN); TABLE=$(p TABLE_WORKFLOWS); BUCKET=$(p BUCKET_QUARANTINE); QUEUE=$(p SQS_INGEST_TRIGGER)
TS=$(date +%s); DOC="doc_SMOKE$TS"; ok() { echo "PASS $1"; }; fail() { echo "FAIL $1" >&2; exit 1; }

# 1) 업로드 이벤트
echo "SYNTHETIC smoke" | aws s3 cp - "s3://$BUCKET/$DOC/original.txt" --sse aws:kms >/dev/null
for _ in $(seq 1 10); do
  BODY=$(aws sqs receive-message --queue-url "$QUEUE" --wait-time-seconds 5 --query 'Messages[0].[ReceiptHandle,Body]' --output text)
  if [[ "$BODY" == *"$DOC/original.txt"* ]]; then
    aws sqs delete-message --queue-url "$QUEUE" --receipt-handle "${BODY%%$'\t'*}"; ok "upload event -> SQS"; break
  fi
  [ "$BODY" != "None" ] && [ -n "$BODY" ] && aws sqs change-message-visibility --queue-url "$QUEUE" --receipt-handle "${BODY%%$'\t'*}" --visibility-timeout 0
done
[[ "$BODY" == *"$DOC"* ]] || fail "upload event not received"

input() { printf '{"workflow_id":"%s","doc_id":"%s","version":1,"bucket":"%s","prefix":"%s/","actor":{"sub":"smoke","groups":["AUTHOR"]}}' "$1" "$DOC" "$BUCKET" "$DOC"; }

# 2) 정상 경로
WF="wf_SMOKE${TS}A"
EXEC=$(aws stepfunctions start-execution --state-machine-arn "$SFN" --name "$WF" --input "$(input "$WF")" --query executionArn --output text)
TOKEN=None
for _ in $(seq 1 30); do
  TOKEN=$(aws dynamodb get-item --table-name "$TABLE" --key "{\"pk\":{\"S\":\"WF#$WF\"},\"sk\":{\"S\":\"APPROVAL_TOKEN\"}}" --query Item.task_token.S --output text)
  [ "$TOKEN" != "None" ] && break; sleep 2
done
[ "$TOKEN" != "None" ] || fail "WaitForApproval token not stored"
ok "paused at WaitForApproval"
aws stepfunctions send-task-success --task-token "$TOKEN" --task-output '{"decision":"APPROVE"}'
for _ in $(seq 1 60); do
  ST=$(aws stepfunctions describe-execution --execution-arn "$EXEC" --query status --output text)
  [ "$ST" != RUNNING ] && break; sleep 2
done
[ "$ST" = SUCCEEDED ] || fail "execution status $ST"
N=$(aws dynamodb query --table-name "$TABLE" --key-condition-expression 'pk = :p and begins_with(sk, :s)' \
  --expression-attribute-values "{\":p\":{\"S\":\"WF#$WF\"},\":s\":{\"S\":\"STEP#\"}}" --query Count --output text)
[ "$N" = 15 ] || fail "step records $N != 15"
ok "happy path SUCCEEDED, 15 step records"

# 3) 실패 경로
WF2="wf_SMOKE${TS}B"
EXEC2=$(aws stepfunctions start-execution --state-machine-arn "$SFN" --name "$WF2" --input "$(input "$WF2")" --query executionArn --output text)
sleep 3; aws stepfunctions stop-execution --execution-arn "$EXEC2" --error Smoke.Abort >/dev/null
R=None
for _ in $(seq 1 30); do
  R=$(aws dynamodb get-item --table-name "$TABLE" --key "{\"pk\":{\"S\":\"WF#$WF2\"},\"sk\":{\"S\":\"EXECUTION\"}}" --query Item.status.S --output text)
  [ "$R" != "None" ] && break; sleep 2
done
[ "$R" = ABORTED ] || fail "failure-catcher record $R"
ok "abort -> failure-catcher EXECUTION=ABORTED"

aws s3 rm "s3://$BUCKET/$DOC/original.txt" >/dev/null
echo "ALL PASS ($ENV)"
