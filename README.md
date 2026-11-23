# Living Wiki · 하나이음(hanaeum) 5팀

금융기관용 AI 지식 거버넌스 플랫폼입니다. 하나은행 경진대회 5팀 MVP입니다.
직원이 올린 규정·매뉴얼·노하우 문서를 AI가 검사하고, 사람이 승인한 문서만 위키에 게시해 검색과 답변에 씁니다.

> 모든 데이터는 가상 하나은행 합성 데이터(SYNTHETIC)입니다. 실제 하나은행 문서와 고객정보는 쓰지 않습니다.

## 1. 무엇을 하는가

| 기능 | 내용 |
|---|---|
| 문서 접수·자동 분석 | 업로드 → 형식 판별 → 악성 검사 → PDF 변환 → OCR(PaddleOCR) → 개인정보(PII) 가림 → 프롬프트 인젝션(Prompt Injection) 검사 → 분류 |
| 신뢰 검사(Trust Gate) | 등록 규정(Registry)과 해시·버전을 대조해 위조본을 막고, 규정과 어긋난 노하우와 개정 전 조문 인용을 찾아 결재자에게 보여 줍니다 |
| 사람 승인 | 게시는 사람만 승인합니다. 승인은 문서 버전·해시에 묶여 1회만 쓸 수 있습니다 |
| 게시·검색 | 승인 문서만 Bedrock Knowledge Base에 색인합니다. 검색은 정확한 조문, 시행 버전, 출처를 함께 보여 줍니다 |
| 변경 영향(Change Impact) | 규정이 개정되면 Neptune 그래프로 영향받는 노하우를 찾아 '재검토 필요'와 수정 초안을 만듭니다. 시행 예정 개정은 시행일부터 반영할 수 있습니다 |
| 외부 법령 대조 | 문서가 인용한 법령 조문을 국가법령정보센터 원문과 대조해 다른 내용을 알려 줍니다 |
| 업무 가이드 Agent | AgentCore Runtime의 가이드 Agent가 승인된 규정만 근거로 답하고, 근거가 없으면 '확인 필요'로 답합니다 |
| 외부 MCP 연결 | AgentCore Gateway로 검색·규정·그래프 도구를 읽기 전용 MCP로 제공합니다 (`docs/외부-MCP-연결.md`) |

- 모델에는 개인정보를 가린 텍스트만 보냅니다. 사용자 질의와 도구 인자도 모델 호출 전에 검사합니다.
- Agent는 Knowledge Base를 직접 부르지 않고 Gateway 도구로만 접근합니다. 도구는 DynamoDB의 현재 상태로 다시 확인합니다.
- 아키텍처 그림: [`hanaeum-terraform/docs/prod-architecture.png`](hanaeum-terraform/docs/prod-architecture.png) (편집용 `.drawio`)

## 2. 계정과 권한

데모 계정은 두 개뿐입니다. 비밀번호는 Secrets Manager `hanaeum-mvp/demo-users`에 있고 저장소에는 두지 않습니다.

| 할 수 있는 일 | `user` (작성자) | `admin` (결재자) |
|---|---|---|
| 문서 업로드, 검색, 가이드 질문, 별점 | O | O |
| 다른 문서에 [수정 요청] | O | O |
| 게시 전 본인 문서 고치기·삭제 | O | O |
| 게시 문서를 위키에서 고치기(새 버전 초안) | X | O |
| 게시 문서 삭제 | X | O |
| 결재(승인·반려), 결재함 | X | O (본인 문서 승인 허용) |

권한은 화면과 API 양쪽에서 확인합니다. `user`가 API를 직접 호출해도 403이 납니다.

## 3. 저장소 구조

| 경로 | 내용 |
|---|---|
| `apps/web`, `apps/api` | 웹 화면(Next.js), Backend API. ECS Fargate + CloudFront |
| `workflows` | 문서 처리 단계 Lambda |
| `agents` | 파이프라인 오케스트레이터, 업무 가이드 Agent (AgentCore Runtime 이미지) |
| `mcp` | MCP 서버(검색·규정·그래프·승인·개인정보)와 Gateway Interceptor |
| `services` | OCR(PaddleOCR SageMaker, Python), PDF 변환, KB 청커, 법령 ETL, 인증 트리거 |
| `packages` | 공유 스키마(계약 원본), PII 마스킹, 법령 파서, DB, MCP 공통 |
| `hanaeum-terraform` | 전체 AWS 인프라(IaC). 환경은 prod 하나입니다 |
| `tests` | 합성 문서(fixtures), 평가 질의, E2E·보안 시험 |
| `docs` | 설계·완료 기준·계약 문서. 시작은 `docs/README.md` |
| `role` | 팀별 역할, 소유 경로, 협업 규칙 |

## 4. 완료 기준과 측정 결과

완료 판정은 `docs/02_mvp_dod_checklist.md`의 DoD·정량 기준으로만 합니다. 아래는 prod에서 합성 테스트 세트로 잰 값입니다(같은 문서 4장).

| 항목 | 목표 | 결과 |
|---|---|---|
| 정상 문서 등록 | 5건 모두 승인 가능 | 5/5 |
| 위조 규정 차단 | 5건 모두 게시 차단 | 5/5 |
| Prompt Injection | 5건 모두 KB 유입 차단 | 5/5, 유입 0 |
| 노하우 충돌 | 5건 중 4건 이상 탐지 | 5/5 |
| 법령 구조 파싱 | 95% 이상 | 100% (305/305) |
| 정확 조문 검색 | 20건 중 19건 이상 | 20/20 |
| 삭제 조항 오인용 | 0건 | 0건 |
| 변경 영향 탐지 | 지정 문서 모두 탐지 | 5/5 (오프라인) · 3/3 (prod 그래프), 오탐 0 |
| 비인가 게시 | 5건 모두 거부 | 5/5, 403 + 감사 기록 |
| 근거 인용 | 20건 중 19건 이상 | 19/20 |
| 검색 실패 판정 | '확인 필요'를 부재로 단정 0건 | 0건 |

지정 샘플 통과가 알려지지 않은 공격까지 100% 막는다는 뜻은 아닙니다.

## 5. 배포 (Terraform)

환경은 prod 하나뿐입니다 (`hanaeum-terraform/envs/prod`, us-east-1). 배포는 인프라팀만 합니다.
Lambda·OCR·웹·API·Agent 이미지는 `terraform apply` 중 CodeBuild가 이 공개 저장소의 지정 커밋으로 빌드합니다. 로컬 빌드·업로드는 하지 않습니다.

### 준비

| 항목 | 내용 |
|---|---|
| 도구 | Terraform ≥ 1.14, AWS CLI v2, Node.js 24, git. 확인: `scripts/preflight.sh` |
| AWS 자격 | 대상 계정 관리자 권한 profile |
| `.env.local` | `scripts/setup-env.sh {팀 slug} {AWS_PROFILE}`로 생성 (git 제외) |
| 데모 비밀번호 | `.env.local`에 `TF_VAR_demo_password=...`. 코드와 git에 쓰지 않습니다 |

```bash
set -a; . ./.env.local; set +a
aws sts get-caller-identity --query Account --output text   # HANAEUM_ACCOUNT_ID와 같은지 확인
hanaeum-terraform/bootstrap/tfstate.sh                       # State 버킷, 계정당 최초 1회
terraform -chdir=hanaeum-terraform/envs/prod init
terraform -chdir=hanaeum-terraform/envs/prod apply
terraform -chdir=hanaeum-terraform/envs/prod output web_url  # 접속 주소 (CloudFront)
DOC=<공개 게시 doc_id> hanaeum-terraform/scripts/prod-infra-check.sh   # I1~I8 배포 확인 (I8에 DOC 필요)
workflows/scripts/smoke-agentcore.sh prod                    # 문서 처리 smoke
```

- 빈 계정 기준 약 450개 리소스이고, CodeBuild 빌드를 포함해 수십 분 걸립니다.
- DB 마이그레이션과 AgentCore Gateway 스키마 재동기화도 apply 안에서 실행됩니다.
- 코드 변경 반영: `envs/prod/main.tf`의 빌드 커밋 변수(`lambda_refs`, `webapp_source_ref`, `agents_source_ref`, `ocr_source_ref`, 파이프라인 고정 시 `pipeline_runtime_image_tag`)를 push된 커밋으로 지정해 apply합니다.

### 삭제 후 재배포

```bash
terraform -chdir=hanaeum-terraform/envs/prod destroy
aws secretsmanager delete-secret --secret-id hanaeum-mvp/aurora-app --force-delete-without-recovery   # 남아 있을 때만
terraform -chdir=hanaeum-terraform/envs/prod apply
```

- 지금은 `protect_data = false`라 데이터(S3·DynamoDB·Aurora·Neptune)가 모두 지워지고 CloudFront 주소와 Cognito 클라이언트가 바뀝니다. 실서비스 전에는 `true`로 바꿉니다.
- Aurora 비밀은 삭제 후 복구 대기 기간이 있어 같은 이름으로 바로 다시 만들 수 없으므로, 재배포 전에 즉시 삭제합니다.

## 6. 팀과 개발 방식

11/20부터 역할별 9개 팀이 각각 Claude Code 에이전트 하나로 일하고, Orca로 요청·리뷰·병합을 주고받습니다.

| 팀 | 담당 |
|---|---|
| 총괄 | 범위·완료 판정, PR 병합, 배포 지시 |
| 인프라 | IaC, 최종 배포, 관측·평가 실행기 |
| 백엔드 | API, 승인·권한, Trust Gate |
| 프론트엔드 | 웹 화면 |
| AI엔지니어 | 파이프라인 오케스트레이터, 업무 가이드 Agent |
| 데이터엔지니어 | 합성 데이터, 법령 파서, 색인·검색, 그래프 |
| 프론트엔드QA · 데이터QA | 화면·데이터 품질 검증 (직접 고치지 않고 요청) |
| 엔드유저 | 실제 사용자 관점 점검 |

- 팀 목록, 소유 경로, 소통 규칙은 `role/README.md`, 팀별 책임은 `role/{팀명}.md`에 있습니다.
- 작업 규칙 요약은 `CLAUDE.md`, 개발·Git 규칙은 `docs/06_dev_workflow.md`, 계약은 `docs/interfaces.md`가 기준입니다.
- `main`은 PR + 리뷰 1팀 + CI(app·gitleaks·GitGuardian) 통과 후에만 병합합니다. 공개 저장소이므로 secret과 실데이터는 커밋하지 않습니다.
