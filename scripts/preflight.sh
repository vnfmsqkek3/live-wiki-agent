#!/usr/bin/env bash
# 개발 도구 설치 여부를 확인한다. 없는 도구만 출력하고 실패 코드로 끝난다.
missing=0
for t in git node npm aws terraform docker; do
  if command -v "$t" >/dev/null 2>&1; then
    printf '%-10s %s\n' "$t" "$("$t" --version 2>&1 | head -1)"
  else
    printf '%-10s 없음\n' "$t"; missing=1
  fi
done
docker buildx version >/dev/null 2>&1 || { echo "docker buildx 없음 (AgentCore arm64 이미지 빌드에 필요)"; missing=1; }
exit $missing
