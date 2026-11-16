#!/usr/bin/env bash
# 실행 환경(EC2/로컬)을 판별하고 개인 설정을 .env.local 에 저장한다.
# 사용: scripts/setup-env.sh <닉네임> [AWS_PROFILE]
#   인자가 없으면 터미널에서 물어본다. Claude는 인자로 넘긴다.
#   기존 .env.local 이 있으면 profile 기본값으로 재사용한다.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=.env.local
NICKS="yoyo0704 let522mj dhxorb96"

# EC2 판별: IMDSv2 토큰 발급이 HTTP 200으로 성공해야 함 (1초 타임아웃)
if curl -sf -m 1 -X PUT http://169.254.169.254/latest/api/token \
     -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' >/dev/null 2>&1; then
  RUNTIME=ec2
else
  RUNTIME=local
fi

NICKNAME=${1:-}
PROFILE=${2:-}
# 기존 설정 재사용 (값만 읽고 source 하지 않음)
if [ -z "$PROFILE" ] && [ -f "$OUT" ]; then
  PROFILE=$(sed -n 's/^AWS_PROFILE=//p' "$OUT")
fi

[ -z "$NICKNAME" ] && read -rp "닉네임 ($NICKS): " NICKNAME || true
case " $NICKS " in *" $NICKNAME "*) ;; *) echo "닉네임은 $NICKS 중 하나여야 합니다" >&2; exit 1;; esac

AWS_ARGS=()
if [ "$RUNTIME" = local ]; then
  [ -z "$PROFILE" ] && read -rp "AWS profile 이름: " PROFILE || true
  [ -z "$PROFILE" ] && { echo "로컬 환경은 AWS profile이 필요합니다" >&2; exit 1; }
  [[ "$PROFILE" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "profile 이름에 허용되지 않는 문자가 있습니다" >&2; exit 1; }
  AWS_ARGS=(--profile "$PROFILE")
  # 정적 키 환경변수가 있으면 profile보다 우선되므로 경고
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && echo "경고: AWS_ACCESS_KEY_ID 환경변수가 설정되어 있어 profile보다 우선됩니다" >&2
fi

# 실제 자격증명 확인 (EC2도 확인)
ACCOUNT=$(aws sts get-caller-identity ${AWS_ARGS[@]+"${AWS_ARGS[@]}"} --query Account --output text) \
  || { echo "AWS 인증 실패 (로컬: aws sso login --profile $PROFILE / EC2: Instance Role 확인)" >&2; exit 1; }

TMP=$(mktemp)
{
  echo "HANAEUM_RUNTIME=$RUNTIME"
  echo "HANAEUM_NICKNAME=$NICKNAME"
  echo "HANAEUM_ENV=dev-$NICKNAME"
  echo "HANAEUM_ACCOUNT_ID=$ACCOUNT"
  echo "AWS_REGION=us-east-1"
  if [ "$RUNTIME" = local ]; then
    echo "AWS_PROFILE=$PROFILE"
    echo "HANAEUM_RESEARCH=chrome"             # 로컬은 Bedrock websearch MCP가 없음
  else
    echo "HANAEUM_RESEARCH=bedrock-websearch"
  fi
} > "$TMP"
mv "$TMP" "$OUT"   # 원자적 교체

echo "저장 완료: $OUT"; cat "$OUT"
echo "확인: 계정 $ACCOUNT 이 팀 계정이 맞는지 확인하세요."
