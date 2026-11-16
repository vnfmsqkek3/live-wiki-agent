# 인터페이스 계약 (v0 기본값)

> 세 사람의 코드가 만나는 지점의 계약. 코드의 단일 원본은 `packages/schemas`(zod, Owner let522mj)이며 이 문서는 요약이다.
> **v0은 바로 구현에 쓰는 기본값이다.** 바꾸려면 섹션 Owner가 PR로 수정하고 맨 아래 변경 이력에 남긴 뒤 `요청기록/`으로 영향받는 사람에게 알린다.

## 1. ID 규칙 (Owner let522mj)

| 대상 | 형식 | 예 |
|---|---|---|
| 문서 | `doc_` + ULID | `doc_01JD3…` |
| 문서 버전 | `{doc_id}@v{n}` | `doc_01JD3…@v2` |
| 법령·규정 | `{law_id}@{revision_yyyy-mm-dd}` | `SYN-LOAN-001@2026-11-01` |
| 조문 | `{law_id}@{rev}/ARTICLE:{n}[-{branch}]/PARAGRAPH:{n}/ITEM:{n}/SUBITEM:{GA..HA}` | `SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:2/ITEM:3/SUBITEM:GA` |
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
| `TABLE_DOCUMENTS` 등 `TABLE_*` | `hanaeum-mvp-ddb-documents` | API·Lambda |
| `BUCKET_QUARANTINE`, `BUCKET_PUBLISHED`, `BUCKET_ARTIFACT` | | |
| `KB_ID`, `KB_DS_LEGAL_ID`, `KB_DS_KNOWLEDGE_ID` | | let522mj 코드 |
| `GUARDRAIL_ID`, `GUARDRAIL_VERSION` | | dhxorb96 코드 |
| `MODEL_HAIKU`, `MODEL_SONNET`, `MODEL_OPUS`, `MODEL_EMBED`, `MODEL_RERANK` | inference profile ID | 하드코딩 금지 |
| `NEPTUNE_ENDPOINT` | | graph 코드 |
| `SFN_INGEST_ARN` | | API |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | | API·Web |
| `OCR_ENDPOINT_NAME` | | OCR 단계 |

값은 Terraform output → SSM Parameter Store `/hanaeum-mvp/{env}/{name}` → 각 런타임이 읽음. `.env.example`에 이름만 둔다.

## 5. 메타데이터 사이드카 (Owner let522mj)

`04` 4.1의 `.metadata.json` 그대로. 필수: `doc_id, document_type, index_group, authority_status, freshness, lifecycle, law_id?, revision_id?, effective_from(yyyymmdd 숫자), effective_to, acl_groups[], dept, approval_id, content_hash`.
청크 메타데이터(Chunker가 추가): `provision_id, provision_path, provision_status, parent_id, source_page`.

## 6. 단계 입출력 (Owner yoyo0704, 단계별 Owner는 `05` 3장)

모든 단계 Lambda 입력: `{ workflow_id, doc_id, version, bucket, prefix, actor: { sub, groups } }`
모든 단계 Lambda 출력: `{ status: "OK" | "REVIEW_REQUIRED" | "BLOCKED", output_key?, findings?: Finding[] }`
- 실패는 예외로 던진다 (Step Functions Catch가 처리). 빈 결과로 성공 처리 금지.
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
| Node.js LTS | | yoyo0704 |
| Terraform / AWS provider | | yoyo0704 |
| PaddleOCR 이미지·모델 | | yoyo0704 |
| Strands Agents TS SDK | | dhxorb96 |
| Backend 프레임워크 | | dhxorb96 |
| Next.js | | dhxorb96 |
| zod | | let522mj |
| Bedrock 모델 inference profile ID (Haiku/Sonnet/Opus 5.5, Titan V2, Cohere Rerank 3.5) | | yoyo0704 |

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
