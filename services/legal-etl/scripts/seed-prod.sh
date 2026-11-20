#!/usr/bin/env bash
# prod 재배포 직후 시드: Registry 적재 → 기반 규정 게시 → 노하우 게시 → 개정본 게시(영향 분석) → 충돌 노하우 차단 확인
# 데모 중 업로드 문서(F-002·F-003·K-001·K-002·A-001)와 프론트QA 업로드 묶음(forged·attack: G-FORGE·G-INJ·A-002)은 넣지 않는다.
# 사용: API=https://<cloudfront> services/legal-etl/scripts/seed-prod.sh   (.env.local 로드, prod 계정)
#       SKIP_REGISTRY=1 로 Registry 적재 생략. 묶음 하나가 중간에 멈추면 publish-regs-dev.sh 를 ID=doc_… 로 이어서 실행
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${API:?API=https://<cloudfront> 필요}"
export HANAEUM_ENV=prod API
[ "$(aws sts get-caller-identity --query Account --output text)" = "${HANAEUM_ACCOUNT_ID:?.env.local 로드 필요}" ] || { echo "계정 불일치" >&2; exit 1; }
P=services/legal-etl/scripts/publish-regs-dev.sh
seq2() { for i in $(seq "$2" "$3"); do printf "$1 " "$(printf %02d "$i")"; done; }  # seq2 G-REG-%s 1 12 → G-REG-01 … G-REG-12

# 0) Registry (Regulations 테이블): F-000·F-001·F-002, G-REG-01~12, G-REV-01~04, L-001 (재실행 안전: putLaw 덮어쓰기)
[ -n "${SKIP_REGISTRY:-}" ] || TABLE_REGULATIONS=$(aws ssm get-parameter --name /hanaeum-mvp/prod/TABLE_REGULATIONS --query Parameter.Value --output text) \
  node mcp/regulation-server/src/load-fixtures.ts
# 1) 기반 규정 → 2) 노하우(규정 게시 뒤라야 근거 확인) → 3) 개정본(직전 버전 diff로 영향 노하우 표시) → 4) 차단 기대
"$P" F-001 $(seq2 G-REG-%s 1 12)
"$P" K-004 $(seq2 G-KN-%s 1 13) $(seq2 G-KREV-%s 1 4)
"$P" $(seq2 G-REV-%s 1 4)
# K-003: 2025년판(7억원) 인용 → 최신성 실패 기대(manifest kb_visibility=false). 게시하지 않고 반려. 영향 5/5는 measure.ts(오프라인 그래프)로 판정
EXPECT=block "$P" K-003 $(seq2 G-KC-%s 1 9)
