#!/usr/bin/env bash
# 공유 dev 업로드 데이터 전체 초기화 (사용자 지시 11/17: "저장되어있는 데이터는 싹 날리고 다시 하나씩 테스트문서 업로드").
# 지우는 것: S3 quarantine·published 모든 버전·삭제 마커, KB 벡터(재색인), Neptune 문서 노드·관계, workflows 테이블.
# 남기는 것: Regulations(Trusted Registry), Cognito 계정, 감사 기록. PostgreSQL 거버넌스 테이블은 yoyo0704가 TRUNCATE (app 사용자 DELETE 권한 없음).
# 순서 주의: Neptune 정리는 graph-upsert가 "삭제 표시(DELETED)"를 확인하므로 GOV_STORE 전환(빈 PG) 전에, DynamoDB Documents 기준으로 한다.
# 사용: services/legal-etl/scripts/wipe-dev.sh            (지울 대상 수만 표시)
#       services/legal-etl/scripts/wipe-dev.sh --apply
set -euo pipefail
APPLY=0; [ "${1:-}" = --apply ] && APPLY=1
ssm() { aws ssm get-parameter --name "/hanaeum-mvp/dev/$1" --query Parameter.Value --output text; }
[ "$(aws sts get-caller-identity --query Account --output text)" = "${HANAEUM_ACCOUNT_ID:?.env.local 로드 필요}" ] || { echo "계정 불일치"; exit 1; }
TD=$(ssm TABLE_DOCUMENTS); TW=hanaeum-mvp-ddb-workflows-dev; BQ=$(ssm BUCKET_QUARANTINE); BP=$(ssm BUCKET_PUBLISHED); KB=$(ssm KB_ID)

DOCS=$(aws dynamodb scan --table-name "$TD" --filter-expression 'sk = :m' --expression-attribute-values '{":m":{"S":"META"}}' \
  --projection-expression 'pk,lifecycle' --output json | python3 -c 'import json,sys
for i in json.load(sys.stdin)["Items"]: print(i["pk"]["S"][4:], i.get("lifecycle",{}).get("S",""))')
count() { aws s3api list-object-versions --bucket "$1" --output json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("Versions") or [])+len(d.get("DeleteMarkers") or []))'; }
echo "문서 $(wc -l <<<"$DOCS" | tr -d ' ')건 (DELETED 아님 $(grep -vc ' DELETED$' <<<"$DOCS" || true)) · quarantine 객체 버전 $(count "$BQ") · published $(count "$BP")"
[ $APPLY = 1 ] || { echo "(점검만. 실행하려면 --apply)"; exit 0; }

# 1) Documents 전부 DELETED 표시 (graph 삭제 조건)
NOW=$(date -u +%FT%TZ)
grep -v ' DELETED$' <<<"$DOCS" | while read -r d _; do
  aws dynamodb update-item --table-name "$TD" --key "{\"pk\":{\"S\":\"DOC#$d\"},\"sk\":{\"S\":\"META\"}}" \
    --update-expression "SET lifecycle = :l, deleted_reason = :r, updated_at = :t" \
    --expression-attribute-values "{\":l\":{\"S\":\"DELETED\"},\":r\":{\"S\":\"공유 dev 전체 초기화 (사용자 지시 11/17)\"},\":t\":{\"S\":\"$NOW\"}}" >/dev/null
done
# 2) Neptune: 문서마다 graph-upsert action=delete (끊긴 인용 doc_id는 어차피 함께 지워짐)
OUT=$(mktemp); FAIL=0
while read -r d _; do
  P=$(python3 -c 'import json,sys;print(json.dumps({"workflow_id":"wipe-20261117","doc_id":sys.argv[1],"version":1,"bucket":"-","prefix":"","actor":{"sub":"let522mj","groups":["PLATFORM_OPERATOR"]},"action":"delete"}))' "$d")
  aws lambda invoke --function-name hanaeum-mvp-lambda-graph-upsert-dev --cli-binary-format raw-in-base64-out --payload "$P" "$OUT" >/dev/null
  grep -q '"status":"OK"' "$OUT" || { FAIL=$((FAIL+1)); echo "graph 삭제 실패 $d $(head -c 200 "$OUT")"; }
done <<<"$DOCS"
echo "Neptune 정리 완료 (실패 $FAIL)"
# 3) S3: 모든 버전·삭제 마커 (versioning on)
purge() {
  while :; do
    J=$(aws s3api list-object-versions --bucket "$1" --max-items 1000 --output json)
    B=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); o=[{"Key":v["Key"],"VersionId":v["VersionId"]} for v in (d.get("Versions") or [])+(d.get("DeleteMarkers") or [])][:1000]; print(json.dumps({"Objects":o,"Quiet":True}) if o else "")' "$J")
    [ -n "$B" ] || break
    aws s3api delete-objects --bucket "$1" --delete "$B" >/dev/null
  done
  echo "S3 $1 남은 버전 $(count "$1")"
}
purge "$BQ"; purge "$BP"
# 4) KB: 데이터 소스 재색인 → 지운 객체의 벡터 삭제
for ds in $(ssm KB_DS_LEGAL_ID) $(ssm KB_DS_KNOWLEDGE_ID); do
  J=$(aws bedrock-agent start-ingestion-job --knowledge-base-id "$KB" --data-source-id "$ds" --query ingestionJob.ingestionJobId --output text)
  for _ in $(seq 1 60); do S=$(aws bedrock-agent get-ingestion-job --knowledge-base-id "$KB" --data-source-id "$ds" --ingestion-job-id "$J" --query 'ingestionJob.[status,statistics.numberOfDocumentsDeleted]' --output text)
    case "$S" in COMPLETE*|FAILED*|STOPPED*) break;; esac; sleep 10; done
  echo "KB 재색인 $ds: $S (상태·삭제)"
done
# 5) workflows 테이블 전부 (실행 기록·잠금)
aws dynamodb scan --table-name "$TW" --projection-expression 'pk,sk' --output json | python3 -c 'import json,sys
items=json.load(sys.stdin)["Items"]
for i in range(0,len(items),25): print(json.dumps({sys.argv[1]:[{"DeleteRequest":{"Key":k}} for k in items[i:i+25]]}))' "$TW" | while read -r R; do
  aws dynamodb batch-write-item --request-items "$R" >/dev/null; done
echo "workflows 남은 항목 $(aws dynamodb scan --table-name "$TW" --select COUNT --query Count --output text)"
