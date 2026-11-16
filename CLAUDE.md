# CLAUDE.md · 하나이음(hanaeum) 5팀 Living Wiki MVP

매 세션 지킬 규칙의 요약이다. 문서는 **역할별로 필요한 것만** 읽는다 (`docs/README.md`의 역할별 문서 표).

## 팀

| 이름 | 닉네임 | 영역 | 폴더 |
|---|---|---|---|
| 김동연 | yoyo0704 | 인프라·플랫폼 (최종 배포) | `members/yoyo0704/` |
| 김민정 | let522mj | 데이터·검색 (데이터 QA) | `members/let522mj/` |
| 오태규 | dhxorb96 | 업무 로직·Agent·UI (UI·E2E QA) | `members/dhxorb96/` |

3명의 Claude가 동시에 작업한다. 다른 팀원 폴더와 **다른 사람이 Owner인 코드 경로**(`docs/05` 2장)는 직접 수정하지 않는다.

## 첫 실행 (닉네임만 입력하면 바로 구현 시작)

사용자가 닉네임을 입력하면 아래를 순서대로 실행한다. 질문은 로컬 환경에서 AWS profile이 없을 때 한 번만 한다.

1. `scripts/preflight.sh` — 없는 도구가 있으면 사용자에게 설치 요청 후 계속
2. `scripts/setup-env.sh {닉네임} [{AWS_PROFILE}]` — 출력된 계정 ID를 사용자에게 한 줄로 보여준다
3. Git: `git status`가 깨끗한지 확인 → `git fetch origin` → 브랜치가 있으면 `git switch {닉네임}`, 없으면 `git switch -c {닉네임} origin/main` (`docs/06` 2장. `checkout -B`·`reset --hard`·force push 금지)
4. 읽기: `docs/README.md`의 역할별 필수 문서 + `members/{닉네임}/TODO.md`
5. `members/{닉네임}/plan.md` 작성: 오늘 날짜의 TODO를 작업 단위로 쪼개고, 각 작업의 완료 조건(DoD·QA 기준)과 의존하는 사람·mock 여부를 적는다
6. 첫 작업부터 바로 구현. 계약은 `docs/interfaces.md` v0 기본값을 그대로 쓴다. 다른 사람 결과물이 아직 없으면 mock으로 진행하고 `요청기록/`을 남긴다

## 세션 시작 (두 번째부터)

1. `.env.local`이 없으면 첫 실행 1~2단계. 있으면 AWS·Terraform 명령 전에 `set -a; . ./.env.local; set +a`
2. 작업 트리가 깨끗할 때 `git fetch --prune` → `git switch {닉네임} && git pull --ff-only origin {닉네임}` → `git merge --no-edit origin/main`
   (push한 브랜치는 rebase 금지: force push가 필요해짐. 충돌은 브랜치 주인이 해결)
3. 읽기: `공통기록/` 최신 10건 → `요청기록/` 중 나에게 온 OPEN 건 → `plan.md` → `트러블슈팅.md`

## 기록

| 대상 | 위치 | 형식 |
|---|---|---|
| 개인 기록 | `members/{닉네임}/기록.md` | 시각, 한 것, 시도한 것, 결과 (간략히) |
| 팀 공통 | `공통기록/YYYYMMDD-HHMM_{닉네임}_{주제}.md` | 1건 1파일. 완료·진행중·업데이트·mock 여부. 50건 초과 시 오래된 것부터 `공통기록/archive/` (FIFO) |
| 수정 요청 | `요청기록/YYYYMMDD-HHMM_{요청자}_to_{대상}.md` | 내용, 기준 미달 근거, 상태(OPEN/DONE) |
| 지식 | `트러블슈팅.md`, `members/{닉네임}/plan.md` | 세션이 바뀌어도 남아야 할 문제·해결·남은 작업 |

## 규칙

| 항목 | 규칙 |
|---|---|
| 완료 판정 | `docs/02`의 DoD·정량 기준으로만 판정 |
| 문서 충돌 | 범위·완료·데모 02 > 보안·데이터 원칙 03 > 구현 방식 01 > 구현 세부 04. 역할·소유권·일정 05, 개발 규칙 06, 계약 interfaces |
| 계약 | `docs/interfaces.md`·`packages/schemas`가 단일 원본. 변경은 섹션 Owner가 PR + 변경 이력 + `요청기록/` 통지 |
| 개인정보 | 모델에는 마스킹된 텍스트만 보낸다. 사용자 질의·Tool 인자도 모델 호출 전 PII 검사. 원문·JWT·presigned URL을 로그·Trace에 남기지 않는다 |
| 검색·색인 | Bedrock KB 중심. Agent는 KB를 직접 호출하지 않고 AgentCore Gateway Tool로만 접근하며, Tool은 DynamoDB 현재 상태로 재검증 (`docs/04` 4·7장) |
| 승인 | 사람만 승인. 승인은 문서 버전·해시에 묶고 1회만 사용 (`interfaces.md` 7.1) |
| 언어 | TypeScript. 예외: PaddleOCR SageMaker 컨테이너(Python) |
| 버전 | 설치 전 최신 안정판 조회 → `interfaces.md` 8장 고정표에 기록 → lockfile 고정 |
| 모델 | Sonnet 5.5 / Haiku 5.5 기본, Opus 5.5는 고위험 검토에만. 모델 ID는 환경변수로만 |
| 리전·계정 | us-east-1. AWS 명령 전 계정 ID가 `.env.local`의 `HANAEUM_ACCOUNT_ID`와 같은지 확인 |
| 네이밍 | 개인 dev `hanaeum-mvp-{약어}-{용도}-{닉네임}` / 최종 `hanaeum-mvp-{약어}-{용도}`. 태그 `Project=hanaeum-mvp`, `Owner={닉네임}` |
| 배포 | dev는 각자. 공유 dev·prod는 yoyo0704의 Claude만 `hanaeum-terraform/`으로. State는 S3 backend |
| 데이터 | 실제 은행 문서·고객정보 금지. 합성 문서는 가상 **하나은행** 데이터로 만들고 모든 원본 머리에 `SYNTHETIC — 하나은행 가상 데이터 · … 실제 하나은행 … 아님` 표시 (사용자 결정 11/16) |
| 자료 조사 | `.env.local`의 `HANAEUM_RESEARCH`: `bedrock-websearch`(EC2) / `chrome`(로컬, Claude in Chrome 확장. 없으면 설치 요청). 못 찾는 필수 자료는 사용자에게 PDF 요청 |
| 자료 저장 | 내려받은 파일은 바로 `자료/{용도}/{카테고리}/`로. 파일명 `YYYYMMDD_{출처}_{제목}.{확장자}`. `자료/README.md` 색인에 한 줄 |
| 폴더 구조 | 모든 파일은 **사용목적 → 카테고리** 순으로 저장. 루트에는 정해진 파일만. 새 폴더에는 `README.md`에 목적 한 줄. 맞는 곳이 있으면 새로 만들지 않는다 |
| Git·CI | `docs/06`. public 저장소이므로 secret·실데이터 커밋 금지. main은 PR + 리뷰 1명 + CI 통과 |
| 공통문서 | `공통문서/`는 읽기 전용, Git 미업로드. `docs/`의 md를 먼저 본다 |

## QA (`docs/06` 4장)

- 로컬 → PR → 일일 통합(18:00) → 릴리스(11/21·11/22 전체) 단계로 범위를 넓힌다.
- 같은 기능이 같은 원인으로 3회 실패하면 그 기능만 멈추고 재현 정보와 함께 사용자에게 보고한다. 다른 독립 작업은 계속한다.
- QA agent는 직접 고치지 않고 Owner에게 `요청기록/`으로 요청한다.

## 사용자 응답 형식

간결하게, 해당 있는 행만:

| 구분 | 내용 |
|---|---|
| 시도한 것 | |
| 수정한 것 | |
| 변경된 것 | |
| 알아야 할 것 | |
| 질문 | |
