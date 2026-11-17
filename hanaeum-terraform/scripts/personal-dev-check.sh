#!/usr/bin/env bash
# 개인 dev 자원 점검·정리 (사용자 지시 11/16: 개인 dev 는 기능 테스트용, 테스트 후 정리 가능해야 함. docs/06)
#   기본: 점검만. 개인 자원(이름 -{닉네임} 또는 태그 Owner={닉네임}) 목록 + 공유 자원이 참조하는지 확인
#   --apply: 공유 참조가 없을 때만 Lambda·IAM Role 삭제 (그 외 종류는 목록만 보여 주고 수동 정리)
# 공유 테이블·버킷의 데이터는 정리 대상이 아니다.
# 사용: set -a; . ./.env.local; set +a; hanaeum-terraform/scripts/personal-dev-check.sh <닉네임> [--apply]
set -euo pipefail
NICK=${1:?닉네임}; APPLY=${2:-}
[ "$(aws sts get-caller-identity --query Account --output text)" = "$HANAEUM_ACCOUNT_ID" ] || { echo "계정 불일치" >&2; exit 1; }

FNS=$(aws lambda list-functions --query "Functions[?ends_with(FunctionName,'-$NICK')].FunctionName" --output text)
ROLES=$(aws iam list-roles --query "Roles[?ends_with(RoleName,'-$NICK')].RoleName" --output text)
TAGGED=$(aws resourcegroupstaggingapi get-resources --tag-filters "Key=Owner,Values=$NICK" --query 'ResourceTagMappingList[].ResourceARN' --output text)
echo "Lambda: ${FNS:-없음}"; echo "IAM Role: ${ROLES:-없음}"; echo "Owner=$NICK 태그 자원: ${TAGGED:-없음}"

# 공유 자원(파이프라인 Gateway Target, KB 데이터 소스 변환 Lambda)이 개인 Lambda 를 부르는지
REFS=""
for gw in $(aws bedrock-agentcore-control list-gateways --query 'items[].gatewayId' --output text); do
  for t in $(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$gw" --query 'items[].targetId' --output text); do
    arn=$(aws bedrock-agentcore-control get-gateway-target --gateway-identifier "$gw" --target-id "$t" \
      --query 'targetConfiguration.mcp.lambda.lambdaArn' --output text 2>/dev/null || true)
    case "$arn" in *"-$NICK") case "$gw" in *"-$NICK"*) ;; *) REFS+="Gateway $gw → ${arn##*:}"$'\n' ;; esac ;; esac
  done
done
KB=$(aws ssm get-parameter --name /hanaeum-mvp/dev/KB_ID --query Parameter.Value --output text 2>/dev/null || true)
if [ -n "$KB" ]; then
  for ds in $(aws bedrock-agent list-data-sources --knowledge-base-id "$KB" --query 'dataSourceSummaries[].dataSourceId' --output text); do
    arn=$(aws bedrock-agent get-data-source --knowledge-base-id "$KB" --data-source-id "$ds" \
      --query 'dataSource.vectorIngestionConfiguration.customTransformationConfiguration.transformations[0].transformationFunction.transformationLambdaConfiguration.lambdaArn' --output text)
    case "$arn" in *"-$NICK") REFS+="KB 데이터 소스 $ds → ${arn##*:}"$'\n' ;; esac
  done
fi
if [ -n "$REFS" ]; then printf '공유 자원이 참조 중 (정리 중단):\n%s' "$REFS"; exit 2; fi
echo "공유 참조 없음"

[ "$APPLY" = --apply ] || { echo "점검만 했다. 삭제하려면 --apply"; exit 0; }
for f in $FNS; do aws lambda delete-function --function-name "$f" && echo "삭제: Lambda $f"; done
for r in $ROLES; do
  for p in $(aws iam list-role-policies --role-name "$r" --query PolicyNames --output text); do aws iam delete-role-policy --role-name "$r" --policy-name "$p"; done
  for p in $(aws iam list-attached-role-policies --role-name "$r" --query 'AttachedPolicies[].PolicyArn' --output text); do aws iam detach-role-policy --role-name "$r" --policy-arn "$p"; done
  aws iam delete-role --role-name "$r" && echo "삭제: Role $r"
done
echo "Lambda·Role 외 태그 자원은 위 목록을 보고 수동 정리"
