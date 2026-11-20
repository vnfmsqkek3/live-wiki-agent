#!/usr/bin/env bash
# AgentCore 오케스트레이션 smoke (긴급 전환 11/16). API 의 upload-url 대신 Documents 레코드를 직접 만든다.
#   업로드 → EventBridge → SQS → type-detection → InvokeAgentRuntime(오케스트레이터) → Gateway Tool(단계 Lambda)
#   → Documents lifecycle=IN_REVIEW 와 단계 기록(WF#/STEP#)을 확인하면 PASS. 승인 resume 은 승인 API(dhxorb96) 경로.
# 사용: set -a; . ./.env.local; set +a; workflows/scripts/smoke-agentcore.sh [env=dev]
#   TITLE=… 문서 제목. FILE=합성문서 를 주면 기본(F-001.pdf) 대신 그 파일을 올린다 (확장자 그대로). KEEP=1 이면 정리하지 않음
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV=${1:-dev}; APPROVE=${2:-}
p() { aws ssm get-parameter --name "/hanaeum-mvp/$ENV/$1" --query Parameter.Value --output text; }
[ "$(aws sts get-caller-identity --query Account --output text)" = "$HANAEUM_ACCOUNT_ID" ] || { echo "계정 불일치" >&2; exit 1; }
DOCS=$(p TABLE_DOCUMENTS); WFT=$(p TABLE_WORKFLOWS); BUCKET=$(p BUCKET_QUARANTINE)
# 거버넌스 저장소 (interfaces.md 10장): 단계 Lambda 의 GOV_STORE 를 따른다. postgres 면 문서 레코드는 Aurora(Data API, master secret — 점검 문서 정리용)
SFX=$([ "$ENV" = prod ] && echo "" || echo "-$ENV")
GOV=$(aws lambda get-function-configuration --function-name "hanaeum-mvp-lambda-malware-check$SFX" --query 'Environment.Variables.GOV_STORE' --output text 2>/dev/null || echo dynamo)
if [ "$GOV" = postgres ]; then
  DBC=$(p DB_CLUSTER_ARN); DBS=$(aws rds describe-db-clusters --db-cluster-identifier "hanaeum-mvp-aurora$SFX" --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
  sql() { aws rds-data execute-statement --resource-arn "$DBC" --secret-arn "$DBS" --database hanaeum --sql "$1" --query 'records[0][0].stringValue' --output text; }
fi
echo "store=$GOV"
ulid() { node -e 'const B="0123456789ABCDEFGHJKMNPQRSTVWXYZ";let t="",n=Date.now();for(let i=0;i<10;i++,n=Math.floor(n/32))t=B[n%32]+t;let r="";for(let i=0;i<16;i++)r+=B[Math.floor(Math.random()*32)];console.log(t+r)'; }
DOC="doc_$(ulid)"; WF0="wf_$(ulid)" # API analyze 가 workflow_id 를 미리 넣는다 (type-detection 이 실행 이름으로 사용)
NOW=$(date -u +%FT%TZ)

# 기본 문서: 합성 규정 F-001. 직접 만든 영문 1쪽 PDF 는 전부 OCR 로 바뀐 뒤(11/17) NO_TEXT 로 BLOCKED 되어 쓰지 않는다 (11/20)
FILE=${FILE:-tests/fixtures/documents/pdf/F-001.pdf}
SRC=$FILE; EXT=$(echo "${FILE##*.}" | tr A-Z a-z)
if [ "$GOV" = postgres ]; then
  sql "INSERT INTO documents (doc_id, version, owner, title, dept, acl_groups, ext, lifecycle, authority_status, freshness, workflow_id, created_at, updated_at)
       VALUES ('$DOC', 1, 'smoke-author', '${TITLE:-SYNTHETIC smoke 담보평가 노하우}', '여신', ARRAY['ALL'], '$EXT', 'QUARANTINED', 'UNVERIFIED', 'CURRENT', '$WF0', now(), now()) RETURNING doc_id" >/dev/null
else
aws dynamodb put-item --table-name "$DOCS" --item "$(cat <<JSON
{"pk":{"S":"DOC#$DOC"},"sk":{"S":"META"},"doc_id":{"S":"$DOC"},"version":{"N":"1"},"owner":{"S":"smoke-author"},
 "title":{"S":"${TITLE:-SYNTHETIC smoke 담보평가 노하우}"},"dept":{"S":"여신"},"acl_groups":{"L":[{"S":"ALL"}]},"ext":{"S":"$EXT"},
 "workflow_id":{"S":"$WF0"},"lifecycle":{"S":"QUARANTINED"},"authority_status":{"S":"UNVERIFIED"},"freshness":{"S":"CURRENT"},"findings":{"L":[]},
 "created_at":{"S":"$NOW"},"updated_at":{"S":"$NOW"}}
JSON
)"
fi
aws s3 cp "$SRC" "s3://$BUCKET/$DOC/original.$EXT" --sse aws:kms >/dev/null
echo "uploaded $DOC"

[ "$(p PIPELINE_RUNTIME_ARN)" != pending ] || { echo "FAIL Runtime 없음 (SSM PIPELINE_RUNTIME_ARN=pending)"; exit 1; }
WF=$WF0; K="{\"pk\":{\"S\":\"DOC#$DOC\"},\"sk\":{\"S\":\"META\"}}"
for i in $(seq 1 60); do
  if [ "$GOV" = postgres ]; then LC=$(sql "SELECT lifecycle FROM documents WHERE doc_id = '$DOC'"); else
  LC=$(aws dynamodb get-item --table-name "$DOCS" --key "$K" --query Item.lifecycle.S --output text); fi
  case "$LC" in IN_REVIEW|BLOCKED|PUBLISHED) break ;; esac
  (( i % 6 == 0 )) && echo "  waiting ($((i * 5))s, lifecycle=$LC)"
  sleep 5
done
aws dynamodb query --table-name "$WFT" --key-condition-expression 'pk = :p' \
  --expression-attribute-values "{\":p\":{\"S\":\"WF#$WF\"}}" --query 'Items[].[ended_at.S,sk.S,status.S,error.S]' --output text | sort | awk '{print "  " $2, $3, $4}'
if [ "$GOV" = postgres ]; then DT=$(sql "SELECT coalesce(document_type, '-') FROM documents WHERE doc_id = '$DOC'"); else DT=$(aws dynamodb get-item --table-name "$DOCS" --key "$K" --query Item.document_type.S --output text); fi
echo "lifecycle=$LC document_type=$DT"
[ "$LC" = IN_REVIEW ] || { echo "FAIL lifecycle=$LC"; exit 1; }
echo "PASS upload -> type-detection -> AgentCore Runtime -> Gateway Tools -> IN_REVIEW"
echo "doc_id=$DOC workflow_id=$WF"

# 점검 문서가 공유 dev 결재함·보관함에 쌓이지 않게 스스로 폐기 (게시 전이라 KB 에는 없음). KEEP=1 이면 남김
if [[ "${KEEP:-0}" != 1 ]]; then
  if [ "$GOV" = postgres ]; then
    sql "UPDATE documents SET lifecycle = 'DELETED', attrs = attrs || jsonb_build_object('deleted_reason', 'smoke-agentcore 점검 문서 자동 정리'), updated_at = now() WHERE doc_id = '$DOC' RETURNING doc_id" >/dev/null
  else
  aws dynamodb update-item --table-name "$DOCS" --key "{\"pk\":{\"S\":\"DOC#$DOC\"},\"sk\":{\"S\":\"META\"}}" \
    --update-expression 'SET lifecycle = :d, deleted_reason = :r, updated_at = :t' \
    --expression-attribute-values "{\":d\":{\"S\":\"DELETED\"},\":r\":{\"S\":\"smoke-agentcore 점검 문서 자동 정리\"},\":t\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" >/dev/null
  fi
  echo "cleanup: $DOC lifecycle=DELETED"
fi
