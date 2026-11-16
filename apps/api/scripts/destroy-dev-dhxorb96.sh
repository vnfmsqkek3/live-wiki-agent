#!/usr/bin/env bash
# dhxorb96 개인 dev 정리 (요청기록 20261116-2242: 개인 dev는 기능 테스트용, 테스트 후 정리 가능해야 함)
# 기본은 점검만 한다. --apply 일 때만 삭제하며, 공유 자원(이름에 -dhxorb96 없음)이 개인 자원을 참조하면 삭제하지 않고 중단한다.
# 공유 테이블·버킷의 데이터는 대상이 아니다.
#   set -a; . ./.env.local; set +a
#   apps/api/scripts/destroy-dev-dhxorb96.sh           # 점검
#   apps/api/scripts/destroy-dev-dhxorb96.sh --apply   # 삭제
set -euo pipefail
NICK=dhxorb96
APPLY=${1:-}
export AWS_REGION=${AWS_REGION:-us-east-1}
ACC=$(aws sts get-caller-identity --query Account --output text)
[ "$ACC" = "${HANAEUM_ACCOUNT_ID:-}" ] || { echo "계정 불일치: $ACC (기대 ${HANAEUM_ACCOUNT_ID:-미설정})"; exit 2; }

ac() { aws bedrock-agentcore-control "$@"; }
lambdas=$(aws lambda list-functions --query "Functions[?ends_with(FunctionName, '-${NICK}')].FunctionName" --output text | tr '\t' '\n' | sort)
gws=$(ac list-gateways --query "items[?contains(name, '-${NICK}')].[gatewayId,name]" --output text)
rts=$(ac list-agent-runtimes --query "agentRuntimes[?contains(agentRuntimeName, '_${NICK}')].[agentRuntimeId,agentRuntimeName]" --output text)
roles=$(aws iam list-roles --query "Roles[?ends_with(RoleName, '-${NICK}')].RoleName" --output text | tr '\t' '\n' | sort)
logs=$(aws logs describe-log-groups --query "logGroups[?contains(logGroupName, '${NICK}')].logGroupName" --output text | tr '\t' '\n' | sort)
ecr=$(aws ecr describe-repositories --query "repositories[?ends_with(repositoryName, '-${NICK}')].repositoryName" --output text)
pools=$(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?contains(Name, '${NICK}')].[Id,Name]" --output text)

echo "== 개인 자원 (-${NICK})"
printf 'Lambda\n%s\n\nGateway\n%s\n\nRuntime\n%s\n\nIAM Role\n%s\n\nLog group\n%s\n\nECR\n%s\n\nCognito\n%s\n' \
  "${lambdas:--}" "${gws:--}" "${rts:--}" "${roles:--}" "${logs:--}" "${ecr:--}" "${pools:--}"

# ---- 공유 자원 → 개인 자원 참조 점검 ----
refs=()
while read -r gid gname; do
  [ -z "$gid" ] && continue
  case "$gname" in *-"$NICK"*) continue ;; esac  # 개인 Gateway는 제외
  for tid in $(ac list-gateway-targets --gateway-identifier "$gid" --query 'items[].targetId' --output text); do
    arn=$(ac get-gateway-target --gateway-identifier "$gid" --target-id "$tid" --query 'targetConfiguration.mcp.lambda.lambdaArn' --output text 2>/dev/null || true)
    case "$arn" in *-"$NICK") refs+=("공유 Gateway $gname target $tid → $arn") ;; esac
  done
done < <(ac list-gateways --query 'items[].[gatewayId,name]' --output text)
for fn in $lambdas; do
  for m in $(aws lambda list-event-source-mappings --function-name "$fn" --query 'EventSourceMappings[].EventSourceArn' --output text); do
    case "$m" in *-"$NICK"*) ;; *) refs+=("공유 이벤트 소스 $m → $fn") ;; esac
  done
done
for p in $(aws ssm get-parameters-by-path --path /hanaeum-mvp --recursive --query "Parameters[?contains(Value, '${NICK}')].Name" --output text); do
  refs+=("SSM $p 값에 ${NICK} 포함")
done
# 개인 Gateway가 다른 사람 개인 Lambda를 부르는지 (정리 전 알림용, 중단 사유 아님)
while read -r gid gname; do
  [ -z "$gid" ] && continue
  for tid in $(ac list-gateway-targets --gateway-identifier "$gid" --query 'items[].targetId' --output text); do
    arn=$(ac get-gateway-target --gateway-identifier "$gid" --target-id "$tid" --query 'targetConfiguration.mcp.lambda.lambdaArn' --output text 2>/dev/null || true)
    case "$arn" in *-"$NICK"|None|"") ;; *) echo "참고: 개인 Gateway $gname target $tid → $arn" ;; esac
  done
done <<< "$gws"

echo; echo "== 공유 자원의 참조"
if [ ${#refs[@]} -gt 0 ]; then printf '  %s\n' "${refs[@]}"; else echo "  없음"; fi

[ "$APPLY" = "--apply" ] || { echo; echo "점검만 했습니다. 삭제하려면 --apply"; exit 0; }
[ ${#refs[@]} -eq 0 ] || { echo "공유 자원이 참조 중이라 삭제하지 않습니다"; exit 1; }

echo; echo "== 삭제"
while read -r gid gname; do
  [ -z "$gid" ] && continue
  for tid in $(ac list-gateway-targets --gateway-identifier "$gid" --query 'items[].targetId' --output text); do ac delete-gateway-target --gateway-identifier "$gid" --target-id "$tid" >/dev/null; done
  # 대상 삭제가 끝나야 Gateway를 지울 수 있다
  for _ in $(seq 1 30); do [ -z "$(ac list-gateway-targets --gateway-identifier "$gid" --query 'items[].targetId' --output text)" ] && break; sleep 5; done
  ac delete-gateway --gateway-identifier "$gid" >/dev/null && echo "Gateway $gname"
done <<< "$gws"
while read -r rid rname; do [ -z "$rid" ] && continue; ac delete-agent-runtime --agent-runtime-id "$rid" >/dev/null && echo "Runtime $rname"; done <<< "$rts"
for fn in $lambdas; do aws lambda delete-function --function-name "$fn" && echo "Lambda $fn"; done
for r in $roles; do
  for p in $(aws iam list-role-policies --role-name "$r" --query 'PolicyNames' --output text); do aws iam delete-role-policy --role-name "$r" --policy-name "$p"; done
  for p in $(aws iam list-attached-role-policies --role-name "$r" --query 'AttachedPolicies[].PolicyArn' --output text); do aws iam detach-role-policy --role-name "$r" --policy-arn "$p"; done
  aws iam delete-role --role-name "$r" && echo "Role $r"
done
for l in $logs; do aws logs delete-log-group --log-group-name "$l" && echo "Log $l"; done
for e in $ecr; do aws ecr delete-repository --repository-name "$e" --force >/dev/null && echo "ECR $e"; done
while read -r pid pname; do [ -z "$pid" ] && continue; aws cognito-idp delete-user-pool --user-pool-id "$pid" && echo "Cognito $pname"; done <<< "$pools"
echo "완료"
