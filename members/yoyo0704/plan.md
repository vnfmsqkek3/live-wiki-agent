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
| 15 | PaddleOCR 컨테이너 + CodeBuild + SageMaker Async(0↔1) | 엔드포인트 InService | — | [~] g5 용량 부족 → g4dn 재시도 중 |
| 16 | PageRender, OcrIfNeeded Lambda | 한국어 PNG → result.json 텍스트·confidence·bbox | — | [~] 단위 테스트 통과, `smoke-ocr.sh` 대기 |
| 18 | 팀 Lambda 연결 (dev: Owner 개인 Lambda, type-detection 공유+SQS), chunker, CORS | 실제 업로드 → WaitForApproval 도달 | dhxorb96·let522mj Lambda | [x] `smoke-pipeline.sh` PASS. 승인 이후는 승인 API 필요 (직접 APPROVE 시 Promote ApprovalBindingError = 정상) |
| 17 | ECS Fargate(API), CloudFront + WAF | | dhxorb96 `apps/api`·`apps/web` (PR #2) | [ ] PR #2 머지 후 |

## 긴급 (11/16 20:07, dhxorb96_to_team): SFN → AgentCore 오케스트레이션

| No | yoyo0704 몫 | 상태 |
|---|---|---|
| ① | 파이프라인 Gateway(AWS_IAM) + 단계 Lambda 14개 Target | [x] READY, tools/list·tools/call 검증 |
| ② | 오케스트레이터 Runtime 리소스·Role·ECR | [~] Role·ECR 완료. Runtime 은 dhxorb96 이미지 push 후 `pipeline_runtime_image` 지정 |
| ③ | type-detection `InvokeAgentRuntime` 권한 | [x] (env `PIPELINE_RUNTIME_ARN` 채우면 전환) |
| ④ | 전환 확인 후 SFN·`workflows/asl` 폐기, `interfaces.md` 6장 개정 | [ ] 6.1 추가함. 폐기는 전환 E2E 후 |
| ⑤ | 파이프라인 Gateway 는 오케스트레이터 Role 만 | [x] IAM(InvokeGateway). AgentCore Policy 엔진은 P1 |

## 다음 (세션 이어받기용, 11/16 20:15 기준)

| 순서 | 작업 | 상태·메모 |
|---|---|---|
| 1 | OCR GPU 미인식 해결 (드라이버 550 AMI 후에도 CPU 전환. 다음: 컨테이너 시작 시 nvidia-smi·paddle.device.cuda.device_count 로그 → paddle 3.4.0 cu129 검토) | 진행 중. 실패 시 `aws sagemaker describe-endpoint --endpoint-name hanaeum-mvp-sm-ocr-dev`의 FailureReason 확인 → Failed 엔드포인트는 state 밖에 남으므로 delete 후 재apply |
| 2 | `workflows/scripts/smoke-ocr.sh dev` (paddle 3.3.1 기준선) | 한국어 PNG → result.json 텍스트·confidence·bbox |
| 3 | paddle 업그레이드: `paddlepaddle-gpu==3.4.0` (cu129 인덱스) + `paddlex==3.7.2` 고정 → 재빌드 → smoke-ocr 재검증 → `interfaces.md` 8장 갱신 | 사용자 승인됨(A안). cu130은 드라이버 580+ 필요라 제외 |
| 4 | 브랜치 → main PR (smoke-pipeline.sh, OCR g4dn, 3.4.0) | PR #1 squash 머지됨. 리뷰는 요청기록으로 dhxorb96 에게 |
| 5 | E2E 승인 이후 구간 (Promote → KbIngest → Finalize → 검색) | let522mj kb_ingest 재배포(DS ID 변경) + dhxorb96 승인 API 필요. 회신 확인 |
| 6 | 11/19: AgentCore Gateway(search·regulation·privacy·approval Target + interceptor), Runtime(customJWTAuthorizer), Guardrails, Observability | 요청 1730 4·5, 1809 추가, 1830 2 |
| 7 | ECS Fargate(API)·CloudFront+WAF | PR #2 머지 후. CloudFront 도메인 → `web_origins` 추가 |

규칙: main 올리기 전 `git fetch` → 새 커밋·`요청기록/*to_yoyo0704*` 확인·회신. 기록 파일은 main 직접, 코드는 브랜치+PR. 작업마다 `docs/02` DoD 대비 체크.
smoke: `workflows/scripts/smoke-dev.sh`(배선·GuardDuty, stub 기준이라 현재 팀 Lambda 연결 후엔 smoke-pipeline 사용), `smoke-pipeline.sh`(실제 업로드→승인 대기), `hanaeum-terraform/scripts/kb-smoke.sh`, `smoke-ocr.sh`.
