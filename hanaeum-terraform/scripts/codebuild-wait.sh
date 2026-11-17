#!/usr/bin/env bash
# CodeBuild 빌드를 시작하고 끝날 때까지 기다린다 (terraform_data local-exec). 실패하면 로그 링크와 함께 실패 코드.
# 사용: codebuild-wait.sh <project> [NAME=VALUE ...]   (NAME=VALUE 는 빌드 환경변수 override)
# 새 환경 첫 apply 에서 Role 정책 전파 전에 시작되면 QUEUED 단계 CLIENT_ERROR(로그 권한 없음)로 끝난다 → 30초 뒤 최대 3회 재시작 (prod 11/17 실측)
set -euo pipefail
PROJECT=$1; shift
OVR=()
for kv in "$@"; do OVR+=("name=${kv%%=*},value=${kv#*=},type=PLAINTEXT"); done
start() {
  if [ ${#OVR[@]} -gt 0 ]; then
    aws codebuild start-build --project-name "$PROJECT" --environment-variables-override "${OVR[@]}" --query build.id --output text
  else
    aws codebuild start-build --project-name "$PROJECT" --query build.id --output text
  fi
}
for attempt in 1 2 3 4; do
  ID=$(start)
  echo "build $ID"
  while true; do
    read -r ST PH < <(aws codebuild batch-get-builds --ids "$ID" --query 'builds[0].[buildStatus,currentPhase]' --output text)
    case "$ST" in
      SUCCEEDED) echo "build SUCCEEDED"; exit 0 ;;
      IN_PROGRESS) echo "  $PH"; sleep 30 ;;
      *) break ;;
    esac
  done
  # 빌드 명령까지 가지 못한 권한 전파 실패만 재시도 (진짜 빌드 실패는 바로 실패)
  QERR=$(aws codebuild batch-get-builds --ids "$ID" --query "builds[0].phases[?phaseType=='QUEUED' && phaseStatus=='CLIENT_ERROR'] | length(@)" --output text)
  if [ "$QERR" != 0 ] && [ $attempt -lt 4 ]; then echo "  QUEUED CLIENT_ERROR (IAM 전파 대기) → 30초 뒤 재시작"; sleep 30; continue; fi
  echo "build $ST: $(aws codebuild batch-get-builds --ids "$ID" --query 'builds[0].logs.deepLink' --output text)" >&2
  exit 1
done
