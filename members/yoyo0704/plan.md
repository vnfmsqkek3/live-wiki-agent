# plan · yoyo0704 (인프라·플랫폼)

기준: `TODO.md`, 완료 판정은 `docs/02`. 상태: [ ] 대기 / [~] 진행 / [x] 완료.

## 11/16 · M0

| No | 작업 | 완료 조건 | 의존·mock | 상태 |
|---|---|---|---|---|
| 1 | `.env.local` 생성, 계정 확인 | 계정 566533524321, profile `czy1023-naver` | — | [x] |
| 2 | State 버킷 `hanaeum-mvp-s3-tfstate` | 버전관리·SSE-KMS·public block·TLS only, 재실행 시 동일 | — | [x] |
| 3 | Bedrock 모델 호출 확인 | 모델별 Converse/Embed/Rerank 실제 호출 결과 기록 | — | [x] Claude 5.5 미허용 (트러블슈팅) |
| 4 | SageMaker `ml.g5.xlarge` endpoint 쿼터 | ≥1 | — | [x] 2 |
| 5 | AgentCore Runtime·Gateway·Policy·Evaluations 가용성 | us-east-1 control plane list 성공 | — | [x] |
| 6 | repo 골격 (root package.json, tsconfig.base.json, CI 4종, .env.example) | `npm run lint/typecheck/test` 통과 | — | [x] `workflows/`를 첫 workspace로 |
| 7 | 버전 고정표 (`interfaces.md` 8장) | Node·Terraform·provider·PaddleOCR·모델 ID 기입 | — | [x] |

## 11/17

| No | 작업 | 완료 조건 | 의존·mock | 상태 |
|---|---|---|---|---|
| 8 | Terraform 모듈·env 구조 | `terraform validate` 통과, `fmt -check` 통과 | — | [x] network·kms·s3·ddb·cognito·sfn. 나머지 모듈은 해당 날짜에 |
| 9 | 공유 dev 배포: network·kms·s3·ddb·cognito | apply 성공, S3 4종·DDB 7종(+workflows)·Cognito 그룹 5종 존재 | — | [x] 124 리소스 |
| 10 | SFN 골격 + EventBridge + SQS(DLQ) + failure-catcher | 테스트 실행 1건이 HandleError/failure-catcher까지 기록 | 단계 Lambda는 stub | [x] smoke 4건 PASS |
| 11 | SSM `/hanaeum-mvp/{env}/*` 출력 | `interfaces.md` 4장 이름 전부 SSM에 존재 | — | [~] KB·Guardrail·Neptune·OCR 값은 해당 리소스 생성 시 |

## 남은 결정·위험

- Claude 5.5 미허용: 4.x 대체 ID로 진행. 계정 모델 액세스 요청 필요 (사용자).
- 로컬 Terraform 1.14.9 / 최신 1.17.2. `required_version >= 1.14`로 두고 고정표엔 최신을 권장값으로 기록.

## 11/18 (11/16 선행)

| No | 작업 | 완료 조건 | 의존·mock | 상태 |
|---|---|---|---|---|
| 12 | Bedrock KB + AOSS(dev standby off) + 데이터 소스 2개 | 1건 색인 → HYBRID Retrieve + Rerank + ACL 필터 | Chunker Lambda(let522mj) 없음 → NONE 청킹 | [x] `kb-smoke.sh` ALL PASS |
| 13 | Cognito Pre Token V2 (`dept` claim) | access token에 dept·groups | dhxorb96 요청 3 | [x] |
| 14 | MalwareCheck (GuardDuty Malware Protection for S3) | 정상 OK, EICAR BLOCKED·승인 건너뜀 | — | [x] `smoke-dev.sh` ALL PASS |
| 15 | PaddleOCR 컨테이너 + CodeBuild + SageMaker Async(0↔1) | 엔드포인트 InService | — | [~] |
| 16 | PageRender, OcrIfNeeded Lambda | 한국어 PNG → result.json 텍스트·confidence·bbox | — | [~] 단위 테스트 통과, `smoke-ocr.sh` 대기 |
| 17 | ECS Fargate(API), CloudFront + WAF | | dhxorb96 `apps/api`·`apps/web` (PR #2) | [ ] PR #2 머지 후 |

## 다음

- 11/19: AgentCore Gateway(interceptor 연결)·Runtime(customJWTAuthorizer) — dhxorb96 요청 4·5, Guardrails 리소스, Observability
- ECS Fargate·CloudFront·WAF (PR #2 머지 후)
- Claude 5.5 권한 열리면 `models` 변수 교체
