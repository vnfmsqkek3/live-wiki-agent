# TODO · 김동연 (yoyo0704) · 인프라·플랫폼

필수 문서: `docs/05`, `docs/06`, `docs/interfaces.md` 3·4·6·8장. 참조: `docs/01` 2·11·12·14장, `docs/04` 1·2·4.1·4.2·7·8장, `docs/03` 5장.
소유 경로: `hanaeum-terraform/`, `services/ocr/`, `workflows/`, root 설정·`.github/workflows/`, `mcp/observability-server/`, `tests/evaluations/runner/`, `observability/`.

## 11/16 · M0
- [x] `scripts/setup-env.sh yoyo0704`, 계정 ID 확인
- [x] Terraform State 버킷 `hanaeum-mvp-s3-tfstate` (버전관리·SSE·`use_lockfile`, 충돌 시 `-{계정ID}`)
- [x] Bedrock 모델 액세스·inference profile ID 확인 (Claude Sonnet/Haiku/Opus 5.5, Titan V2, Cohere Rerank 3.5) → `interfaces.md` 8장
- [x] SageMaker `ml.g5.xlarge` 쿼터 확인 (부족하면 즉시 증설 요청, 대안 CPU OCR Lambda — `docs/04` 2장)
- [x] AgentCore Policy·Evaluations us-east-1 가용성 확인
- [x] repo 골격: root `package.json`(npm workspaces), `tsconfig.base.json`, `.github/workflows/` 4종(`docs/06` 3장), `.env.example` — main에 초기 커밋
- [x] 버전 고정표 기입 (Node LTS, Terraform·provider, PaddleOCR)

## 11/17
- [ ] 모듈 구조 `hanaeum-terraform/modules/{network,iam,kms,s3,ddb,sfn,cognito,api,kb,opensearch,graph,ocr,agentcore,guardrails,observability}` + `envs/{dev-*,prod}`
- [ ] **공유 dev 환경 배포**: VPC 3-tier(Multi-AZ, NAT 1개, VPC Endpoint 우선), S3 4종(`interfaces.md` 3장, 원본 등급 prefix는 모델 Role Deny), KMS, DynamoDB(Documents, Regulations, Findings, Approvals, Feedback, AuditEvents), Cognito 역할 그룹 5종 + 데모 계정
- [ ] Step Functions 골격 + EventBridge + SQS(전부 DLQ) + 공통 Catch·failure-catcher (`docs/04` 1.1·1.2)
- [ ] 환경변수 → SSM `/hanaeum-mvp/{env}/*` 출력

## 11/18
- [ ] Bedrock KB 1개·벡터 인덱스 1개(OpenSearch Serverless, HYBRID용 필드 매핑), 데이터 소스 2개(published `legal/`, `knowledge/`), Custom Transformation Lambda 연결 — let522mj와 1건 색인→Retrieve 확인
- [ ] PaddleOCR 컨테이너(Python) 빌드·SageMaker Async 엔드포인트, scale-to-zero, 출력 스키마 `docs/04` 2.1 (confidence 보존)
- [ ] 단계 1 MalwareCheck(GuardDuty Malware Protection for S3), 3b PageRender, 4 OcrIfNeeded
- [ ] ECS Fargate(API), CloudFront + WAF(웹)

## 11/19
- [ ] Guardrails 리소스 (정책 내용은 dhxorb96)
- [ ] AgentCore Runtime·Gateway(Lambda Target 등록) 리소스, arm64 이미지 빌드 파이프라인
- [ ] Observability: CloudWatch/OTel, trace_id ↔ DynamoDB 워크플로 단계 연결, 로그 필드 allowlist·보관기간
- [ ] 서비스 Agent 외부 접근 차단(MVP는 외부 웹 접근 없음) 확인

## 11/20
- [ ] Neptune Serverless (IAM 인증)
- [ ] 평가 실행기: Golden 질의 실행 → Trace 수집 → 정답 대조 → 결과표 (`docs/05` 5장)
- [ ] `mcp/observability-server` (`get_agent_trace`, `get_usage`)

## 11/21
- [ ] P0 자동 평가 전체 실행·집계
- [ ] (P0 통과 후) AgentCore Identity·Policy: `publish_wiki_probe` Deny, AgentCore Evaluations 연결
- [ ] `docs/03` 5장 인프라 체크리스트 확인

## 11/22
- [ ] prod 환경 배포 리허설 (닉네임 없는 이름, `Owner=team`), 전체 회귀 결과표

## 11/23 · M3
- [ ] prod 최종 배포·smoke, 개인 dev 리소스 정리
