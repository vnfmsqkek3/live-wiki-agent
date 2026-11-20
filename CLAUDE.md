# CLAUDE.md · 하나이음(hanaeum) 5팀 Living Wiki MVP

매 세션 지킬 규칙의 요약이다. 문서는 **팀별로 필요한 것만** 읽는다 (`role/{팀명}.md`의 필수 문서).

## 팀 (11/20부터 역할별 팀 체제)

에이전트 1개가 팀 1개를 맡는다. 팀 목록, 소유 경로, Orca 협업 규칙은 `role/README.md`에 있다. 각 팀의 책임과 남은 일은 `role/{팀명}.md`에 있다.

| 팀 | slug | 팀 | slug |
|---|---|---|---|
| 총괄팀 | `lead` | AI엔지니어팀 | `ai` |
| 인프라팀 (IaC, 최종 배포) | `infra` | 데이터엔지니어팀 | `data` |
| 백엔드팀 | `backend` | 데이터QA팀 | `data-qa` |
| 프론트엔드팀 | `frontend` | 엔드유저팀 | `enduser` |
| 프론트엔드QA팀 | `frontend-qa` | | |

다른 팀이 Owner인 경로(`role/README.md` 1장)는 직접 수정하지 않는다. 단 `docs/`는 초안이므로 실제와 다르거나 비효율적인 부분은 어느 팀이든 고친다 (`docs/02`만 총괄팀 리뷰). `members/`·`요청기록/`·`공통기록/`은 11/20 이전 기록 보관용이며 읽기 전용이다.

## 첫 실행 (팀명만 입력하면 바로 시작)

총괄팀이 Orca로 띄운 경우에는 launch prompt에 팀명과 총괄팀 handle이 들어 있다. 사용자가 팀명을 직접 입력한 경우에도 같은 순서로 진행한다.

1. `scripts/preflight.sh` — 없는 도구가 있으면 사용자에게 설치를 요청한 뒤 계속한다
2. `scripts/setup-env.sh {slug} [{AWS_PROFILE}]` — 출력된 계정 ID를 사용자에게 한 줄로 보여준다 (엔드유저팀은 생략)
3. Git: Orca worktree면 이미 `team/{slug}` 브랜치에 있다. 아니면 `git status`가 깨끗한지 확인 → `git fetch origin` → `git switch team/{slug}`. 브랜치가 없으면 `git switch -c team/{slug} origin/main`
4. 읽기: `role/README.md` → `role/{팀명}.md` → 그 파일의 필수 문서
5. `role/.state/{slug}.md` 작성: 남은 일을 작업 단위로 쪼개고, 각 작업의 완료 조건(DoD·QA 기준), 의존하는 팀, mock 여부를 적는다
6. 첫 작업부터 바로 구현한다. 계약은 `docs/interfaces.md` v0 기본값을 그대로 쓴다. 다른 팀 결과물이 아직 없으면 mock으로 진행하고 Owner 팀에 Orca로 요청한다

## 세션 시작 (두 번째부터)

1. `.env.local`이 없으면 첫 실행 1~2단계를 한다. 있으면 AWS·Terraform 명령 전에 `set -a; . ./.env.local; set +a`
2. 작업 트리가 깨끗할 때 `git fetch --prune` → `git pull --ff-only origin team/{slug}` → `git merge --no-edit origin/main`
   (push한 브랜치는 rebase 금지: force push가 필요해진다. 충돌은 브랜치 주인 팀이 해결한다)
3. `orca orchestration check --json`으로 받은 요청을 확인한다 → `role/.state/{slug}.md` → `트러블슈팅.md`

## 소통과 기록 (GitHub로 요청·기록하지 않음)

| 대상 | 방법 |
|---|---|
| 수정 요청·질문 | `orca orchestration send --to <팀 handle> --type question` (내용, 기준 미달 근거, 완료 조건). 받은 쪽은 처리 후 `orca orchestration reply` |
| 완료·진행·mock 보고 | 총괄팀 handle로 `orca orchestration send` |
| 팀 진행 상태 | `role/.state/{slug}.md` (Git 미업로드) |
| 지식 | `트러블슈팅.md` — 세션이 바뀌어도 남아야 할 문제와 해결 |

상대 팀 handle 찾기와 메시지 종류는 `role/README.md` 2장을 따른다.

## 규칙

| 항목 | 규칙 |
|---|---|
| 완료 판정 | `docs/02`의 DoD·정량 기준으로만 판정 |
| 문서 충돌 | 범위·완료·데모 02 > 보안·데이터 원칙 03 > 구현 방식 01 > 구현 세부 04. 역할·소유권·소통 `role/` (05·06과 다르면 `role/` 우선), 일정 05, 개발 규칙 06, 계약 interfaces |
| 계약 | `docs/interfaces.md`·`packages/schemas`가 단일 원본. 변경은 섹션 Owner 팀이 PR + 변경 이력 + 영향받는 팀에 Orca 통지 |
| 개인정보 | 모델에는 마스킹된 텍스트만 보낸다. 사용자 질의·Tool 인자도 모델 호출 전 PII 검사. 원문·JWT·presigned URL을 로그·Trace에 남기지 않는다 |
| 검색·색인 | Bedrock KB 중심. Agent는 KB를 직접 호출하지 않고 AgentCore Gateway Tool로만 접근하며, Tool은 DynamoDB 현재 상태로 재검증 (`docs/04` 4·7장) |
| 승인 | 사람만 승인. 승인은 문서 버전·해시에 묶고 1회만 사용 (`interfaces.md` 7.1) |
| 언어 | TypeScript. 예외: PaddleOCR SageMaker 컨테이너(Python) |
| 버전 | 설치 전 최신 안정판 조회 → `interfaces.md` 8장 고정표에 기록 → lockfile 고정 |
| 모델 | Sonnet 5.5 / Haiku 5.5 기본, Opus 5.5는 고위험 검토에만. 모델 ID는 환경변수로만 |
| 리전·계정 | us-east-1. AWS 명령 전 계정 ID가 `.env.local`의 `HANAEUM_ACCOUNT_ID`와 같은지 확인 |
| 네이밍 | prod `hanaeum-mvp-{약어}-{용도}`. 태그 `Project=hanaeum-mvp`, `Owner={slug}` |
| 배포 | **prod 단일 환경** (사용자 결정 11/20: dev 미사용). 테스트·반영·수정 모두 prod에서 한다. 배포는 인프라팀만 `hanaeum-terraform/`으로 한다. 다른 팀은 dev 리소스를 만들지 않고 main 병합 → 인프라팀 prod 배포를 요청한다. State는 S3 backend |
| 데이터 | 실제 은행 문서·고객정보 금지. 합성 문서는 가상 **하나은행** 데이터로 만들고 모든 원본 머리에 `SYNTHETIC — 하나은행 가상 데이터 · … 실제 하나은행 … 아님` 표시 (사용자 결정 11/16) |
| 자료 조사 | `.env.local`의 `HANAEUM_RESEARCH`: `bedrock-websearch`(EC2) / `chrome`(로컬, Claude in Chrome 확장. 없으면 설치 요청). 못 찾는 필수 자료는 사용자에게 PDF 요청 |
| 자료 저장 | 내려받은 파일은 바로 `자료/{용도}/{카테고리}/`로. 파일명 `YYYYMMDD_{출처}_{제목}.{확장자}`. `자료/README.md` 색인에 한 줄 |
| 폴더 구조 | 모든 파일은 **사용목적 → 카테고리** 순으로 저장. 루트에는 정해진 파일만. 새 폴더에는 `README.md`에 목적 한 줄. 맞는 곳이 있으면 새로 만들지 않는다 |
| Git·CI | `docs/06`. public 저장소이므로 secret·실데이터 커밋 금지. main은 PR + 리뷰 1팀(`role/README.md` 1장) + CI 통과. 리뷰 요청과 병합 알림도 Orca로 한다 |
| 공통문서 | `공통문서/`는 읽기 전용, Git 미업로드. `docs/`의 md를 먼저 본다 |

## 컨텍스트 압축

길어지면 스스로 `/compact`. 그 전에 `role/.state/{slug}.md`에 끝낸 일·다음 일·대기 중 요청을 기록하고, 압축 뒤 `role/README.md` → `role/{팀명}.md` → `role/.state/{slug}.md` → `orca orchestration check` 순서로 다시 시작한다 (`role/README.md` 2장).

## QA (`docs/06` 4장)

- 로컬 → PR → 일일 통합(18:00) → 릴리스(11/21·11/22 전체) 단계로 범위를 넓힌다.
- 같은 기능이 같은 원인으로 3회 실패하면 그 기능만 멈추고 재현 정보와 함께 사용자에게 보고한다. 다른 독립 작업은 계속한다.
- QA 팀(프론트엔드QA·데이터QA)과 엔드유저팀은 직접 고치지 않고 Owner 팀에 Orca로 요청한다.
- 3회 실패는 총괄팀에 보고하고, 총괄팀이 사용자에게 보고한다.

## 사용자 응답 형식

간결하게, 해당 있는 행만:

| 구분 | 내용 |
|---|---|
| 시도한 것 | |
| 수정한 것 | |
| 변경된 것 | |
| 알아야 할 것 | |
| 질문 | |
