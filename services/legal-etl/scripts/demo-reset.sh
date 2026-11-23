#!/usr/bin/env bash
# 데모 초기화 (11/22 리허설 전, 총괄 지시 11/20): prod 를 '데모 시작 상태'(시드만, F-002 없음, 영향 표시 없음)로 되돌린다
#  1) F-002 삭제 (데모에서 다시 올리는 장면). F-002 조문을 인용한 노하우는 없다(노하우는 F-001 조문 인용) → 삭제로 재검토 표시가 생기지 않음
#  2) QA·데모 업로드 정리: 시드 목록(SEED_IDS JSON)에 없는 문서 삭제 + EXTRA_IDS(QA팀이 보고한 doc_id, 공백 구분: 버전 묶음 카드·결재함 50건 밖 보완)
#  3) 영향 표시 되돌리기(삭제 뒤): SYN-LOAN-001 개정 또는 2)의 삭제 때문에 '재검토 필요'가 된 게시 노하우 → admin '변경 없이 유효' 확인(데모 계정은 user·admin만, 총괄 11/20. admin은 PLATFORM_OPERATOR라 자기 문서 확인 허용) = CURRENT, 열린 영향 초안(IMPACT) 닫힘
# 기본은 목록만 보여 준다(dry run). APPLY=1 일 때만 바꾼다. 실행 전 총괄·인프라에 예고
# KEEP_IDS: 시드는 아니지만 남길 문서(공백 구분, 예: 사용자 요청 M-002·M-003 외부 법령 참고 시연용, 총괄 11/23) → 2)에서 제외
# 사용: API=https://<cloudfront> SEED_IDS=../team-lead/role/.state/seed-doc-ids.json [EXTRA_IDS="doc_… doc_…"] [KEEP_IDS="doc_…"] [APPLY=1] services/legal-etl/scripts/demo-reset.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${API:?API=https://<cloudfront> 필요}" "${SEED_IDS:?SEED_IDS=seed-doc-ids.json 필요}"
[ "$(aws sts get-caller-identity --query Account --output text)" = "${HANAEUM_ACCOUNT_ID:?.env.local 로드 필요}" ] || { echo "계정 불일치" >&2; exit 1; }
CLIENT=$(aws ssm get-parameter --name /hanaeum-mvp/prod/COGNITO_CLIENT_ID --query Parameter.Value --output text)
secret=$(aws secretsmanager get-secret-value --secret-id hanaeum-mvp/demo-users --query SecretString --output text)
token() { local p; p=$(python3 -c 'import json,sys; v=json.loads(sys.argv[1])[sys.argv[2]]; print(v["password"] if isinstance(v,dict) else v)' "$secret" "$1")
  aws cognito-idp initiate-auth --client-id "$CLIENT" --auth-flow USER_PASSWORD_AUTH --auth-parameters "USERNAME=$1,PASSWORD=$p" --query AuthenticationResult.AccessToken --output text; }
AT=$(token admin)
get() { curl -sS "$API$1" -H "authorization: Bearer $AT"; }
run() { if [ "${APPLY:-}" = 1 ]; then "$@"; else echo "  (dry run) $*" | sed 's/Bearer [^ ]*/Bearer …/'; fi; }
F002=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("F-002",""))' "$SEED_IDS")

echo "1) F-002 삭제: ${F002:-없음}"
[ -z "$F002" ] || run env API="$API" REASON="데모 초기화: F-002 다시 올리는 장면 (리허설 11/22)" services/legal-etl/scripts/delete-docs.sh "$F002"

echo "2) 시드 밖 문서 정리 (QA·데모 업로드)"
# 목록: 문서함(게시·본인) + 관리자 목록 all=1(게시·삭제 밖 전부: 결재 대기·차단·반려·분석 중, 상한 500, 백엔드 #154 · 8차 배포)
# (11/23: 결재 대기·차단이 목록 밖이라 보안 테스트 문서가 남았다가 결재 뒤 검색에 노출됨)
EXTRA=$( { get /v1/library; echo; get "/v1/admin/in-review?all=1"; } | python3 -c 'import json,sys,re
seed=set(json.load(open(sys.argv[1])).values())|set(sys.argv[3].split())
seen=set()
for line in sys.stdin:
  if not line.strip(): continue
  for x in json.loads(line).get("items",[]):
    if x["doc_id"] not in seed and x["doc_id"] not in seen: seen.add(x["doc_id"]); print(x["doc_id"], x.get("lifecycle") or x.get("kind",""), (x.get("title") or "")[:40], file=sys.stderr); print(x["doc_id"])
for d in sys.argv[2].split():
  if not re.fullmatch(r"doc_[0-9A-Z]{26}", d): print(d, "doc_id 형식 아님, 제외", file=sys.stderr)
  elif d in seed: print(d, "시드·KEEP 문서라 제외", file=sys.stderr)
  elif d not in seen: seen.add(d); print(d, "EXTRA_IDS", file=sys.stderr); print(d)' "$SEED_IDS" "${EXTRA_IDS:-}" "${KEEP_IDS:-}")
[ -z "$EXTRA" ] || run env API="$API" REASON="데모 초기화: 시드 밖 QA·데모 업로드 정리 (리허설 11/22)" services/legal-etl/scripts/delete-docs.sh $EXTRA
# 삭제 정리(그래프·재검토 표시)는 delete-docs.sh 가 끝까지 기다림 → 아래 3)이 그 표시까지 되돌림
# 표시 되돌리기는 삭제 뒤에: 삭제한 문서를 인용하던 노하우에도 재검토 표시가 생긴다(데이터QA 리뷰 11/20)
echo "3) 영향·삭제 재검토 표시 되돌리기"
for d in $(get /v1/library | python3 -c 'import json,sys
for x in json.load(sys.stdin)["items"]:
  r=x.get("freshness_reason") or {}
  if x.get("document_type")!="REGULATION" and x.get("freshness")=="REVIEW_REQUIRED" and (r.get("law_id")=="SYN-LOAN-001" or r.get("deleted_doc")): print(x["doc_id"])'); do
  echo "  $d"
  run curl -sS -X POST "$API/v1/documents/$d/freshness/confirm" -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"reason":"데모 초기화: F-002 영향 표시 되돌림 (리허설 11/22)"}'
done

[ "${APPLY:-}" = 1 ] || echo "dry run 끝. 바꾸려면 APPLY=1"
