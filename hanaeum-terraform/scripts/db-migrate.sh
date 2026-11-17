#!/usr/bin/env bash
# Aurora PostgreSQL 스키마 마이그레이션 (terraform_data local-exec). RDS Data API + master secret 으로 실행.
# db/migrations/NNN_*.sql 을 번호 순서로, 아직 schema_migrations 에 없는 것만 파일 단위 트랜잭션으로 적용한다.
# 파일 안 문장 구분: 줄 하나에 `--;`. `:app_password` 는 app secret 의 비밀번호 리터럴로 바꿔 보낸다 (출력하지 않음).
# 사용: db-migrate.sh <cluster_arn> <master_secret_arn> <db_name> <app_secret_arn>
set -euo pipefail
CLUSTER=$1 SECRET=$2 DB=$3 APP_SECRET=$4
DIR="$(cd "$(dirname "$0")/../db/migrations" && pwd)"
exec_sql() { # $1 sql, $2 transaction id(옵션) → JSON 레코드
  aws rds-data execute-statement --resource-arn "$CLUSTER" --secret-arn "$SECRET" --database "$DB" \
    ${2:+--transaction-id "$2"} --format-records-as JSON --sql "$1" --query formattedRecords --output text
}
# Serverless v2 자동 일시정지에서 깨어나는 동안 DatabaseResumingException → 최대 3분 재시도
for i in $(seq 1 18); do
  if exec_sql "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())" >/dev/null 2>/tmp/db-migrate.err.$$; then break; fi
  grep -qE "DatabaseResuming|Communications link failure|is not available" /tmp/db-migrate.err.$$ || { cat /tmp/db-migrate.err.$$ >&2; exit 1; }
  echo "  DB 재개 대기 ($((i * 10))s)"; sleep 10
done
rm -f /tmp/db-migrate.err.$$
APPLIED=$(exec_sql "SELECT name FROM schema_migrations")
APP_PW=$(aws secretsmanager get-secret-value --secret-id "$APP_SECRET" --query SecretString --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])')
[[ "$APP_PW" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "app 비밀번호 문자 집합 위반" >&2; exit 1; }
for f in "$DIR"/[0-9][0-9][0-9]_*.sql; do
  name=$(basename "$f")
  if grep -q "\"$name\"" <<<"$APPLIED"; then continue; fi
  echo "migrate $name"
  TX=$(aws rds-data begin-transaction --resource-arn "$CLUSTER" --secret-arn "$SECRET" --database "$DB" --query transactionId --output text)
  # 문장 분리: `--;` 줄 기준 (함수 본문의 ; 는 그대로)
  if ! APP_PW="$APP_PW" python3 - "$f" > /tmp/db-migrate.stmts.$$ <<'PY'
import json, os, re, sys
src = open(sys.argv[1], encoding="utf-8").read().replace(":app_password", "'" + os.environ["APP_PW"] + "'")
parts = [p.strip() for p in re.split(r"^--;\s*$", src, flags=re.M)]
print(json.dumps([p for p in parts if re.sub(r"--[^\n]*", "", p).strip()]))
PY
  then aws rds-data rollback-transaction --resource-arn "$CLUSTER" --secret-arn "$SECRET" --transaction-id "$TX" >/dev/null; exit 1; fi
  n=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' /tmp/db-migrate.stmts.$$)
  for ((k = 0; k < n; k++)); do
    stmt=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[int(sys.argv[2])])' /tmp/db-migrate.stmts.$$ "$k")
    if ! exec_sql "$stmt" "$TX" >/dev/null 2>/tmp/db-migrate.err.$$; then
      sed "s/'[A-Za-z0-9_-]\{32\}'/'***'/g" /tmp/db-migrate.err.$$ >&2 # 비밀번호가 오류문에 섞여도 가린다
      aws rds-data rollback-transaction --resource-arn "$CLUSTER" --secret-arn "$SECRET" --transaction-id "$TX" >/dev/null
      rm -f /tmp/db-migrate.*.$$; echo "FAIL $name 문장 $((k + 1))" >&2; exit 1
    fi
  done
  exec_sql "INSERT INTO schema_migrations (name) VALUES ('$name')" "$TX" >/dev/null
  aws rds-data commit-transaction --resource-arn "$CLUSTER" --secret-arn "$SECRET" --transaction-id "$TX" >/dev/null
  rm -f /tmp/db-migrate.*.$$
  echo "  applied $name ($n statements)"
done
echo "schema up to date"
