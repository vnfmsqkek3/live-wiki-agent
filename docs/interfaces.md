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
| | `{doc_id}/masked/summaries/{n}.json`, `{doc_id}/masked/summary.json` (PageSummarize, 쪽별 요약·메타데이터) | 모델 호출 Role·API |
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
- v0.2 선택: `business_path[]`(최대 3, Classify 업무 경로)·`tags[]`(최대 8). 빈 값이면 키 생략. 청크 메타데이터에 그대로 복사되며 search_wiki `business`·`tags` 필터(`listContains`)와 결과 필드로 쓴다.
- 그림 묘사(13항 13번): masked segment의 `figures[{kind,description,overlay_text?,intent?}]` → 게시 본문 끝에 `⟦그림 p{page}⟧ …` 줄(`figureLine`) → 청크는 별도(`provision_id={doc_id}#fig{n}`, `has_figure: true`, `original_text: ""`), 검색 결과 `quotable: false`. 그림 묘사는 원문이 아니므로 근거 인용 금지.
- Regulations 테이블 추가 키(let522mj): `REGHASH#{sha256}`/`REV` → Registry 해시 → 개정본, `WEBLAW#{법령명}`/`LATEST` → Browser 조회 캐시(1일).
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
| PageRender | `{doc}/work/pages/{nnnn}.png`, `{doc}/work/pages/ocr_targets.json` `{doc_id, page_count, pages:[{page_index,key,width,height,reason,has_images}]}` | PDF 페이지 글자 수 < 50·깨진 문자 > 20%·그림 있음만 렌더링(가로 2000px). 이미지는 원본이 대상. DOCX·HWPX는 안에 든 그림을 쪽별로 이어 붙인 PNG(`reason:"embedded_images"`, 쪽 번호는 TextLayerExtract와 동일). 읽을 수 없는 그림 형식(EMF·WMF 등)은 Finding `FIGURE_FORMAT_UNSUPPORTED`(MEDIUM, 쪽 위치) |
| PageSummarize | `{doc}/masked/summaries/{nnnn}.json` `{doc_id, page_index, page, summary, keywords[≤8], clause_refs[], page_type, char_count, figure_count, segment_key, model, generated_at}`, `{doc}/masked/summary.json` `{doc_id, version, page_count, pages[]}` | 입력은 masked/segments(text + figures)만, MODEL_HAIKU. clause_refs는 본문에 실제로 있는 조문 표기만. 판정은 바꾸지 않음(OK). 오케스트레이터 순서 InjectionScan → PageSummarize → Classify (env `PAGE_SUMMARIZE=on`) |
| PurgeDocument | — | 문서 삭제 흐름 전용(사용자 결정 11/17 B). Documents `lifecycle=DELETED` 일 때만, `published/{legal,knowledge}/{doc_id}/`·`quarantine/{doc_id}/` 모든 버전·삭제 마커 삭제. 아니면 예외 `NotDeleted` |
| OcrIfNeeded | `{doc}/work/ocr/result.json` (`docs/04` 2.1 스키마, `source:"ocr"`, confidence 보존) | 대상 페이지만 포함. 저신뢰(블록 < 0.85 → LOW, 페이지 평균 < 0.9 → MEDIUM·REVIEW_REQUIRED) Finding `OCR_LOW_CONFIDENCE` |

### 6.0 문서 삭제 흐름 (사용자 결정 11/17 B)

| 순서 | 주체 | 동작 |
|---|---|---|
| 1 | API `DELETE /v1/documents/{id}` (dhxorb96) | 작성자 본인 또는 관리자. 감사 `DOCUMENT_DELETE` → `lifecycle=DELETED`, `deleted_reason`·`deleted_by` (이 시점부터 검색·보관함·가이드 제외) → `InvokeAgentRuntime({action:"delete"})` |
| 2 | 오케스트레이터 `deleteGraph` (dhxorb96) | `purge_document` → `kb_ingest`(재색인, KB 에서 제거) → `graph_upsert`(`action:"delete"`) |
| 3 | `graph_upsert` `action:"delete"` (let522mj) | Documents `lifecycle=DELETED` 확인 후 Neptune `deleteDoc(doc_id)` |
| 남김 | — | Documents META(이력)·Approvals·AuditEvents (감사) |

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

Approvals 레코드: `approval_id, doc_id, version, s3_version_id, content_hash, author_sub, approver_sub?, status(PENDING|APPROVED|REJECTED|USED), reason?, decided_at, used_by?`
- 결정 후 재개는 AgentCore 오케스트레이터 `InvokeAgentRuntime({action:"resume", decision, input})` (6.1). `task_token`은 폐기(Step Functions 폐기 11/16) — 이전 레코드에 남은 값은 무시하고 응답에서 숨긴다
- 승인 시 조건부 쓰기: `status = PENDING` AND `approver_sub ≠ author_sub` AND 현재 객체의 `s3_version_id`·`content_hash`가 레코드와 일치.
- Promote 단계는 `APPROVED` → `USED`로 조건부 전환 후에만 진행 (재사용·중복 callback 차단).

## 8. 버전 고정표 (M0에 기입)

| 항목 | 버전 | Owner |
|---|---|---|
| Node.js LTS | 26.13.1 (`.nvmrc` 26, Lambda `nodejs24.x`) | yoyo0704 |
| Terraform / AWS provider | Terraform ≥1.14 (최신 1.17.2) / aws `~> 6.73`, archive `~> 2.7`, random `~> 3.7` (`.terraform.lock.hcl`) | yoyo0704 |
| PaddleOCR 이미지·모델 | paddleocr 3.7.0 (11/18 컨테이너 빌드 시 확정) | yoyo0704 |
| Strands Agents TS SDK | `@strands-agents/sdk` 1.25.0 (Node 24 컨테이너, MCP·structured output 지원 확인) | dhxorb96 |
| Backend 프레임워크 | Hono 4.13.18 + `@hono/node-server` 2.1.8, `aws-jwt-verify` 5.2.1, AWS SDK v3 3.1169.0, 테스트 `node:test` (TypeScript는 root 6.0.3) | dhxorb96 |
| Next.js | 16.4.6 (React 19.3.1) | dhxorb96 |
| zod | 4.6.7 | let522mj |
| unpdf (PDF 텍스트 레이어) | 2.2.1 | let522mj |
| AWS SDK v3 (`@aws-sdk/client-*`, `lib-dynamodb`) | 3.1169.0 | let522mj |
| `@smithy/signature-v4` / `@aws-crypto/sha256-js` (Neptune SigV4) | 5.7.5 / 5.2.0 | let522mj |
| TypeScript / ESLint / Vitest | typescript 6.0.3 (typescript-eslint가 7.x 미지원), eslint 10.15.0, typescript-eslint 8.72.2, vitest 5.1.0 | yoyo0704 |
| Bedrock 모델 inference profile ID (Haiku/Sonnet/Opus 5.5, Titan V2, Cohere Rerank 3.5) | **5.5 미허용으로 임시 대체**: `us.anthropic.claude-haiku-4-5-20251001-v1:0` / `us.anthropic.claude-sonnet-4-6` / `us.anthropic.claude-opus-4-6-v1`, `amazon.titan-embed-text-v2:0`, `cohere.rerank-v3-5:0` (트러블슈팅 11/16) | yoyo0704 |

## 9. 신원 전달 (Owner dhxorb96, M0 실험으로 확정)

| 구간 | 방식 (v0) |
|---|---|
| Web → API | Cognito JWT (Authorization 헤더). API가 서명·client·issuer 검증 (`aws-jwt-verify`) |
| API → AgentCore Runtime | 사용자 **access token**을 그대로 `Authorization: Bearer`로 Runtime HTTPS 엔드포인트 호출. Runtime `customJWTAuthorizer`(Cognito discovery, allowedClients) 검증 + `requestHeaderAllowlist: ["Authorization"]`로 컨테이너에 전달 |
| Runtime → Gateway | Agent가 받은 같은 access token을 `McpClient({ url, headers: { authorization } })`로 전달. Gateway `CUSTOM_JWT` 검증 |
| Gateway → Lambda Target | **Gateway는 Tool Lambda에 사용자 신원을 넘기지 않는다** (이벤트=Tool 인자만, clientContext=gateway·target·tool 메타). REQUEST interceptor(`mcp/gateway-interceptor`)가 JWT를 재검증하고 `arguments.__actor = { sub, groups, dept? }`를 주입(클라이언트·모델이 보낸 `__actor`는 덮어씀). Tool Lambda는 `__actor`만 신뢰하고 DynamoDB 권한을 재검증 |

M0 실험 결과 (2026-11-16, dhxorb96 개인 dev): 위 4구간 전체 성공. 무토큰 Runtime·Gateway 호출 401, 위조 `__actor` 덮어씀 확인.

| 확인 사항 | 결과 |
|---|---|
| 토큰 종류 | Runtime·Gateway의 `allowedClients`는 **access token**(`client_id` claim)만 통과. ID token은 Gateway에서 `insufficient_scope` |
| 스키마 외 인자 | Gateway는 inputSchema에 없는 인자도 Lambda에 그대로 전달 → Tool은 `__actor` 외 신원 인자를 무시해야 함 |
| `dept` | access token에는 `custom:dept`가 없다. 부서 ACL이 필요하면 Cognito Pre Token Generation(V2) 트리거로 access token에 `dept` 추가 [요청: yoyo0704] 또는 Tool이 DynamoDB 사용자 레코드 조회 |
| Tool 이름 | Agent에 노출되는 이름은 `{target}___{tool}` (예: `search___search_wiki`) |
| interceptor 장애 | interceptor Lambda 오류 시 Tool은 호출되지 않고 오류 텍스트가 result로 반환됨 |

## 10. 거버넌스 저장소 PostgreSQL (Owner yoyo0704, 사용자 결정 11/17)

문서 메타데이터·검수 결과·승인·피드백·초안·감사를 DynamoDB 에서 Aurora PostgreSQL(Serverless v2)로 옮긴다. 통계·리포트 화면은 보류.

| 항목 | 값 |
|---|---|
| 접근 | RDS Data API 만 (`@hanaeum/db`, `packages/db`). VPC·연결 풀 불필요. SSM `DB_CLUSTER_ARN`·`DB_SECRET_ARN`(app 사용자)·`DB_NAME` |
| 권한 | Terraform `module.aurora.app_statements` (rds-data 5종 + app secret + KMS). master secret 은 마이그레이션 전용 |
| 스키마 | `hanaeum-terraform/db/migrations/*.sql` (yoyo0704). 바꾸려면 새 번호 파일 PR, 리뷰어 dhxorb96·let522mj |
| 남는 DynamoDB | `workflows`(단계 기록·잠금), `regulations`(Trusted Registry) |
| 전환 | 환경변수 `GOV_STORE=dynamo\|postgres` (Terraform `governance_store`). 세 사람 구현이 모두 dev 에 올라간 뒤 dev 전환 → 데이터 복사(`scripts/db-copy-from-dynamo.mjs`) → smoke·QA → prod. 전환 뒤에도 DynamoDB 테이블은 롤백용으로 남김 |

| DynamoDB (이전) | PostgreSQL | 비고 |
|---|---|---|
| documents `DOC#{id}`/`META` | `documents` | 주요 열 + 나머지 `attrs jsonb`. 시각 `timestamptz`. `lifecycle` 에 `DELETED` 포함 |
| META 의 `findings[]` | `findings` | 단계별 교체 = 한 트랜잭션에서 `SELECT … FROM documents WHERE doc_id=:id FOR UPDATE` → `DELETE WHERE doc_id AND step` → `INSERT`. `updated_at` 조건부 재시도 대체 |
| documents `DRAFT#{id}` | `drafts` | |
| approvals `APR#{id}` | `approvals` | 자기 승인 금지·결정 시각 CHECK. 결정은 `UPDATE … WHERE status='PENDING' AND author_sub<>:ap AND s3_version_id=:v AND content_hash=:h RETURNING *` (0행 → CONFLICT) |
| feedback `DOC#`/`USER#` | `feedback` (PK doc_id+user_sub) | upsert `ON CONFLICT DO UPDATE` |
| audit_events | `audit_events` | 추가만 (UPDATE·DELETE 트리거로 거부, app 권한도 INSERT·SELECT 만) |

- 조회: 보관함·결재함·노하우 점검의 전체 Scan → `WHERE owner=…` / `WHERE lifecycle IN (…)` 인덱스 조회.
- 오류: `pgCode(e)` 로 SQLState 판별 (23505 중복, 23503 FK, 23514 CHECK → API 409/400).

## 변경 이력

| 날짜 | 작성자 | 섹션 | 변경 |
|---|---|---|---|
| 2026-11-16 | 초기 설정 | 전체 | v0 기본값 |
| 2026-11-16 | yoyo0704 | 6.1 | AgentCore 파이프라인 Gateway·Tool 이름·Runtime 계약 (긴급 전환) |
| 2026-11-16 | yoyo0704 | 4·6·8 | TABLE_WORKFLOWS·SQS_INGEST_TRIGGER 추가, DynamoDB 키 규칙, 모델 호출 Role 태그, 단계 PENDING·outcome·task_token, 버전 고정 |
| 2026-11-16 | let522mj | 1·2·5·8 | v0.1: 부칙·별표·노하우 청크 ID, `index_group` enum, ACL 키 규칙(`DEPT#`), 메타데이터 `title`·`law_name`·청크 `original_text` 추가, 버전 기입 |
| 2026-11-16 | dhxorb96 | 8·9 | dhxorb96 행 버전 기입, 신원 전달 M0 실험 결과로 확정 (access token, Gateway interceptor `__actor` 주입) |
| 2026-11-16 | dhxorb96 | 7.1·9 | 승인 바인딩: 버전 ID 불변 비교 + `content_hash=sha256:{hex}`(검사 원본 바이트, Promote 대조). interceptor `__actor.dept` 주입. 부서 ACL 키 `DEPT#{부서}` |
| 2026-11-16 | dhxorb96 | 7.1 | Approvals `task_token` 폐기, `used_by`(let522mj Promote) 추가, 재개는 AgentCore resume |
| 2026-11-16 | let522mj | 5 | v0.2: 메타데이터 `business_path`·`tags`(문서보관함·분류 필터), Regulations `REGHASH#`·`WEBLAW#` 키 |
| 2026-11-16 | yoyo0704 | 4·6.1 | Step Functions 폐기 (SFN_INGEST_ARN 삭제, 시작·승인은 AgentCore 만), await_review Tool |
| 2026-11-16 | let522mj | 5 | 그림 묘사 청크(`has_figure`·`quotable`), `published_at` |
| 2026-11-17 | let522mj | 2(Finding) | v0.3: Finding 선택 필드 `location{page(1부터),bbox,excerpt(마스킹)}`·`user_message`·`fix_hint`, 예외용 `stepFailure(name, user_message, fix_hint)` (사용자 지시: 실패 사유를 쪽·위치까지) |
