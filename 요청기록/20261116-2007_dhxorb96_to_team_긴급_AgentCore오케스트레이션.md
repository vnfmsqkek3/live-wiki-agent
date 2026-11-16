# 🚨 긴급 · dhxorb96 → yoyo0704, let522mj : 문서 처리 오케스트레이션을 AgentCore로 전환

| 항목 | 내용 |
|---|---|
| 상태 | DONE (공유 dev AgentCore 전환·검증 완료 21:01. 남은 것: SFN 리소스 폐기(yoyo0704), Runtime OTel 계측(dhxorb96)) |
| 결정 | **문서 처리 파이프라인 오케스트레이션을 Step Functions → Amazon Bedrock AgentCore로 전환한다** (필수 요건). Strands Agents(TS) Graph 오케스트레이터를 AgentCore Runtime에서 실행하고, 각 단계는 AgentCore Gateway Tool로 호출한다. 전환 후 SFN은 폐기 |
| 기준 미달 근거 | 사용자 요구: "Step Functions에 Lambda가 아니라 AgentCore 기능으로 오케스트레이션해야 한다" |
| 처리 결과 | **전환 검증 (dhxorb96, 21:01)**: demo-author가 K-001 PDF 업로드(`doc_01M7J3JDCF85X2T0AENC1F14K8`) → type-detection-dev → `hanaeum_mvp_rt_pipeline_dev` 11단계 → IN_REVIEW · 게시 요청 → demo-approver 승인 → `workflow_resumed=true` → Promote·KbIngest·GraphUpsert·Finalize → **PUBLISHED**, EXECUTION SUCCEEDED, 승인 USED. 게시 전 일반 사용자 404 → 게시 후 200. 이 workflow의 SFN 실행 없음(ExecutionDoesNotExist). 검증 도구 `node agents/scripts/pipeline.ts start\|resume\|status <doc_id>`<br>**dhxorb96 몫 (20:40)**: ① 오케스트레이터 완료 — Strands Graph(고정 순서·병렬 합류·PENDING 폴링·BLOCKED 통과·실패 기록), `agents/src/pipeline/`, 이미지 `hanaeum-mvp-ecr-pipeline-dev:d0eeeae`·`latest` **push 완료** (`agents/Dockerfile.pipeline`, CMD `node src/pipeline/runtime.ts`, env `AWS_REGION`·`PIPELINE_GATEWAY_URL`·`TABLE_WORKFLOWS`). 오케스트레이터는 **모델 호출 없음**. 개인 dev 검증: 로컬 오케스트레이터+Gateway로 실문서 검사→IN_REVIEW→승인 resume→Promote·KbIngest·GraphUpsert·Finalize **PUBLISHED**, 배포 Runtime(IAM)으로 손상 PDF 병렬 단계 실패 기록 확인 ② 승인 API resume·type-detection·analyze가 `PIPELINE_RUNTIME_ARN`이면 `InvokeAgentRuntime` ③ 필요: **yoyo0704** Runtime 생성 + `await-review` Target 추가(PR #5 코멘트), Runtime Role에 Workflows 테이블 KMS(`kms:Decrypt`·`GenerateDataKey`) 필요(개인 dev에서 누락으로 실패했음)<br>**let522mj 몫 ①②③ 확인 완료 (20:16)**. ① 단계 Lambda 4개(text_layer_extract·segment_build·promote·kb_ingest)는 공통 입력 6필드만 쓰고 `__actor`·`task_token`·`outcome` 등 추가 필드는 버림(zod strip, 테스트 추가). 공유 dev에서 `__actor`·`outcome`을 넣어 재호출해도 정상. ② 멱등 실측: promote 같은 workflow 재호출 → 같은 게시본 해시로 OK, kb_ingest PENDING×4 → OK, 이후 재호출해도 새 Job 없이 OK. clientToken은 sha256(workflow/doc/version)이라 같은 입력이면 같은 Job. ③ 변경 없음: Promote는 approval_id 없이 `APR_STATUS#APPROVED`에서 doc·version으로 찾음 → resume 경로에서 그대로 동작. 주의: 이제 승인 소비(USED)는 게시 검증 통과 후에만 일어남(PR #4). 이의 없음<br>**yoyo0704 몫 (20:50)**: ① Gateway `hanaeum-mvp-gw-pipeline-dev` READY (AWS_IAM, SigV4 service `bedrock-agentcore`), Target 14개 READY. **Tool 이름 = `{target}___{단계키}`** (Target 이름은 밑줄 불가 → 예 `malware-check___malware_check`, `kb-ingest___kb_ingest`). URL: SSM `/hanaeum-mvp/dev/PIPELINE_GATEWAY_URL`. `tools/list` 200, `tools/call` → Lambda 실행 확인. `exception_level=DEBUG`라 단계 예외는 `isError:true` + `{errorType, errorMessage}`로 옴<br>② 오케스트레이터 Role `hanaeum-mvp-role-rt-pipeline-dev`(InvokeGateway·Documents·Workflows RW, model-caller 태그), ECR SSM `PIPELINE_ECR_REPO`. **Runtime 이름은 `hanaeum_mvp_rt_pipeline_dev`(하이픈 불가)**. 이미지(linux/arm64) push 해 주면 `pipeline_runtime_image`로 Runtime 생성 → SSM `PIPELINE_RUNTIME_ARN` 채움. 모델 호출이 필요하면 알려 달라(현재 권한 없음)<br>③ type-detection Role 에 `InvokeAgentRuntime` 추가, env `PIPELINE_RUNTIME_ARN`은 Runtime 생성 전 빈 값 → SFN 경로 유지(전환 전 테스트 보호)<br>⑤ 파이프라인 Gateway 호출 권한은 IAM 으로 오케스트레이터 Role 만. AgentCore Policy 엔진 연결은 P1<br>④ SFN 폐기는 전환 E2E 확인 후. 계약은 `interfaces.md` 6.1 (PR #5)<br>**yoyo0704 (21:05) 공유 dev 전환 완료**: Runtime `hanaeum_mvp_rt_pipeline_dev` READY (이미지 d0eeeae, IAM, env AWS_REGION·PIPELINE_GATEWAY_URL·TABLE_WORKFLOWS·TABLE_DOCUMENTS), Role 에 팀 CMK 권한 있음, Target `await-review___await_review`, SSM `PIPELINE_RUNTIME_ARN` 채움 → type-detection-dev 가 InvokeAgentRuntime. Observability: Gateway·Runtime 로그 `/aws/vendedlogs/bedrock-agentcore/hanaeum-mvp-pipeline-dev`, TRACES → X-Ray, 계정 Transaction Search ACTIVE (aws/spans 는 아직 0건 → Runtime 컨테이너 OTel 계측 확인 필요). 검증 `smoke-agentcore.sh dev`: 업로드 → Runtime → Tool 11개 → IN_REVIEW, SFN 실행 0건. 승인 resume → PUBLISHED 확인되면 SFN·`workflows/asl` 폐기 (PR #7) |

## 구조 (v1 계약 제안 — 이견 있으면 이 파일에 바로 적어 달라)

| 구성 | AgentCore 기능 | 내용 | Owner |
|---|---|---|---|
| 오케스트레이터 `hanaeum-mvp-rt-pipeline` | **Runtime** (IAM 인증) | Strands **Graph**, 단계 순서 고정(LLM이 순서를 정하지 않음 → 반복 가능). 상태는 DynamoDB(Documents·WORKFLOWS), 세션에 저장하지 않음 | dhxorb96 |
| 단계 Tool | **Gateway** `hanaeum-mvp-gw-pipeline` (inbound **AWS_IAM**, 시스템 전용) | **기존 단계 Lambda를 그대로 Lambda Target으로 등록**. 입력=`interfaces.md` 6장 공통 입력, 출력=`{status, output_key?, findings?}` 그대로. Tool 이름 = 단계 키(`malware_check`, `file_structure_check`, `text_layer_extract`, `page_render`, `ocr_if_needed`, `segment_build`, `pii_scan`, `injection_scan`, `classify`, `trust_gate`, `promote`, `kb_ingest`, `graph_upsert`, `finalize`) | yoyo0704 (Gateway·Target), 각 Lambda Owner |
| 권한 | **Policy** | 오케스트레이터는 위 단계 Tool만. 승인·게시 Tool 없음 | yoyo0704 |
| 추적 | **Observability** | Runtime·Gateway Trace + 단계 기록(`WF#{workflow_id}/STEP#{단계}` 현 스키마 유지, 오케스트레이터가 기록) | yoyo0704 수집 · dhxorb96 기록 |
| 사용자 Agent | Runtime(JWT) + Gateway(JWT) | 기존 그대로 (검색·가이드, approval·privacy·search·regulation·graph Tool) | — |

## 실행 규칙

1. **시작**: type-detection Lambda가 `StartExecution` 대신 `InvokeAgentRuntime`(오케스트레이터, `{action:"start", workflow_id, doc_id}`) 호출 — dhxorb96
2. **PENDING**: 폴링 단계(`malware_check`·`ocr_if_needed`·`kb_ingest`)는 지금과 같이 `status:"PENDING"` 반환 → 오케스트레이터가 15초 후 같은 입력으로 재호출. **멱등 필수**
3. **BLOCKED**: 이후 단계 건너뛰고 `finalize`(`outcome:"BLOCKED"`)
4. **사람 승인 대기**: `wait_for_approval`·task token **폐기**. 오케스트레이터는 Trust Gate 후 Documents `lifecycle=IN_REVIEW`로 두고 종료(세션 8시간 한도 때문에 대기하지 않음). 승인 API가 결정 시 `InvokeAgentRuntime({action:"resume", workflow_id, decision})` → APPROVE면 `promote → kb_ingest → graph_upsert → finalize(PUBLISHED)`, 아니면 `finalize(REJECTED)` — dhxorb96
5. 실패: 단계 예외 → `STEP#…` FAILED 기록 + `EXECUTION` FAILED (현 failure-catcher와 같은 스키마)

## 각자 할 일 (오늘~11/17 오전)

| 담당 | 작업 |
|---|---|
| **yoyo0704** | ① 시스템용 Gateway `hanaeum-mvp-gw-pipeline`(AWS_IAM inbound) + 단계 Lambda 14개 Target 등록(Tool 스키마: 공통 입력 6필드 + `task_token`·`outcome` 선택) ② 오케스트레이터 Runtime(IAM 인증, ECR 이미지 `agents/Dockerfile` 계열) 리소스·Role(Gateway invoke, DynamoDB Documents·WORKFLOWS) ③ type-detection Role에 `bedrock-agentcore:InvokeAgentRuntime` ④ 전환 확인 후 SFN·`workflows/asl` 폐기, `interfaces.md` 6장 개정 ⑤ Policy: 파이프라인 Gateway는 오케스트레이터 Role만 |
| **let522mj** | ① 단계 Lambda가 Gateway Target으로 호출될 때 이벤트에 `__actor` 등 **추가 필드가 있어도 무시**하는지 확인 ② `kb_ingest` PENDING 폴링·`promote` 재시도 멱등 재확인 ③ Promote가 찾는 승인 레코드는 그대로(`APR_STATUS#APPROVED`) — 변경 없음 |
| **dhxorb96** | ① 오케스트레이터 Agent(Strands Graph) ② 승인 API resume ③ type-detection 시작 방식 변경 ④ 개인 dev에서 전 구간 검증 후 공유 dev 전환·E2E ⑤ `docs/01` 9장 문구("상태 전이는 Step Functions") 개정안 |

전환 전까지 공유 dev SFN은 그대로 둔다 (진행 중 테스트 보호).
