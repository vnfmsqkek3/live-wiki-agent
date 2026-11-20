#!/usr/bin/env bash
# prod 문서 삭제 (API DELETE → 오케스트레이터 정리: KB 제거·그래프 deleteDoc·저장소 purge). 정리가 끝날 때까지 기다린다
# 삭제한 문서를 인용하던 게시 노하우는 '재검토 필요'로 바뀐다(interfaces 6.0) → 노하우를 먼저 지우고 규정을 나중에 지운다
# 사용: API=https://<cloudfront> REASON="…" services/legal-etl/scripts/delete-docs.sh doc_… doc_…   (admin 계정, .env.local 로드)
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${API:?API=https://<cloudfront> 필요}" "${REASON:?REASON 필요 (감사 기록)}"
[ "$(aws sts get-caller-identity --query Account --output text)" = "${HANAEUM_ACCOUNT_ID:?.env.local 로드 필요}" ] || { echo "계정 불일치" >&2; exit 1; }
CLIENT=$(aws ssm get-parameter --name /hanaeum-mvp/prod/COGNITO_CLIENT_ID --query Parameter.Value --output text)
PW=$(aws secretsmanager get-secret-value --secret-id hanaeum-mvp/demo-users --query SecretString --output text \
  | python3 -c 'import json,sys; v=json.load(sys.stdin)["admin"]; print(v["password"] if isinstance(v,dict) else v)')
AT=$(aws cognito-idp initiate-auth --client-id "$CLIENT" --auth-flow USER_PASSWORD_AUTH --auth-parameters "USERNAME=admin,PASSWORD=$PW" --query AuthenticationResult.AccessToken --output text)
body=$(python3 -c 'import json,sys; print(json.dumps({"reason": sys.argv[1]}, ensure_ascii=False))' "$REASON")
for d in "$@"; do
  echo "삭제 $d $(curl -sS -X DELETE "$API/v1/documents/$d" -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "$body" -w ' %{http_code}')"
done
# 정리 완료 = purge.deleted_at (삭제 문서 GET 은 작성자·관리자에게 lifecycle=DELETED 로 보임)
for d in "$@"; do
  for _ in $(seq 1 60); do
    s=$(curl -sS "$API/v1/documents/$d" -H "authorization: Bearer $AT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("lifecycle"), (d.get("purge") or {}).get("deleted_at") or "-")' 2>/dev/null || echo "? -")
    [ "${s#* }" != - ] && break; sleep 5
  done
  echo "결과 $d $s"
done
