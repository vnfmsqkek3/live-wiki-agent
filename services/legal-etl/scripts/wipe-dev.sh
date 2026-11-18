#!/usr/bin/env bash
# 업로드 데이터 전체 초기화 (사용자 지시 11/17: "dev전부 초기화해줘. prd도 마찬가지로 초기화해줘").
# 지우는 것: S3 quarantine·published 모든 버전·삭제 마커, KB 벡터(재색인), Neptune 문서 노드·관계, workflows 테이블.
# 문서 행은 지우지 않고 lifecycle=DELETED로 표시 (PostgreSQL app 사용자는 DELETE 권한 없음, 감사 기록 유지). 분류 칸 doc_count는 0으로.
# 남기는 것: Regulations(Trusted Registry), Cognito 계정, 감사·분류 변경 기록, 분류 칸.
# 순서: ① PG에서 DELETED 표시 → ② Neptune(graph-upsert가 PG의 DELETED를 확인) → ③ S3 → ④ KB 재색인 → ⑤ workflows
# 사용: HANAEUM_ENV=dev|prod services/legal-etl/scripts/wipe-dev.sh            (지울 대상 수만 표시)
#       HANAEUM_ENV=dev|prod services/legal-etl/scripts/wipe-dev.sh --apply
set -euo pipefail
APPLY=0; [ "${1:-}" = --apply ] && APPLY=1
case "${HANAEUM_ENV:-dev}" in prod) ENV_NAME=prod; SFX="";; dev|dev-*) ENV_NAME=dev; SFX="-dev";; *) echo "HANAEUM_ENV: dev|prod" >&2; exit 1;; esac
ssm() { aws ssm get-parameter --name "/hanaeum-mvp/$ENV_NAME/$1" --query Parameter.Value --output text; }
[ "$(aws sts get-caller-identity --query Account --output text)" = "${HANAEUM_ACCOUNT_ID:?.env.local 로드 필요}" ] || { echo "계정 불일치"; exit 1; }
TW=$(ssm TABLE_WORKFLOWS); BQ=$(ssm BUCKET_QUARANTINE); BP=$(ssm BUCKET_PUBLISHED); KB=$(ssm KB_ID)
DBC=$(ssm DB_CLUSTER_ARN); DBS=$(ssm DB_SECRET_ARN); DBN=$(ssm DB_NAME)
GRAPH=hanaeum-mvp-lambda-graph-upsert$SFX
sql() { aws rds-data execute-statement --resource-arn "$DBC" --secret-arn "$DBS" --database "$DBN" --sql "$1" --output json; }

DOCS=$(sql "SELECT doc_id, lifecycle FROM documents" | python3 -c 'import json,sys
for r in json.load(sys.stdin).get("records",[]): print(r[0]["stringValue"], r[1].get("stringValue",""))')
count() { aws s3api list-object-versions --bucket "$1" --output json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("Versions") or [])+len(d.get("DeleteMarkers") or []))'; }
echo "[$ENV_NAME] 문서 $(grep -c . <<<"$DOCS" || true)건 (DELETED 아님 $(grep -vc ' DELETED$' <<<"$DOCS" || true)) · quarantine 객체 버전 $(count "$BQ") · published $(count "$BP")"
[ $APPLY = 1 ] || { echo "(점검만. 실행하려면 --apply)"; exit 0; }

# 1) PostgreSQL: 전부 DELETED 표시 (graph 삭제 조건), 분류 칸 문서 수 0
sql "UPDATE documents SET lifecycle = 'DELETED', attrs = attrs || jsonb_build_object('deleted_reason', '전체 초기화 (사용자 지시 11/17)') WHERE lifecycle <> 'DELETED'" >/dev/null
sql "UPDATE categories SET doc_count = 0 WHERE doc_count <> 0" >/dev/null 2>&1 || echo "categories 없음(분류 스키마 배포 전) → 건너뜀"
# 2) Neptune: 문서마다 graph-upsert action=delete
OUT=$(mktemp); FAIL=0
while read -r d _; do
  [ -n "$d" ] || continue
  P=$(python3 -c 'import json,sys;print(json.dumps({"workflow_id":"wipe-20261117","doc_id":sys.argv[1],"version":1,"bucket":"-","prefix":"","actor":{"sub":"let522mj","groups":["PLATFORM_OPERATOR"]},"action":"delete"}))' "$d")
  aws lambda invoke --function-name "$GRAPH" --cli-binary-format raw-in-base64-out --payload "$P" "$OUT" >/dev/null
  grep -q '"status":"OK"' "$OUT" || { FAIL=$((FAIL+1)); echo "graph 삭제 실패 $d $(head -c 200 "$OUT")"; }
done <<<"$DOCS"
echo "Neptune 정리 완료 (실패 $FAIL)"
[ "$FAIL" = 0 ] || { echo "Neptune 삭제 실패가 있어 중단합니다 (그래프가 남은 채 S3만 지우면 고아 노드)."; exit 1; }
# 3) S3: 모든 버전·삭제 마커 (versioning on)
purge() {
  while :; do
    J=$(aws s3api list-object-versions --bucket "$1" --max-items 1000 --output json)
    B=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); o=[{"Key":v["Key"],"VersionId":v["VersionId"]} for v in (d.get("Versions") or [])+(d.get("DeleteMarkers") or [])][:1000]; print(json.dumps({"Objects":o,"Quiet":True}) if o else "")' "$J")
    [ -n "$B" ] || break
    E=$(aws s3api delete-objects --bucket "$1" --delete "$B" --query 'length(Errors || `[]`)' --output text)
    [ "$E" = 0 ] || { echo "S3 $1 삭제 오류 $E건, 중단"; exit 1; }
  done
  echo "S3 $1 남은 버전 $(count "$1")"
}
purge "$BQ"; purge "$BP"
# 4) KB: 데이터 소스 재색인 → 지운 객체의 벡터 삭제
for ds in $(ssm KB_DS_LEGAL_ID) $(ssm KB_DS_KNOWLEDGE_ID); do
  J=""
  for _ in $(seq 1 30); do # 이미 도는 색인 작업이 있으면(ConflictException) 끝날 때까지 기다렸다 시작
    J=$(aws bedrock-agent start-ingestion-job --knowledge-base-id "$KB" --data-source-id "$ds" --query ingestionJob.ingestionJobId --output text 2>/dev/null) && break; sleep 20; done
  [ -n "$J" ] || { echo "KB 재색인 시작 실패 $ds"; exit 1; }
  for _ in $(seq 1 60); do S=$(aws bedrock-agent get-ingestion-job --knowledge-base-id "$KB" --data-source-id "$ds" --ingestion-job-id "$J" --query 'ingestionJob.[status,statistics.numberOfDocumentsDeleted]' --output text)
    case "$S" in COMPLETE*|FAILED*|STOPPED*) break;; esac; sleep 10; done
  echo "KB 재색인 $ds: $S (상태·삭제)"
done
# 5) workflows 테이블 전부 (실행 기록·잠금)
aws dynamodb scan --table-name "$TW" --projection-expression 'pk,sk' --output json | python3 -c 'import json,sys
items=json.load(sys.stdin)["Items"]
for i in range(0,len(items),25): print(json.dumps({sys.argv[1]:[{"DeleteRequest":{"Key":k}} for k in items[i:i+25]]}))' "$TW" | while read -r R; do
  for _ in 1 2 3 4 5; do # 미처리 항목 재시도
    R=$(aws dynamodb batch-write-item --request-items "$R" --query UnprocessedItems --output json)
    case "$R" in ""|"{}"|null) break;; esac; sleep 1; done; done # 미처리 없으면 빈 출력·{}·null
echo "workflows 남은 항목 $(aws dynamodb scan --table-name "$TW" --select COUNT --query Count --output text)"
