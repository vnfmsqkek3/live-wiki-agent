#!/usr/bin/env bash
# AgentCore 오케스트레이션 smoke (긴급 전환 11/16). API 의 upload-url 대신 Documents 레코드를 직접 만든다.
#   업로드 → EventBridge → SQS → type-detection → InvokeAgentRuntime(오케스트레이터) → Gateway Tool(단계 Lambda)
#   → Documents lifecycle=IN_REVIEW 와 단계 기록(WF#/STEP#)을 확인하면 PASS. 승인 resume 은 승인 API(dhxorb96) 경로.
# 사용: set -a; . ./.env.local; set +a; workflows/scripts/smoke-agentcore.sh [env=dev]
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV=${1:-dev}; APPROVE=${2:-}
p() { aws ssm get-parameter --name "/hanaeum-mvp/$ENV/$1" --query Parameter.Value --output text; }
[ "$(aws sts get-caller-identity --query Account --output text)" = "$HANAEUM_ACCOUNT_ID" ] || { echo "계정 불일치" >&2; exit 1; }
DOCS=$(p TABLE_DOCUMENTS); WFT=$(p TABLE_WORKFLOWS); BUCKET=$(p BUCKET_QUARANTINE)
ulid() { node -e 'const B="0123456789ABCDEFGHJKMNPQRSTVWXYZ";let t="",n=Date.now();for(let i=0;i<10;i++,n=Math.floor(n/32))t=B[n%32]+t;let r="";for(let i=0;i<16;i++)r+=B[Math.floor(Math.random()*32)];console.log(t+r)'; }
DOC="doc_$(ulid)"; WF0="wf_$(ulid)" # API analyze 가 workflow_id 를 미리 넣는다 (type-detection 이 실행 이름으로 사용)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
NOW=$(date -u +%FT%TZ)

# 텍스트 레이어가 충분한 1쪽 합성 PDF (OCR 대상 아님)
node -e '
const lines = ["SYNTHETIC Hanbit Bank (Synthetic Bank) collateral appraisal know-how",
  "Step 1. Check the appraisal report and the registry certificate before approval.",
  "Step 2. Confirm the loan amount does not exceed the approval limit in Article 12."];
const body = lines.map((l, i) => `BT /F1 11 Tf 40 ${780 - i * 20} Td (${l}) Tj ET`).join("\n");
const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${body.length} >>\nstream\n${body}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
let s = "%PDF-1.4\n"; const off = [];
objs.forEach((o, i) => { off.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const x = s.length;
s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
require("fs").writeFileSync(process.argv[1], s);
' "$TMP/doc.pdf"

aws dynamodb put-item --table-name "$DOCS" --item "$(cat <<JSON
{"pk":{"S":"DOC#$DOC"},"sk":{"S":"META"},"doc_id":{"S":"$DOC"},"version":{"N":"1"},"owner":{"S":"smoke-author"},
 "title":{"S":"SYNTHETIC smoke 담보평가 노하우"},"dept":{"S":"여신"},"acl_groups":{"L":[{"S":"ALL"}]},"ext":{"S":"pdf"},
 "workflow_id":{"S":"$WF0"},"lifecycle":{"S":"QUARANTINED"},"authority_status":{"S":"UNVERIFIED"},"freshness":{"S":"CURRENT"},"findings":{"L":[]},
 "created_at":{"S":"$NOW"},"updated_at":{"S":"$NOW"}}
JSON
)"
aws s3 cp "$TMP/doc.pdf" "s3://$BUCKET/$DOC/original.pdf" --sse aws:kms >/dev/null
echo "uploaded $DOC"

[ "$(p PIPELINE_RUNTIME_ARN)" != pending ] || { echo "FAIL Runtime 없음 (SSM PIPELINE_RUNTIME_ARN=pending)"; exit 1; }
WF=$WF0; K="{\"pk\":{\"S\":\"DOC#$DOC\"},\"sk\":{\"S\":\"META\"}}"
for i in $(seq 1 60); do
  LC=$(aws dynamodb get-item --table-name "$DOCS" --key "$K" --query Item.lifecycle.S --output text)
  case "$LC" in IN_REVIEW|BLOCKED|PUBLISHED) break ;; esac
  (( i % 6 == 0 )) && echo "  waiting ($((i * 5))s, lifecycle=$LC)"
  sleep 5
done
aws dynamodb query --table-name "$WFT" --key-condition-expression 'pk = :p' \
  --expression-attribute-values "{\":p\":{\"S\":\"WF#$WF\"}}" --query 'Items[].[ended_at.S,sk.S,status.S,error.S]' --output text | sort | awk '{print "  " $2, $3, $4}'
echo "lifecycle=$LC document_type=$(aws dynamodb get-item --table-name "$DOCS" --key "$K" --query Item.document_type.S --output text)"
[ "$LC" = IN_REVIEW ] || { echo "FAIL lifecycle=$LC"; exit 1; }
echo "PASS upload -> type-detection -> AgentCore Runtime -> Gateway Tools -> IN_REVIEW"
echo "doc_id=$DOC workflow_id=$WF"

# 점검 문서가 공유 dev 결재함·보관함에 쌓이지 않게 스스로 폐기 (게시 전이라 KB 에는 없음). KEEP=1 이면 남김
if [[ "${KEEP:-0}" != 1 ]]; then
  aws dynamodb update-item --table-name "$DOCS" --key "{\"pk\":{\"S\":\"DOC#$DOC\"},\"sk\":{\"S\":\"META\"}}" \
    --update-expression 'SET lifecycle = :d, deleted_reason = :r, updated_at = :t' \
    --expression-attribute-values "{\":d\":{\"S\":\"DELETED\"},\":r\":{\"S\":\"smoke-agentcore 점검 문서 자동 정리\"},\":t\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" >/dev/null
  echo "cleanup: $DOC lifecycle=DELETED"
fi
