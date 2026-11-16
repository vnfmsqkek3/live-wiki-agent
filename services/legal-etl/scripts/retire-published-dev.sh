#!/usr/bin/env bash
# 공유 dev 게시본 폐기 (13항 7번 하나은행 재게시 전): ① published 객체 삭제 → ② Documents lifecycle=DELETED(이력 보존) → ③ legal·knowledge 재색인으로 KB에서 제거 확인.
# 승인 기록은 그대로 둔다. 검색·문서보관함·가이드는 DELETED를 제외한다 (dhxorb96 확인 11/16).
# 사용: services/legal-etl/scripts/retire-published-dev.sh "사유" doc_A doc_B ...        (점검만)
#       services/legal-etl/scripts/retire-published-dev.sh --apply "사유" doc_A doc_B ...
set -euo pipefail
APPLY=0; [ "${1:-}" = --apply ] && { APPLY=1; shift; }
REASON=${1:?사유}; shift
ssm() { aws ssm get-parameter --name "/hanaeum-mvp/dev/$1" --query Parameter.Value --output text; }
[ "$(aws sts get-caller-identity --query Account --output text)" = "${HANAEUM_ACCOUNT_ID:?.env.local 로드 필요}" ] || { echo "계정 불일치"; exit 1; }
BP=$(ssm BUCKET_PUBLISHED); TD=$(ssm TABLE_DOCUMENTS); KB=$(ssm KB_ID)
for d in "$@"; do
  LC=$(aws dynamodb get-item --table-name "$TD" --key "{\"pk\":{\"S\":\"DOC#$d\"},\"sk\":{\"S\":\"META\"}}" --query Item.lifecycle.S --output text)
  N=$(aws s3 ls "s3://$BP/" --recursive | grep -c "/$d/" || true)
  echo "$d lifecycle=$LC published객체=$N"
  [ $APPLY = 1 ] || continue
  for p in legal knowledge; do aws s3 rm "s3://$BP/$p/$d/" --recursive >/dev/null; done
  aws dynamodb update-item --table-name "$TD" --key "{\"pk\":{\"S\":\"DOC#$d\"},\"sk\":{\"S\":\"META\"}}" \
    --update-expression "SET lifecycle = :l, deleted_reason = :r, updated_at = :t" --condition-expression "attribute_exists(pk)" \
    --expression-attribute-values "{\":l\":{\"S\":\"DELETED\"},\":r\":{\"S\":\"$REASON\"},\":t\":{\"S\":\"$(date -u +%FT%TZ)\"}}"
done
[ $APPLY = 1 ] || { echo "(점검만. 실행하려면 --apply)"; exit 0; }
# ③ 재색인: S3에서 지운 객체가 KB에서도 빠진다 (데이터 소스당 동시 1개 → 순서대로)
for ds in $(ssm KB_DS_LEGAL_ID) $(ssm KB_DS_KNOWLEDGE_ID); do
  J=$(aws bedrock-agent start-ingestion-job --knowledge-base-id "$KB" --data-source-id "$ds" --query ingestionJob.ingestionJobId --output text)
  for _ in $(seq 1 60); do S=$(aws bedrock-agent get-ingestion-job --knowledge-base-id "$KB" --data-source-id "$ds" --ingestion-job-id "$J" --query 'ingestionJob.[status,statistics.numberOfDocumentsDeleted,statistics.numberOfDocumentsFailed]' --output text)
    case "$S" in COMPLETE*|FAILED*|STOPPED*) break;; esac; sleep 10; done
  echo "재색인 $ds: $S (상태·삭제·실패)"
done
