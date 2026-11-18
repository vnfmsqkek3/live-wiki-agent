# Living Wiki · 하나이음(hanaeum) 5팀

금융기관 AI 지식 거버넌스 플랫폼. 하나은행 경진대회 5팀 MVP.
직원이 올린 규정·매뉴얼·노하우 문서를 AI가 검사하고, 사람이 승인한 문서만 위키에 게시·검색·답변에 쓴다.

> 모든 데이터는 가상 하나은행 합성 데이터다. 실제 은행 문서·고객정보는 쓰지 않는다.

## 무엇을 하는가

| 기능 | 내용 |
|---|---|
| 문서 접수·자동 분석 | 업로드 → 형식 판별 → 개인정보(PII)·프롬프트 인젝션 검사 → OCR(인식률 95% 미만 쪽만 Vision 보정) → 구조화·분류 |
| 신뢰 검사(Trust Gate) | 규정 근거와 충돌·개정 전 인용을 찾아 승인자에게 표시 |
| 사람 승인 | 승인은 사람만. 문서 버전·해시에 묶어 1회만 사용 |
| 게시·검색 | 승인 문서만 Bedrock Knowledge Base에 색인, 위키 검색·출처 인용 |
| 영향 분석 | Neptune 그래프로 규정 개정 시 영향받는 노하우를 "재검토 필요"로 표시 |
| 가이드 Agent·MCP | AgentCore Runtime 가이드 Agent, AgentCore Gateway로 외부 MCP Tool 제공(검색·규정·그래프) |

- 모델에는 마스킹된 텍스트만 보낸다.
- 아키텍처 그림: [`hanaeum-terraform/docs/prod-architecture.png`](hanaeum-terraform/docs/prod-architecture.png) (편집용 `.drawio`)

## 저장소 구조

| 경로 | 내용 |
|---|---|
| `apps/web`, `apps/api` | 웹 화면(Next.js), Backend API (ECS Fargate + CloudFront) |
| `workflows` | 문서 처리 단계 Lambda (Step Functions·오케스트레이터에서 호출) |
| `agents` | 파이프라인 오케스트레이터·가이드 Agent (AgentCore Runtime 이미지) |
| `mcp` | MCP 서버(검색·규정·그래프·승인·개인정보)와 Gateway Interceptor |
| `services` | OCR(PaddleOCR SageMaker), PDF 변환, KB 청커, 법령 ETL, 인증 트리거 |
| `packages` | 공유 스키마, PII 마스킹, 법령 파서, DB, MCP 공통 |
| `hanaeum-terraform` | 전체 AWS 인프라(IaC) |
| `docs` | 설계·완료 기준·계약 문서. 시작은 `docs/README.md` |

## 배포 (Terraform)

환경은 prod 하나뿐이다 (`hanaeum-terraform/envs/prod`, us-east-1). 빌드도 Terraform이 한다.
Lambda·OCR·웹·API·Agent 이미지는 `terraform apply` 중 CodeBuild가 이 공개 저장소의 지정 커밋으로 빌드한다. 로컬 빌드·업로드는 하지 않는다.

### 1. 준비

| 항목 | 내용 |
|---|---|
| 도구 | Terraform ≥ 1.14, AWS CLI v2, Node.js 24, git. 확인: `scripts/preflight.sh` |
| AWS 자격 | 대상 계정에 관리자 권한 profile 로그인 |
| `.env.local` | `scripts/setup-env.sh {닉네임} {AWS_PROFILE}` 로 생성 (git 제외) |
| 데모 비밀번호 | `.env.local` 에 `TF_VAR_demo_password=...` 추가. 데모 계정(admin 등) 공통 비밀번호. 코드·git 에 쓰지 않는다 |

```bash
set -a; . ./.env.local; set +a
aws sts get-caller-identity --query Account --output text   # HANAEUM_ACCOUNT_ID 와 같은지 확인
```

### 2. State 버킷 (계정당 최초 1회)

```bash
hanaeum-terraform/bootstrap/tfstate.sh    # s3://hanaeum-mvp-s3-tfstate 생성, 재실행 안전
```

### 3. 배포

```bash
terraform -chdir=hanaeum-terraform/envs/prod init
terraform -chdir=hanaeum-terraform/envs/prod apply
terraform -chdir=hanaeum-terraform/envs/prod output web_url   # 접속 주소 (CloudFront)
```

- 빈 계정 기준 약 450개 리소스, CodeBuild 빌드 포함 수십 분 걸린다.
- DB 마이그레이션, AgentCore Gateway 스키마 재동기화도 apply 안에서 실행된다.
- 데모 계정 정보는 Secrets Manager `hanaeum-mvp/demo-users`, 외부 MCP 클라이언트는 `hanaeum-mvp/mcp-external-client`.

### 4. 배포 확인

```bash
hanaeum-terraform/scripts/prod-infra-check.sh   # I1~I7: OCR 1/1, 외부 MCP 토큰·도구·승인 차단, DB 마이그레이션, Finalize 설정, API S3 권한
```

화면·업무 흐름 시험 항목은 `members/dhxorb96/qa/20261118_prod시험_체크리스트.md`.

### 코드 변경 반영

`envs/prod/main.tf` 의 빌드 커밋을 원격에 push 된 커밋으로 바꾸고 `apply` 한다.

| 변수 | 대상 |
|---|---|
| `lambda_refs` | 팀원별(yoyo0704·dhxorb96·let522mj) 단계 Lambda |
| `webapp_source_ref` | 웹·API (ECS) |
| `agents_source_ref` | 오케스트레이터·가이드 Agent |
| `ocr_source_ref` | OCR SageMaker 컨테이너 |

### 삭제 후 재배포

```bash
terraform -chdir=hanaeum-terraform/envs/prod destroy
aws secretsmanager delete-secret --secret-id hanaeum-mvp/aurora-app --force-delete-without-recovery   # 남아 있을 때만
terraform -chdir=hanaeum-terraform/envs/prod apply
```

- 지금은 시험 단계라 `protect_data = false` 다. 데이터(S3·DynamoDB·Aurora·Neptune)가 모두 지워지고 CloudFront 주소·Cognito 클라이언트가 바뀐다.
- `protect_data = true` 면 삭제 보호가 걸려 destroy 가 멈춘다. 실서비스 전에는 `true` 로 되돌린다.
- Aurora 비밀은 삭제 후 복구 대기 기간이 있어 같은 이름으로 다시 만들 수 없다. 그래서 재배포 전에 즉시 삭제한다.

## 팀

| 이름 | 닉네임 | 담당 |
|---|---|---|
| 김동연 | yoyo0704 | 인프라·IaC·배포·관측 |
| 김민정 | let522mj | 데이터·검색 |
| 오태규 | dhxorb96 | Agent·앱 |

개발 참여: 저장소를 받고 `claude` 실행 후 닉네임을 입력하면 환경 설정 → 브랜치 → 계획 → 구현 순으로 진행한다 (`CLAUDE.md`). 완료 기준은 `docs/02_mvp_dod_checklist.md`.
