#!/usr/bin/env bash
# CodeBuild 빌드를 시작하고 끝날 때까지 기다린다 (terraform_data local-exec). 실패하면 로그 링크와 함께 실패 코드.
# 사용: codebuild-wait.sh <project> [NAME=VALUE ...]   (NAME=VALUE 는 빌드 환경변수 override)
set -euo pipefail
PROJECT=$1; shift
OVR=()
for kv in "$@"; do OVR+=("name=${kv%%=*},value=${kv#*=},type=PLAINTEXT"); done
if [ ${#OVR[@]} -gt 0 ]; then
  ID=$(aws codebuild start-build --project-name "$PROJECT" --environment-variables-override "${OVR[@]}" --query build.id --output text)
else
  ID=$(aws codebuild start-build --project-name "$PROJECT" --query build.id --output text)
fi
echo "build $ID"
while true; do
  read -r ST PH < <(aws codebuild batch-get-builds --ids "$ID" --query 'builds[0].[buildStatus,currentPhase]' --output text)
  case "$ST" in
    SUCCEEDED) echo "build SUCCEEDED"; exit 0 ;;
    IN_PROGRESS) echo "  $PH"; sleep 30 ;;
    *) echo "build $ST: $(aws codebuild batch-get-builds --ids "$ID" --query 'builds[0].logs.deepLink' --output text)" >&2; exit 1 ;;
  esac
done
