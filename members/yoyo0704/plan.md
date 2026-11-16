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

## 다음 (11/17~18)

- 모델 액세스 5.5 요청 결과 확인 → `models` 변수 교체
- Bedrock KB + OpenSearch Serverless + Custom Transformation Lambda 연결 (let522mj와 1건 색인)
- PaddleOCR 컨테이너·SageMaker Async 엔드포인트, MalwareCheck(GuardDuty Malware Protection for S3), PageRender, OcrIfNeeded
- ECS Fargate(API), CloudFront + WAF
