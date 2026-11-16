# 개발 운영 규칙 · Git · CI · QA · 보안

> 모든 팀원 공통. 세 Claude가 같은 저장소를 동시에 쓰므로 이 규칙을 어기면 통합이 깨진다.

## 1. 개발 환경

| 도구 | 버전 기준 | 확인 |
|---|---|---|
| Node.js | 최신 LTS | `scripts/preflight.sh` |
| 패키지 관리 | npm workspaces (추가 설치 없음) | |
| AWS CLI | v2 | |
| Terraform | 최신 안정판, provider는 `.terraform.lock.hcl`로 고정 | |
| Docker | buildx 사용 가능 (AgentCore 이미지는 linux/arm64) | |
| Python | 3.x (OCR 컨테이너 빌드만) | |

- M0에 실제 사용 버전을 `interfaces.md` 8장 버전 고정표에 기록한다. 이후 버전 변경은 Owner PR로만 한다.
- 최신 버전이 계정·리전에서 동작하지 않으면 바로 이전 안정판으로 내리고 `트러블슈팅.md`에 기록한다.

## 2. Git

| 항목 | 규칙 |
|---|---|
| 브랜치 | 개인 브랜치 `{닉네임}`. 이미 있으면 `git switch {닉네임}`, 없으면 `git switch -c {닉네임} origin/main`. **`checkout -B`, `reset --hard`, force push 금지** |
| 시작 전 | 작업 트리가 깨끗한지 확인 (`git status`). 변경이 남아 있으면 커밋하거나 사용자에게 묻는다 |
| 동기화 | 세션 시작마다 `git fetch` → `git pull --ff-only origin {닉네임}` → `git merge origin/main`. push 전 로컬 커밋만 있을 때는 rebase 허용. 충돌은 브랜치 주인이 해결. main 병합은 Squash merge |
| 커밋 | 작게, 기능 단위. 메시지 `[{닉네임}] {영역}: {요약}` |
| main 병합 | PR 필수. 리뷰어 1명 승인(`05` 2장) + CI 통과. 매일 18:00(KST) 통합 |
| main 직접 push | 금지 (초기 골격 커밋만 예외) |
| 기록 파일 | `공통기록/`·`요청기록/`은 1건 1파일이라 충돌하지 않음. 개인 브랜치에 남겨도 PR로 main에 함께 들어감 |

## 3. CI (GitHub Actions, Owner yoyo0704)

| 워크플로 | 트리거 | 검사 | 필수 여부 |
|---|---|---|---|
| `ci-app` | PR | `npm run lint`, `npm run typecheck`, `npm test` (변경된 워크스페이스) | 필수 |
| `ci-iac` | PR (`hanaeum-terraform/**`) | `terraform fmt -check`, `validate`, tflint, checkov | 필수 |
| `ci-secret` | PR·push | gitleaks | 필수 |
| `ci-data` | PR (`packages/legal-parser/**`, `tests/fixtures/**`) | 파서 정답 비교 (오프라인, AWS 불필요) | 필수 |

- CI는 AWS에 접근하지 않는다 (public 저장소이므로 자격증명을 CI에 두지 않음). 배포·AWS 연동 테스트는 각자 EC2/로컬에서 실행하고 결과를 PR 본문에 붙인다.
- 저장소 설정에서 **GitHub secret scanning + push protection**을 켠다 (저장소 관리자 작업).

## 4. QA 실행 단계

| 단계 | 언제 | 범위 |
|---|---|---|
| 로컬 | 기능 작업 중 | 해당 기능 테스트 |
| PR | 병합 전 | 변경 워크스페이스 테스트 + 영향받는 계약(schemas) 사용처 테스트 |
| 일일 통합 | 18:00 병합 후 | dev 환경 E2E smoke (정상 문서 1건 등록→검색) |
| 릴리스 | 11/21, 11/22 | `02` 4장 정량 기준 전체 + 보안 테스트 전체 |

- 실패 집계는 **기능 × 원인** 단위로 센다. AWS 일시 오류(Throttling, 5xx)는 세지 않는다.
- 같은 기능이 같은 원인으로 3회 실패하면 그 기능을 멈추고 재현 방법·로그·막힌 의존성을 사용자에게 보고한다. 독립된 다른 작업은 계속한다.
- QA agent는 직접 고치지 않고 Owner에게 `요청기록/`으로 요청한다.

## 5. 보안 (public 저장소)

| 규칙 | 내용 |
|---|---|
| 커밋 금지 | 자격증명, `.env*`(단 `.env.example` 허용, 값은 placeholder), `*.tfstate`, `*.tfvars`, plan 파일, 로그, 실데이터 |
| 데이터 | 합성 문서만 (`SYNTHETIC` 표시). 실제 은행 문서·고객정보는 저장소·AWS 어디에도 두지 않음 |
| 계정 확인 | AWS 명령 전 `aws sts get-caller-identity`의 계정 ID가 팀 계정인지 확인 (`.env.local`의 `HANAEUM_ACCOUNT_ID`) |
| 로그·Trace | 원문·JWT·presigned URL·PII를 남기지 않음. 필드 allowlist 방식으로 기록 |

## 6. Claude 작업 단위

1. `plan.md`에서 작업 1개 선택 → 2. 구현 + 테스트 → 3. 로컬 QA → 4. 커밋 → 5. `기록.md` 1줄 → 6. 의미 있는 완료면 `공통기록/` 1건 → 7. 다음 작업.
다른 사람 코드가 필요하면 기다리지 말고 mock으로 진행하고 `요청기록/`을 남긴다.
