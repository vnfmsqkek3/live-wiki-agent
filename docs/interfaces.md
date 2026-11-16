# 인터페이스 계약 (v0 기본값)

> 세 사람의 코드가 만나는 지점의 계약. 코드의 단일 원본은 `packages/schemas`(zod, Owner let522mj)이며 이 문서는 요약이다.
> **v0은 바로 구현에 쓰는 기본값이다.** 바꾸려면 섹션 Owner가 PR로 수정하고 맨 아래 변경 이력에 남긴 뒤 `요청기록/`으로 영향받는 사람에게 알린다.

## 1. ID 규칙 (Owner let522mj)

| 대상 | 형식 | 예 |
|---|---|---|
| 문서 | `doc_` + ULID | `doc_01JD3…` |
| 문서 버전 | `{doc_id}@v{n}` | `doc_01JD3…@v2` |
| 법령·규정 | `{law_id}@{revision_yyyy-mm-dd}` | `SYN-LOAN-001@2026-11-01` |
| 조문 | `{law_id}@{rev}/ARTICLE:{n}[-{branch}]/PARAGRAPH:{n}/ITEM:{n}[-{branch}]/SUBITEM:{GA..HA}` | `SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:2/ITEM:3/SUBITEM:GA` |
| 부칙 조 | `{law_id}@{rev}/SUPPLEMENTARY:{k}/ARTICLE:{n}` (본칙과 별도 네임스페이스) | `…@2026-11-01/SUPPLEMENTARY:1/ARTICLE:2` |
| 별표 | `{law_id}@{rev}/ANNEX:{n}[-{m}]` | `…@2026-11-01/ANNEX:1-2` (별표 1의2) |
| 노하우 청크 | `{doc_id}#s{n}` (섹션 순번) | `K-001#s2` |
| 워크플로 | `wf_` + ULID | |
| 승인 | `apr_` + ULID | |
| Finding | `fnd_` + ULID | |

## 2. 상태 enum (Owner let522mj, 정의 `01` 1.4.1)

| 필드 | 값 |
|---|---|
| `document_type` | `REGULATION` / `KNOWHOW` / `MANUAL` |
| `authority_status` | `VERIFIED` / `UNVERIFIED` / `REJECTED` (+ `conditional: boolean`) |
| `freshness` | `CURRENT` / `REVIEW_REQUIRED` / `SUPERSEDED` |
| `lifecycle` | `QUARANTINED` / `IN_REVIEW` / `PENDING_APPROVAL` / `PUBLISHED` / `BLOCKED` |
| `trust_gate_result` | `PASS` / `REVIEW_REQUIRED` / `QUARANTINED` |
| `provision_status` | `ACTIVE` / `HISTORICAL` / `DELETED` |
| `search_status` | `FOUND` / `HISTORICAL` / `DELETED` / `NOT_FOUND_VERIFIED` / `UNVERIFIED` / `ACCESS_DENIED` |
| `role` | `USER` / `AUTHOR` / `REG_APPROVER` / `SECURITY_REVIEWER` / `PLATFORM_OPERATOR` (Cognito 그룹명과 동일) |
| `index_group` | `legal-clauses` / `wiki-knowledge` / `official-manuals` |

ACL 키 (v0.1): 문서 `acl_groups`에는 `ALL`, 역할명, `DEPT#{부서}` 중 하나 이상을 넣는다. 검색 Tool은 사용자 신원에서 `["ALL", ...groups, "DEPT#{dept}"]`를 만들어 `listContains`로 대조한다.

## 3. S3 레이아웃 (Owner yoyo0704)

| 버킷 | 키 | 읽기 권한 |
|---|---|---|
| `hanaeum-mvp-s3-quarantine[-닉네임]` | `{doc_id}/original.{ext}` | 단계 Lambda (모델 호출 Role 제외) |
| | `{doc_id}/work/{text_layer.json, pages/, ocr/, segments/}` | 동일 (원본 등급) |
| | `{doc_id}/masked/segments/{n}.json` | 모델 호출 Role 허용 |
| `hanaeum-mvp-s3-published[-닉네임]` | `{legal\|knowledge}/{doc_id}/{file}` + `{file}.metadata.json` | KB 데이터 소스, search Tool |
| `hanaeum-mvp-s3-artifact[-닉네임]` | `kb-intermediate/`, `evaluations/` | 해당 Lambda |
| `hanaeum-mvp-s3-log[-닉네임]` | 접근 로그 | 운영 |

## 4. 환경변수 (Owner yoyo0704)

| 이름 | 예 | 사용처 |
|---|---|---|
| `AWS_REGION` | `us-east-1` | 전체 |
| `HANAEUM_ENV` | `dev-yoyo0704` / `prod` | 리소스 이름 접미사 결정 |
| `TABLE_DOCUMENTS` 등 `TABLE_*` | `hanaeum-mvp-ddb-documents` | API·Lambda. 7종: DOCUMENTS, REGULATIONS, FINDINGS, APPROVALS, FEEDBACK, AUDIT_EVENTS, WORKFLOWS |
| `BUCKET_QUARANTINE`, `BUCKET_PUBLISHED`, `BUCKET_ARTIFACT` | | |
| `KB_ID`, `KB_DS_LEGAL_ID`, `KB_DS_KNOWLEDGE_ID` | | let522mj 코드 |
| `GUARDRAIL_ID`, `GUARDRAIL_VERSION` | | dhxorb96 코드 |
| `MODEL_HAIKU`, `MODEL_SONNET`, `MODEL_OPUS`, `MODEL_EMBED`, `MODEL_RERANK` | inference profile ID | 하드코딩 금지 |
| `NEPTUNE_ENDPOINT` | | graph 코드 |
| `SQS_INGEST_TRIGGER` | 업로드 이벤트 큐 URL | type-detection Lambda (dhxorb96) |
| `KMS_KEY_ARN`, `VPC_ID` | | Lambda·리소스 추가 시 |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | | API·Web. access token claim: `sub`, `cognito:groups`, `dept`(Pre Token V2) |
| `OCR_ENDPOINT_NAME` | | OCR 단계 |

값은 Terraform output → SSM Parameter Store `/hanaeum-mvp/{env}/{name}` → 각 런타임이 읽음. `.env.example`에 이름만 둔다. 공유 dev는 `env=dev`(리소스 접미사 `-dev`).

| 인프라 규칙 | 내용 |
|---|---|
| DynamoDB 키 | 모든 테이블 `pk`(S) + `sk`(S), GSI `gsi1`(`gsi1pk`/`gsi1sk`). 키 값 규칙은 테이블 Owner가 정한다 |
| 워크플로 테이블 | `pk=WF#{workflow_id}`, `sk=STEP#{단계명}` (status, ended_at, error) / `sk=EXECUTION` (실행 실패) |
| 모델 호출 Role | AgentCore Runtime·KB·모델 호출 Lambda Role에 태그 `hanaeum-model-caller=true`. quarantine 버킷이 `*/original.*`, `*/work/*` 읽기를 거부한다 |

## 5. 메타데이터 사이드카 (Owner let522mj)

`04` 4.1의 `.metadata.json` 그대로. 필수: `doc_id, title, document_type, index_group, authority_status, freshness, lifecycle, law_id?, law_name?, revision_id?, effective_from(yyyymmdd 숫자), effective_to, acl_groups[], dept, approval_id, content_hash`.
- REGULATION은 `law_id`·`revision_id` 필수. `content_hash` = 게시 본문(마스킹본)의 `sha256:{hex}`.
- 청크 메타데이터(Chunker가 추가): `provision_id, provision_path, provision_status, parent_id, source_page, original_text`.
- `original_text`는 인용용 원문. 임베딩 입력(contentBody)은 문맥 헤더 + 본문인 `augmented_search_text`이며 인용에 쓰지 않는다.
- 위치: `published/{legal|knowledge}/{doc_id}/content.txt` + `content.txt.metadata.json`.

## 6. 단계 입출력 (Owner yoyo0704, 단계별 Owner는 `05` 3장)

모든 단계 Lambda 입력: `{ workflow_id, doc_id, version, bucket, prefix, actor: { sub, groups } }`
모든 단계 Lambda 출력: `{ status: "OK" | "REVIEW_REQUIRED" | "BLOCKED", output_key?, findings?: Finding[] }`
- 실패는 예외로 던진다 (오케스트레이터가 Gateway `isError`로 받아 `STEP#` FAILED 기록). 빈 결과로 성공 처리 금지.
- `status: "PENDING"`은 폴링 단계(MalwareCheck, OcrIfNeeded, KbIngest)만 쓴다. 15초 뒤 같은 입력으로 다시 호출되므로 멱등이어야 한다.
- `BLOCKED`면 이후 단계를 건너뛰고 Finalize로 간다. Finalize 입력에는 `outcome: PUBLISHED | BLOCKED | REJECTED`가 추가된다.
- 실행 단위 = `workflow_id` (단계 기록 `WF#{workflow_id}`). 입력 = 공통 입력 6필드.
- 승인 대기는 `await_review` Tool(Trust Gate 뒤) → `IN_REVIEW` 후 종료. 승인 API 가 `resume`(decision: APPROVE | REJECT | REVALIDATE)으로 재개, APPROVE만 Promote로 진행 (6.1).
- Findings 저장: 각 단계가 Documents(`pk=DOC#{doc_id}`, `sk=META`)의 `findings` 배열에서 **자기 단계 것만 교체**한다. 병렬 단계 충돌을 막기 위해 `updated_at` 조건부 쓰기 + 재시도 (`workflows/src/steps/findings-store.ts`).
- yoyo0704 단계 산출물 (quarantine, 원본 등급):

| 단계 | 산출물 | 비고 |
|---|---|---|
| MalwareCheck | — | GuardDuty 태그 `GuardDutyMalwareScanStatus`. THREATS_FOUND→BLOCKED, UNSUPPORTED·FAILED→REVIEW_REQUIRED, 15분 무응답→예외 |
| PageRender | `{doc}/work/pages/{nnnn}.png`, `{doc}/work/pages/ocr_targets.json` `{doc_id, page_count, pages:[{page_index,key,width,height,reason}]}` | PDF 페이지 글자 수 < 50 또는 깨진 문자 > 20%만 렌더링(가로 2000px). 이미지는 원본이 대상. DOCX·HWPX는 대상 없음 |
| OcrIfNeeded | `{doc}/work/ocr/result.json` (`docs/04` 2.1 스키마, `source:"ocr"`, confidence 보존) | 대상 페이지만 포함. 저신뢰(블록 < 0.85 → LOW, 페이지 평균 < 0.9 → MEDIUM·REVIEW_REQUIRED) Finding `OCR_LOW_CONFIDENCE` |

### 6.1 AgentCore 파이프라인 (11/16 전환 완료, Step Functions 폐기)

| 항목 | 값 |
|---|---|
| Gateway | `hanaeum-mvp-gw-pipeline{-dev}`, inbound `AWS_IAM`(SigV4 service `bedrock-agentcore`), URL은 SSM `PIPELINE_GATEWAY_URL`. 호출 권한(`bedrock-agentcore:InvokeGateway`)은 오케스트레이터 Role 만 |
| Tool 이름 | `{target}___{단계키}`. target = 단계 키의 `_`를 `-`로 (예: `malware-check___malware_check`). 14개: wait_for_approval 제외 전 단계 |
| Tool 입력 | 공통 입력 6필드 (`actor`는 `{sub, groups[]}`) + `outcome`(finalize 전용). 출력은 Lambda 응답 JSON 그대로(`content[0].text`) |
| 오류 | `exception_level=DEBUG`: 단계 예외는 `isError:true` + `{errorType, errorMessage}` |
| Runtime | `hanaeum_mvp_rt_pipeline{_dev}` (이름에 하이픈 불가). 이미지: SSM `PIPELINE_ECR_REPO`(linux/arm64). Role `hanaeum-mvp-role-rt-pipeline{-dev}`: Gateway 호출, Documents·Workflows RW. Runtime ARN 은 SSM `PIPELINE_RUNTIME_ARN` (생성 전 `pending`) |
| 시작 | type-detection: `InvokeAgentRuntime({action:"start"})`, 승인 API: `InvokeAgentRuntime({action:"resume", decision})`. SFN·task token 경로는 폐기 |
| 사람 승인 | 오케스트레이터는 Trust Gate 뒤 `await_review` Tool 로 `lifecycle=IN_REVIEW` 를 두고 종료. 승인 API 가 resume |

- SegmentBuild(let522mj)는 `work/text_layer.json` + `work/ocr/result.json`을 페이지 번호로 병합한다. OCR 결과에 없는 페이지는 텍스트 레이어를 쓴다.
- 단계 Lambda는 Terraform 변수 `step_functions = { malware_check = "<arn>", … }`로 연결한다. 비어 있으면 dev stub(`{status:"OK"}`). 단계 키: `workflows/src/asl.ts`.
- `Finding = { finding_id, step, severity: LOW|MEDIUM|HIGH, code, message, evidence_ref }` (원문 PII를 message에 넣지 않음)

## 7. Backend API (Owner dhxorb96, 원본 `01` 10장)

| 메서드·경로 | 역할 | 요약 |
|---|---|---|
| `POST /v1/documents/upload-url` | AUTHOR | → `{ doc_id, url }` (SigV4, 리전 엔드포인트) |
| `POST /v1/documents/{id}/analyze` | AUTHOR | 워크플로 시작 → `{ workflow_id }` |
| `GET /v1/documents/{id}` | 권한 내 | 상태·단계 진행·분류 |
| `GET /v1/documents/{id}/review` | AUTHOR·REVIEWER | OCR·PII·Trust Gate Findings, 마스킹 미리보기 |
| `POST /v1/documents/{id}/submit` | AUTHOR | 게시 요청 → Approvals 생성 |
| `GET /v1/approvals?status=PENDING` | REG_APPROVER·SECURITY_REVIEWER | 승인 대기 목록 |
| `POST /v1/approvals/{id}/decision` | REG_APPROVER | `{ decision: APPROVE\|REJECT\|REVALIDATE, reason }` (사람만) |
| `GET /v1/search?q=&tags=&as_of=` | USER+ | ACL 필터 + 재랭크 결과, `search_status` 포함 |
| `POST /v1/guides` | USER+ | 인용 포함 가이드 생성 |
| `POST /v1/policies/{id}/impact` | REG_APPROVER | 영향 분석 |
| `POST /v1/feedback` | USER+ | `{ doc_id, stars, useful }` 사용자당 문서 1건 (덮어쓰기) |
| `GET /v1/admin/observability` | PLATFORM_OPERATOR | 마스킹된 지표 |

공통 오류: `{ error: { code, message, trace_id } }`, 401/403/404/409(CONFLICT)/422.

### 7.1 승인 바인딩 (보안 필수)

Approvals 레코드: `approval_id, doc_id, version, s3_version_id, content_hash, author_sub, approver_sub?, status(PENDING|APPROVED|REJECTED|USED), task_token, decided_at`
- 승인 시 조건부 쓰기: `status = PENDING` AND `approver_sub ≠ author_sub` AND 현재 객체의 `s3_version_id`·`content_hash`가 레코드와 일치.
- Promote 단계는 `APPROVED` → `USED`로 조건부 전환 후에만 진행 (재사용·중복 callback 차단).

## 8. 버전 고정표 (M0에 기입)

| 항목 | 버전 | Owner |
|---|---|---|
| Node.js LTS | 26.13.1 (`.nvmrc` 26, Lambda `nodejs24.x`) | yoyo0704 |
| Terraform / AWS provider | Terraform ≥1.14 (최신 1.17.2) / aws `~> 6.73`, archive `~> 2.7`, random `~> 3.7` (`.terraform.lock.hcl`) | yoyo0704 |
| PaddleOCR 이미지·모델 | paddleocr 3.7.0 (11/18 컨테이너 빌드 시 확정) | yoyo0704 |
| Strands Agents TS SDK | | dhxorb96 |
| Backend 프레임워크 | | dhxorb96 |
| Next.js | | dhxorb96 |
| zod | 4.6.7 | let522mj |
| unpdf (PDF 텍스트 레이어) | 2.2.1 | let522mj |
| AWS SDK v3 (`@aws-sdk/client-*`, `lib-dynamodb`) | 3.1169.0 | let522mj |
| `@smithy/signature-v4` / `@aws-crypto/sha256-js` (Neptune SigV4) | 5.7.5 / 5.2.0 | let522mj |
| TypeScript / ESLint / Vitest | typescript 6.0.3 (typescript-eslint가 7.x 미지원), eslint 10.15.0, typescript-eslint 8.72.2, vitest 5.1.0 | yoyo0704 |
| Bedrock 모델 inference profile ID (Haiku/Sonnet/Opus 5.5, Titan V2, Cohere Rerank 3.5) | **5.5 미허용으로 임시 대체**: `us.anthropic.claude-haiku-4-5-20251001-v1:0` / `us.anthropic.claude-sonnet-4-6` / `us.anthropic.claude-opus-4-6-v1`, `amazon.titan-embed-text-v2:0`, `cohere.rerank-v3-5:0` (트러블슈팅 11/16) | yoyo0704 |

## 9. 신원 전달 (Owner dhxorb96, M0 실험으로 확정)

| 구간 | 방식 (v0) |
|---|---|
| Web → API | Cognito JWT (Authorization 헤더). API가 서명·audience·issuer 검증 |
| API → AgentCore Runtime | 검증된 claims(`sub`, `groups`, `dept`)를 세션 컨텍스트로 전달 |
| Runtime → Gateway | Gateway inbound 인증(Cognito JWT) [확인 필요: 사용자 토큰 전달 방식] |
| Gateway → Lambda Target | Lambda는 이벤트의 사용자 컨텍스트를 신뢰 경계로 보고 DynamoDB 권한을 재검증. 클라이언트가 보낸 user id 인자는 무시 |

## 변경 이력

| 날짜 | 작성자 | 섹션 | 변경 |
|---|---|---|---|
| 2026-11-16 | 초기 설정 | 전체 | v0 기본값 |
| 2026-11-16 | yoyo0704 | 4·6.1 | Step Functions 폐기 (SFN_INGEST_ARN 삭제, 시작·승인은 AgentCore 만), await_review Tool |
| 2026-11-16 | yoyo0704 | 6.1 | AgentCore 파이프라인 Gateway·Tool 이름·Runtime 계약 (긴급 전환) |
| 2026-11-16 | yoyo0704 | 4·6·8 | TABLE_WORKFLOWS·SQS_INGEST_TRIGGER 추가, DynamoDB 키 규칙, 모델 호출 Role 태그, 단계 PENDING·outcome·task_token, 버전 고정 |
| 2026-11-16 | let522mj | 1·2·5·8 | v0.1: 부칙·별표·노하우 청크 ID, `index_group` enum, ACL 키 규칙(`DEPT#`), 메타데이터 `title`·`law_name`·청크 `original_text` 추가, 버전 기입 |
