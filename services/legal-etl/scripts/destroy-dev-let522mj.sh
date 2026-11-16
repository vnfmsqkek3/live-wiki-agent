#!/usr/bin/env bash
# let522mj 개인 dev 자원 정리 (deploy-dev-let522mj.sh가 만든 것만): Lambda 7개·로그 그룹·IAM Role 3개.
# 개인 dev는 기능 테스트용. 테스트가 끝나면 지운다.
# 안전장치: 공유 자원(KB 데이터 소스 청킹 Lambda, AgentCore Gateway Target)이 아직 -let522mj 함수를 참조하면 멈춘다.
#   → yoyo0704가 공유 이름(hanaeum-mvp-lambda-*)으로 옮긴 뒤 실행.
# 사용: services/legal-etl/scripts/destroy-dev-let522mj.sh          (점검만, 아무것도 지우지 않음)
#       services/legal-etl/scripts/destroy-dev-let522mj.sh --apply  (삭제)
set -euo pipefail
NICK=let522mj
FNS=(text-layer-extract segment-build promote kb-ingest kb-chunker mcp-regulation mcp-search)
ROLES=(steps kbchunker mcp)
[ "$(aws sts get-caller-identity --query Account --output text)" = "${HANAEUM_ACCOUNT_ID:?.env.local 로드 필요}" ] || { echo "계정 불일치"; exit 1; }

# 1) 공유 자원 참조 점검
refs=()
KB=$(aws ssm get-parameter --name /hanaeum-mvp/dev/KB_ID --query Parameter.Value --output text)
for ds in $(aws bedrock-agent list-data-sources --knowledge-base-id "$KB" --query 'dataSourceSummaries[].dataSourceId' --output text); do
  aws bedrock-agent get-data-source --knowledge-base-id "$KB" --data-source-id "$ds" --output json | grep -q -- "-$NICK" && refs+=("KB 데이터 소스 $ds")
done
for g in $(aws bedrock-agentcore-control list-gateways --query 'items[].gatewayId' --output text); do
  case "$g" in *"-$NICK"*) continue;; esac # 내 개인 Gateway는 점검 대상 아님
  for t in $(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$g" --query 'items[].targetId' --output text); do
    aws bedrock-agentcore-control get-gateway-target --gateway-identifier "$g" --target-id "$t" --output json | grep -q -- "-$NICK" && refs+=("Gateway $g target $t")
  done
done
if [ ${#refs[@]} -gt 0 ]; then
  echo "중단: 공유 자원이 아직 -$NICK 함수를 참조함 (공유 이름으로 옮긴 뒤 다시 실행)"; printf '  - %s\n' "${refs[@]}"; exit 2
fi
echo "공유 자원 참조 없음"

# 2) 대상 목록
for f in "${FNS[@]}"; do echo "Lambda hanaeum-mvp-lambda-$f-$NICK, 로그 /aws/lambda/hanaeum-mvp-lambda-$f-$NICK"; done
for r in "${ROLES[@]}"; do echo "Role hanaeum-mvp-role-$r-$NICK"; done
[ "${1:-}" = "--apply" ] || { echo "(점검만 함. 지우려면 --apply)"; exit 0; }

# 3) 삭제 (없는 것은 건너뜀)
for f in "${FNS[@]}"; do
  n="hanaeum-mvp-lambda-$f-$NICK"
  aws lambda delete-function --function-name "$n" 2>/dev/null && echo "삭제 $n" || echo "없음 $n"
  aws logs delete-log-group --log-group-name "/aws/lambda/$n" 2>/dev/null || true
done
for r in "${ROLES[@]}"; do
  n="hanaeum-mvp-role-$r-$NICK"
  for p in $(aws iam list-role-policies --role-name "$n" --query PolicyNames --output text 2>/dev/null); do aws iam delete-role-policy --role-name "$n" --policy-name "$p"; done
  for a in $(aws iam list-attached-role-policies --role-name "$n" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do aws iam detach-role-policy --role-name "$n" --policy-arn "$a"; done
  aws iam delete-role --role-name "$n" 2>/dev/null && echo "삭제 $n" || echo "없음 $n"
done
echo "완료. 공유 테이블·버킷의 데이터(게시 문서, Regulations 기준본)는 공유 dev 자산이라 지우지 않음"
