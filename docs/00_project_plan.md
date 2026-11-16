# 하나이음(hanaeum) 5팀 · 프로젝트 운영 계획

> 이 문서는 각 팀원의 Claude Code가 작업 공간을 세팅하고 매 세션 따를 규칙의 원본이다.
> 원본 위치: `공통문서/project_plan.md` (읽기 전용). Git 공유본: `docs/00_project_plan.md`.
> 1차 작업: 본 문서와 `docs/` 정의서를 읽고 "6. 폴더 구조"를 생성한 뒤, 팀원별 `TODO.md`를 작성한다.

---

## 1. 프로젝트 개요

| 항목 | 내용 |
|---|---|
| 대회 | 하나은행 경진대회 |
| 마감 | 2026-12-03 제출. **팀 목표: 2026-11-23까지 MVP 전 기능 구현** |
| 팀 | 5팀 · 하나이음(hanaeum) |
| 구성원 | 김동연(`yoyo0704`), 김민정(`let522mj`), 오태규(`dhxorb96`) — 괄호는 닉네임. 각자 EC2(또는 로컬)에서 Claude Code 1개씩 운영 |
| 서비스 | Living Wiki — 금융기관 AI 지식 거버넌스 플랫폼 |
| 저장소 | https://github.com/vnfmsqkek3/live-wiki-agent.git |

### 1.1 기준 문서

| 문서 | 원본 PDF (`공통문서/`) | 공유용 md (`docs/`) | 용도 |
|---|---|---|---|
| 기술 정의서 | `Living_Wiki_Final_Integrated_Architecture.pdf` | `01_architecture_spec.md` | 무엇을 어떻게 만드는가 |
| 완료 정의(DoD)·데모 | `Living_Wiki_MVP_DoD_Demo_Scenarios.pdf` | `02_mvp_dod_checklist.md` | **완료 판정 기준**, QA 기준치 |
| 혁신금융 원칙 | `혁신금융서비스 1차 신청 아키텍처.pdf` | `03_innovative_finance_principles.md` | 당선 시 혁신금융 신청 대비 아키텍처 원칙 |
| 참고 구현 패턴 | (팀 작성) | `04_reference_patterns.md` | IDP·OCR·Neptune 적재·Bedrock KB·AgentCore·법령 파싱의 검증된 구현 방식과 피할 실수 |
| R&R·소유권·일정 | (팀 작성) | `05_rnr_ownership.md` | 코드 경로 소유권, 14단계 담당, 일 단위 일정 |
| 개발 운영 규칙 | (팀 작성) | `06_dev_workflow.md` | Git·CI·QA·보안 |
| 공유 계약 | (팀 작성) | `interfaces.md` | ID·enum·S3·환경변수·API·승인 바인딩 |

- 사람과 Claude는 `docs/`의 md를 기본으로 읽는다. 해석이 애매하면 원본 PDF를 확인한다.
- 혁신금융 문서는 다른 과제 기준이므로 공통 원칙(개인정보 차단선, 원본·정제 버킷 분리, 3계층)만 적용한다. 구현 체크리스트는 `03` 5장.
- 문서 간 충돌 시 우선순위: **범위·완료 기준·데모는 02**, 보안·데이터 원칙은 03, 구현 방식은 01, 01에 없는 구현 세부는 04, 일정·역할·도구는 본 문서. 설계서(01)의 "4주 일정"·"7분 데모"는 적용하지 않는다.

---

## 2. 역할 분담

| 담당 | 영역 | 핵심 책임 | 책임 QA |
|---|---|---|---|
| 김동연 (yoyo0704) | 인프라·플랫폼 | AWS 리소스 전체(`hanaeum-terraform/`), OCR 컨테이너, Step Functions 배선·에러 처리, CI, Observability·평가 실행기, **최종 배포** | 인프라 smoke, 정량 결과표 집계 |
| 김민정 (let522mj) | 데이터·검색 | 합성 데이터·정답, 공유 스키마(`packages/schemas`), 법령 파서, KB 색인·검색, Neptune·Change Impact, 검색 계열 MCP Tool | **데이터 QA** (파싱·청킹·메타데이터·검색 정확도) |
| 오태규 (dhxorb96) | 업무 로직·Agent·UI | Backend API, 승인·Trust Gate·PII·분류, Strands Agents, 승인·개인정보 MCP Tool, 반응형 화면 8종 | **UI QA**, E2E, 보안 테스트 |

- 코드 경로별 소유권, 문서 처리 14단계 담당, MCP Tool 소유, 정량 기준 측정 담당은 `docs/05_rnr_ownership.md`.
- 협업 계약은 `docs/interfaces.md` v0 기본값으로 바로 시작하고, 변경은 섹션 Owner가 PR로 한다.

---

## 3. 일정

| 구간 | 기간 | 목표 |
|---|---|---|
| M0 | 11/16 | 계약·소유권·버전 고정, 계정·모델·GPU 확인, Runtime→Gateway 1회 호출 |
| M1 | 11/17 – 11/19 | 공유 dev 환경, **11/18 정상 문서 등록→승인→검색 E2E**, 11/19 위조·Injection 차단·정확 조문 답변 |
| M2 | 11/20 – 11/22 | 노하우 충돌·Change Impact, **11/21 P0 자동 평가 통과 후 P1**, 11/22 전체 회귀·리허설 |
| M3 | 11/23 | 검증된 버전 prod 배포·최종 리허설 |
| 버퍼 | 11/24 – 12/03 | 수정·P2·제출 준비 |

일 단위 완료 조건과 담당은 `docs/05_rnr_ownership.md` 6장. 완료 판정은 `docs/02_mvp_dod_checklist.md`로만 한다.

---

## 4. Claude 공통 운영 규칙 (CLAUDE.md에 반영)

| No | 규칙 |
|---|---|
| 0 | 세션 시작 시 `.env.local`이 없으면 실행 환경을 판별한다. EC2면 닉네임만, 로컬이면 닉네임과 AWS profile을 사용자에게 물은 뒤 `scripts/setup-env.sh {닉네임} [{AWS_PROFILE}]`로 저장한다. 이후 모든 AWS·Terraform 명령은 `.env.local`을 읽고 실행한다 (`set -a; . ./.env.local; set +a`). |
| 1 | 3명이 동시에 작업 중임을 인지한다. 다른 팀원 폴더의 파일은 수정하지 않는다. |
| 2 | 세션 시작 시 `CLAUDE.md` → `공통기록/` 최신 10건 → 본인 `TODO.md`·`plan.md` → `트러블슈팅.md` 순으로 읽는다. 문서는 역할별 필수 문서만 읽는다 (`docs/README.md`). |
| 3 | 본인 작업은 `members/{닉네임}/기록.md`에 간략히 남긴다 (시각, 한 것, 시도한 것, 결과). |
| 4 | 완료·진행중·업데이트는 `공통기록/YYYYMMDD-HHMM_{닉네임}_{주제}.md` 파일 1건으로 남긴다 (Git conflict 방지). 오래된 순으로 쌓이며 읽을 때는 최신순으로 읽는다. 50건 초과 시 오래된 것부터 `공통기록/archive/`로 옮긴다 (FIFO). |
| 5 | 트러블슈팅, 남은 작업, 결정 사항은 세션이 끝나도 남도록 md로 문서화한다. |
| 6 | 각자 폴더의 `TODO.md`를 기준으로 `plan.md`를 작성·갱신한다. |
| 7 | `공통문서/`는 팀 공통 목표이며 **읽기 전용**이다. 수정하지 않는다. |
| 8 | 다른 팀원에게 수정을 요청할 때는 `요청기록/YYYYMMDD-HHMM_{요청자}_to_{대상}.md`로 남긴다 (내용, 기준 미달 근거, 상태). |
| 9 | 개발 중 자료 조사: EC2는 Bedrock agent websearch(MCP), 로컬은 Claude in Chrome 확장으로 검색·다운로드한다 (`.env.local`의 `HANAEUM_RESEARCH`). 내려받은 파일은 `자료/{용도}/{카테고리}/`로 옮기고 `자료/README.md` 색인에 기록한다. 못 찾는 필수 자료는 사용자에게 PDF로 요청한다. |
| 9-1 | 모든 파일은 사용목적 → 카테고리 순으로 폴더를 나눠 저장한다. 루트에는 정해진 파일만 둔다. 새 폴더에는 `README.md`로 목적을 한 줄 적는다. |
| 10 | 패키지·라이브러리·모델·컨테이너(PaddleOCR 등)는 설치 전에 최신 안정 버전을 조회해 적용하고, lockfile로 버전을 고정한다. |
| 11 | 사용자 응답과 기록은 간결하게, 아래 표 형식으로 한다. |

```markdown
| 구분 | 내용 |
|---|---|
| 시도한 것 | |
| 수정한 것 | |
| 변경된 것 | |
| 알아야 할 것 | |
| 질문 | (있을 때만) |
```

---

## 5. Agent·QA 구성

| 항목 | 규칙 |
|---|---|
| Agent 구성 | 역할별로 필요한 agent만 구성한다 (구현, 리뷰, QA). |
| QA 대상 | 동작 테스트, 데이터 QA(청킹·메타데이터·검색 정확도), UI QA(반응형) |
| QA 실행 시점 | 로컬 → PR → 일일 통합(18:00) → 릴리스(11/21·11/22 전체) 단계로 범위 확대. 같은 기능이 같은 원인으로 3회 실패하면 그 기능만 중단하고 보고 (`docs/06` 4장) |
| 기준 미달 처리 | QA agent는 직접 고치지 않고 기능 작성자(Claude)에게 `요청기록/`으로 수정을 요청 |
| 기준치 | `docs/02_mvp_dod_checklist.md` 4장 정량 합격 기준 |

---

## 6. 기술 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 언어 | **TypeScript** | 프론트·Backend·Agent·Lambda·Parser 모두 TS. 예외: PaddleOCR SageMaker 컨테이너(Python) |
| Agent SDK | Strands Agents (TypeScript SDK) | AgentCore Runtime에서 실행. TS SDK의 AgentCore·MCP 지원 범위는 M0에 확인 |
| 프론트엔드 | Next.js (TS) | 설계서 기준. CloudFront + WAF |
| Backend | Node.js (TS) on ECS Fargate | 설계서의 FastAPI를 대체. 프레임워크는 dhxorb96이 M0에 정해 `docs/interfaces.md`에 기록 |
| 인증 | Cognito + 역할 그룹 | 일반 사용자·작성자·규정 승인자·보안 검토자·운영 관리자 (데모 계정 포함) |
| 데이터 저장 | S3(quarantine/published/artifact/log), DynamoDB(문서 상태·Registry·승인·감사) | 설계서 2·10장 |
| 검색 | Bedrock KB + OpenSearch Serverless, Titan Text Embeddings V2, Cohere Rerank 3.5, Neptune | 설계서 8장 |
| 워크플로 | Step Functions | 업로드 → 검사 → OCR → Trust Gate → 승인 → 색인 |
| 모델 | Bedrock Claude Sonnet 5.5 / Haiku 5.5 / Opus 5.5 | Opus는 고위험 검토 에스컬레이션에만 사용 |
| 인프라 | AWS us-east-1 | 3-tier, 가용성·보안, NAT Gateway 1개, AgentCore, 혁신금융 원칙 준수 |
| IaC | Terraform | 최종 산출물은 `hanaeum-terraform/`. State는 S3 backend |
| UI 디자인 | 웹사이트 구축용 Claude skill 사용 | 반응형 필수, UI QA 필수. skill은 공식 출처 확인 후 사용 |
| 검색 품질 | 청킹·메타데이터 설계 | 데이터 QA 필수 |
| 관측 | Bedrock/AgentCore Observability | 질문별 응답·Tool 호출·Trace를 항상 확인 가능 |

---

## 7. 폴더 구조

```
5team/                        # = Git 저장소 루트
├── CLAUDE.md                 # 4장 규칙 (모든 Claude가 매 세션 읽음)
├── .env.local                # 개인 실행 환경 (EC2/로컬, 닉네임, AWS profile). Git 업로드 금지
├── scripts/setup-env.sh      # 실행 환경 판별·.env.local 생성
├── 공통문서/                  # 읽기 전용, Git 업로드 금지 (.gitignore)
│   ├── project_plan.md       # 본 문서 원본
│   └── *.pdf                 # 원본 PDF
├── docs/                     # Git 공유. PDF의 md 변환본 + 팀 합의 문서
│   ├── README.md
│   ├── 00_project_plan.md    # 본 문서 공유본
│   ├── 01_architecture_spec.md
│   ├── 02_mvp_dod_checklist.md
│   ├── 03_innovative_finance_principles.md
│   └── interfaces.md         # API·메타데이터·환경변수 합의
├── 자료/                     # 외부 자료 {용도}/{카테고리}/. 색인 README만 Git 공유
│   ├── 데이터원천/{법령,규정서식}/
│   ├── 규제참고/{금융규제,AI가이드라인}/
│   ├── 기술참고/{aws,sdk,ocr}/
│   └── 디자인참고/ui/
├── 공통기록/                  # 1건 1파일 (FIFO), archive/
├── 요청기록/                  # 팀원 간 수정 요청
├── 트러블슈팅.md
├── members/
│   ├── yoyo0704/   {TODO.md, plan.md, 기록.md}   # 김동연
│   ├── let522mj/   {TODO.md, plan.md, 기록.md}   # 김민정
│   └── dhxorb96/   {TODO.md, plan.md, 기록.md}   # 오태규
├── apps/ agents/ mcp/ packages/ services/ tests/   # 설계서 14장 Repo 구조
└── hanaeum-terraform/        # 최종 IaC
```

---

## 8. 인프라 운영

| 항목 | 규칙 |
|---|---|
| 실행 환경 | EC2: Instance Role 사용. 로컬: `.env.local`의 `AWS_PROFILE` 사용 (AWS CLI·Terraform provider·S3 backend 모두 이 환경변수를 따름). 판별·저장은 `scripts/setup-env.sh` |
| 자격증명 | Access Key를 파일·Git에 저장하지 않는다. Secret은 Secrets Manager 사용 |
| 테스트 | 각자 콘솔·CLI·Terraform으로 간단히 만들고 테스트할 수 있다. 사용 끝난 테스트 리소스는 삭제한다 |
| 최종 배포 | 김동연의 Claude만 `hanaeum-terraform/`으로 배포한다 |
| 네이밍 | 개인 테스트: `hanaeum-mvp-{리소스약어}-{용도}-{닉네임}` (예: `hanaeum-mvp-s3-quarantine-let522mj`) / 최종 배포: `hanaeum-mvp-{리소스약어}-{용도}` (닉네임 없음) |
| 태그 | 모든 리소스에 `Project=hanaeum-mvp`, `Owner={닉네임}` (최종 배포는 `Owner=team`) |
| Terraform State | S3 backend `hanaeum-mvp-s3-tfstate` (S3 이름은 전역 고유이므로 충돌 시 `-{계정ID}` 접미사), 버전관리·SSE 활성화, S3 native locking(`use_lockfile`). 개인 테스트는 key를 `{닉네임}/terraform.tfstate`로 분리, 최종은 `prod/terraform.tfstate` |

---

## 9. Git

| 항목 | 규칙 |
|---|---|
| 저장소 | https://github.com/vnfmsqkek3/live-wiki-agent.git (**public**. Secret·실데이터 업로드 금지) |
| 브랜치 | 팀원별 개인 브랜치 `{닉네임}`에서 작업 |
| main | PR + 리뷰 1명 + CI 통과 후 병합, 매일 18:00 통합 (`docs/06` 2·3장) |
| 제외 | `공통문서/`, `.env*`, `.omc/`, `*.tfstate`, `*.tfvars`(Secret 포함 시), `node_modules/` |

---

## 10. 테스트 데이터

| 항목 | 규칙 |
|---|---|
| 금지 | 실제 하나은행 내부 문서·고객정보 사용 금지 |
| 허용 | 공개 법령 등 공개 자료 |
| 직접 생성 | 정성적 자료, 테스트용 페이크 문서. 가상 **하나은행** 데이터(사용자 결정 11/16), 모든 합성 문서에 `SYNTHETIC — 하나은행 가상 데이터` 표시와 "실제 하나은행 자료가 아님" 명시 |
| 구성 | `docs/02_mvp_dod_checklist.md` 3장 (데모 핵심 10건, Golden Dataset 60건) |
| 확보 불가 시 | Websearch로 못 찾는 필수 자료는 사용자에게 PDF로 요청 |
