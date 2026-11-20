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

외부 법령 대조 Finding (11/20, 노하우 검증, AI엔지니어팀 구현): `KNOWHOW_EXTERNAL_MISMATCH`(MEDIUM, 외부·미검증 근거(국가법령정보센터 공식본)와 불일치, 게시 차단·잠금 아님, `fix_hint`에 수정 제안), `KNOWHOW_EXTERNAL_SKIPPED`(LOW, 외부 조회 실패·60초 초과·지시문 의심으로 대조 생략). 외부 법령 인식은 `externalLawRefs`(괄호 표기 + 줄 첫머리·여는 괄호 뒤 한 낱말 법령명, `…규정`·가지번호 `제9-5조` 포함), 행정규칙(`…규정·고시·훈령·예규·지침`)은 law.go.kr `/행정규칙/` 경로. 가지번호 `제n-m조`는 `제n조의m`과 같은 `ARTICLE:n-m`, `제n-m조의k`는 `ARTICLE:n-m-k`.

ACL 키 (v0.1): 문서 `acl_groups`에는 `ALL`, 역할명, `DEPT#{부서}` 중 하나 이상을 넣는다. 검색 Tool은 사용자 신원에서 `["ALL", ...groups, "DEPT#{dept}"]`를 만들어 `listContains`로 대조한다.

## 3. S3 레이아웃 (Owner infra)

| 버킷 | 키 | 읽기 권한 |
|---|---|---|
| `hanaeum-mvp-s3-quarantine` | `{doc_id}/original.{ext}` | 단계 Lambda (모델 호출 Role 제외) |
| | `{doc_id}/work/{document.pdf, text_layer.json, pages/, ocr/, segments/}` | 동일 (원본 등급). `document.pdf` = ConvertToPdf 결과 |
| | `{doc_id}/masked/segments/{n}.json` | 모델 호출 Role 허용 |
| | `{doc_id}/masked/summaries/{n}.json`, `{doc_id}/masked/summary.json` (PageSummarize, 쪽별 요약·메타데이터) | 모델 호출 Role·API |
| `hanaeum-mvp-s3-published` | `{legal\|knowledge}/{doc_id}/{file}` + `{file}.metadata.json` | KB 데이터 소스, search Tool |
| `hanaeum-mvp-s3-artifact` | `kb-intermediate/`, `evaluations/` | 해당 Lambda |
| `hanaeum-mvp-s3-log` | 접근 로그 | 운영 |

## 4. 환경변수 (Owner infra)

| 이름 | 예 | 사용처 |
|---|---|---|
| `AWS_REGION` | `us-east-1` | 전체 |
| `HANAEUM_ENV` | `prod` | SSM 경로 `/hanaeum-mvp/{env}/`. 11/20부터 prod 단일 환경 (`scripts/setup-env.sh` 기본값) |
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

값은 Terraform output → SSM Parameter Store `/hanaeum-mvp/{env}/{name}` → 각 런타임이 읽음. `.env.example`에 이름만 둔다. prod 단일 환경(사용자 결정 11/20, 계정 566533524321): 리소스 접미사 없음, `env=prod`. dev·개인 dev는 만들지 않는다.

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
- Regulations 테이블 키 (조문 구조화 저장소, 11/20 확정, data). **GSI 없음**: 모든 조회가 `pk` 일치 + `sk` 접두사(`begins_with`)라 기본 키로 충분하다.

| pk | sk | 값 |
|---|---|---|
| `LAW#{law_id}` | `REV#{revision_id}` | 개정본 (effective_from·to, authority_status, content_hash, parse_ok 등) |
| `LAW#{law_id}` | `REV#{revision_id}#P#{rel_path}` | 조문 (과거 버전 조회 = 같은 pk의 다른 `REV#`) |
| `LAWNAMES` | `LAW#{law_id}` | 법령명 목록 (이름 → law_id) |
| `REGHASH#{sha256:hex}` | `REV` | Registry 해시 → 개정본 |
| `WEBLAW#{법령명}` | `LATEST` | Browser 조회 캐시 (1일) |
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
| ConvertToPdf | `{doc}/work/document.pdf` | 사용자 결정 11/17 "모든 형식을 PDF 로 변환한 뒤 전부 OCR". 컨테이너 Lambda(LibreOffice, `services/convert-pdf`). PDF 복사·PNG/JPG 1장=1쪽·DOCX LibreOffice·HWPX LibreOffice+H2Orestart(실패 시 산출물 없이 OK → 기존 XML 방식)·TXT/MD 변환 없음. DOCX 실패·0쪽 = BLOCKED(`CONVERT_FAILED`·`CONVERT_EMPTY`), 300쪽 초과 = REVIEW_REQUIRED. 매크로 실행·외부 링크 갱신 끔. 오케스트레이터 순서 file_structure_check → **convert_to_pdf** → text_layer_extract·page_render |
| PageRender | `{doc}/work/pages/{nnnn}.png`, `{doc}/work/pages/ocr_targets.json` `{doc_id, page_count, pages:[{page_index,key,width,height,reason,has_images}]}` | **`work/document.pdf`(없으면 원본 PDF)의 모든 쪽** 렌더링(가로 2000px, `reason:"all"`, 11/17 전부 OCR 결정). 이전 기준(글자 수 < 50·깨진 문자 > 20%·그림)은 쓰지 않음. 이미지는 원본이 대상. DOCX·HWPX는 안에 든 그림을 쪽별로 이어 붙인 PNG(`reason:"embedded_images"`, 쪽 번호는 TextLayerExtract와 동일). 읽을 수 없는 그림 형식(EMF·WMF 등)은 Finding `FIGURE_FORMAT_UNSUPPORTED`(MEDIUM, 쪽 위치) |
| PageSummarize | `{doc}/masked/summaries/{nnnn}.json` `{doc_id, page_index, page, summary, keywords[≤8], clause_refs[], page_type, char_count, figure_count, segment_key, model, generated_at}`, `{doc}/masked/summary.json` `{doc_id, version, page_count, pages[]}` | 입력은 masked/segments(text + figures)만, MODEL_HAIKU. clause_refs는 본문에 실제로 있는 조문 표기만. 판정은 바꾸지 않음(OK). 오케스트레이터 순서 InjectionScan → PageSummarize → Classify (env `PAGE_SUMMARIZE=on`) |
| PurgeDocument | — | 문서 삭제 흐름 전용(사용자 결정 11/17 B). Documents `lifecycle=DELETED` 일 때만, `published/{legal,knowledge}/{doc_id}/`·`quarantine/{doc_id}/` 모든 버전·삭제 마커 삭제. 아니면 예외 `NotDeleted` |
| OcrIfNeeded | `{doc}/work/ocr/result.json` (`docs/04` 2.1 스키마, `source:"ocr"`, confidence 보존). **11/17 PP-StructureV3(표·레이아웃, 모든 업로드)**: 줄마다 레이아웃 `label`(doc_title·paragraph_title·text·table·figure 등)·표 안이면 `table_id`(`p{쪽}-t{n}`), `reading_order` 는 레이아웃 순서, 페이지 `tables:[{table_id,bbox,html}]`, `figures:[{label,bbox}]`(image·figure·chart·seal 영역 = Sonnet 비전 대상, 표·글자는 제외) 추가(없으면 이전과 같음) | 대상 페이지만 포함. 저신뢰(블록 < 0.85 → LOW, 페이지 평균 < 0.9 → MEDIUM·REVIEW_REQUIRED) Finding `OCR_LOW_CONFIDENCE` |

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

- SegmentBuild(let522mj)는 `work/text_layer.json`의 `needs_ocr=true` 쪽을 `work/ocr/result.json`으로 만든다. 11/17부터 `work/document.pdf`(ConvertToPdf)가 있으면 PDF·이미지·DOCX·HWPX는 모든 쪽 `needs_ocr=true`(글자 비움), TXT·MD만 텍스트. 변환본이 깨졌으면 예외 `ConvertedPdfInvalid`(재시도, 올린 사람 차단 아님). OCR 결과와 text_layer 쪽 수가 다르면 예외. OCR 결과에 대상 쪽이 없으면 예외.
- ConvertToPdf(yoyo0704, 11/17 신규): `{doc}/work/document.pdf`. TextLayerExtract는 이 파일이 있으면 그 쪽 수를 쓴다. 없으면(배포 전 호환) PDF는 쪽별 글자 수 판정, DOCX·HWPX는 XML 글자.
- 단계 Lambda는 Terraform 변수 `step_functions = { malware_check = "<arn>", … }`로 연결한다. 비어 있으면 dev stub(`{status:"OK"}`). 단계 키: `workflows/src/asl.ts`.
- `Finding = { finding_id, step, severity: LOW|MEDIUM|HIGH, code, message, evidence_ref }` (원문 PII를 message에 넣지 않음)

### 6.2 위키 수정과 단순 승인 (사용자 결정 11/17 "규칙 3개")

| 규칙 | 계약 |
|---|---|
| 1. 누구나 올리고 고친다 | 로그인 사용자 누구나 업로드·위키 수정. 수정 대상: 게시된 노하우·매뉴얼의 정리본 마크다운(규정은 공식 원본 대조라 수정 불가, 개정 원본 업로드만). 저장하면 새 버전(새 doc_id, `previous_doc_id`=원래 문서, `source=WIKI_EDIT`, 편집자 `owner`), 원문은 `{doc_id}/original.md`(Promote·승인 해시가 이 바이트로 대조). 원본 파일은 이전 버전 근거로 남음 |
| 2. AI 가 검사하고, 문제는 올린 사람이 고친다 | 수정본은 ConvertToPdf·PageRender·OCR 만 건너뛰고 TextLayerExtract·SegmentBuild 는 그대로(MD 는 글자 그대로, Promote 가 text_layer·segments 일치를 확인), 이어서 PII → Injection → 분류 → TrustGate(노하우 검증·주장 저장). 추가로 **수정분 검수**: 이전 버전과 문장 비교 → 바뀐 문장만 조문 대조·게시 주장(`claims`)과 충돌·중요 문장(한도·승인권자·금지) 삭제 감지. 문제는 올린 사람 화면에 "고칠 것 n건"(AI 수정 제안 '적용' 버튼). 남아 있으면 게시 요청 버튼 잠김 |
| 3. 승인자는 버튼 하나 | AI 검사를 통과한 것만 승인 대기. 승인 화면 = AI 요약 한 줄 + 바뀐 부분(수정본) + 승인·반려. 상세 검사 결과는 '자세히' 안. 승인 목록은 대기 순. 자기 승인 금지·승인은 버전·해시에 묶음(7.1) 유지. 승인 시 이전 버전 `SUPERSEDED` |
| 관리자 자기 승인 (11/18) | 관리자(PLATFORM_OPERATOR)가 올린 문서는 관리자 본인이 승인 가능(MVP 한정). approvals.self_approved=true, 감사 SELF_APPROVAL. 그 밖의 결재자는 자기 승인 금지 유지. DB 제약 008 |

없애는 것: 역할별 수정 권한 구분, 작성자 검토·승인 검토 이중 화면, 검토 화면의 검사별 섹션 나열(→ '자세히').

### 6.3 그림 쪽 정리본 page_markdown (사용자 결정 11/17 "A: megazone-idp 방식")

| 항목 | 계약 |
|---|---|
| 생성 (ImageDescribe, yoyo0704) | 그림 있는 쪽(masked/pages 있는 쪽)마다 마스킹 쪽 이미지 + OCR 글자(참고)를 Sonnet 에 넣어 쪽 전체 마크다운. 이미지가 정답, OCR 은 참고. 절차는 번호 단계, UI 이름 굵게, 그림 근거 문장 끝 `_(그림 n)_`(n = figures 순서). PII 재마스킹, 최대 6000자 |
| 저장 | `masked/figures/{nnnn}.json`·`masked/segments/{nnnn}.json` 의 `page_markdown` (그림 없는 쪽은 없음) |
| 사용 (Classify, dhxorb96) | 있으면 그 쪽 정리본으로 그대로(모델 재호출·원문 대조 없음). 화면 표시 "AI 정리(그림 기준)" |
| 인용 (11/18 결정) | **매뉴얼·노하우**는 VISION 정리본을 "그림 기준 근거"로 인용 허용(색인 quotable=true, evidence_kind FIGURE, 출처 "(그림 기준 · N쪽)", 인용 검증은 정리본 원문과 대조). **규정(REGULATION)**·조문 인용·주장 대조는 OCR 본문만. 그림 속 OCR 글자 줄은 계속 인용 불가 |
| 검사 | InjectionScan 이 page_markdown 도 검사 |
| 바뀌지 않는 것 | 조문 인용·PII 검사·주장 대조는 OCR `text` 기준 |

### 6.4 참조 확인 (ReferenceCheck, 사용자 결정 11/18)

| 항목 | 계약 |
|---|---|
| 목적 | 문서가 가리키는 대상(링크·사이트·다운로드·프로그램·버전·모델명)이 문서 안에 없거나 서로 맞지 않는 것을 찾아, 공개 웹에서 확인한 주소·정보를 "확인할 것" 으로 제안. 문서 유형 무관 |
| 위치 | Classify → ReferenceCheck → TrustGate (runtime env REFERENCE_CHECK=on). Lambda `reference-check`(handlers.referenceCheck, 300초), Gateway Tool `reference-check___reference_check`. 게시를 막지 않음. 실패해도 파이프라인 계속 |
| 1. 찾기 | Haiku 가 정리본(마스킹)에서 `{item, reason: MISSING_LINK·INCONSISTENT·MAY_BE_OUTDATED, query, page, official_site}` 목록 (최대 3건, 직렬 지연 제한) |
| 2. 검색어 검사 | 규칙: IPv4·이메일·사내 도메인·`[개인정보]` 등 마스킹 자리·사람 이름 추정이 있으면 검색 안 함. 검색어는 120자 이하 |
| 3. 브라우저 | AgentCore Browser(`aws.browser.v1`)로 Google 검색(결과 없으면 Bing; DuckDuckGo 는 사람 확인으로 제외) → 상위 결과 열어 제목·본문 일부로 일치 확인. 도메인 제한 없음(03 보완 통제). 단 블로그·카페·커뮤니티·Q&A·영상·위키 등 게시글은 제외(사용자 결정 11/18), 남은 결과가 없으면 "공식"·Bing 재검색, 그래도 없으면 제안 없음. 웹 글은 자료로만 |
| 4. 결과 | finding `REFERENCE_SUGGESTION`(LOW — Severity·DB CHECK 에 INFO 없음, 게시 비차단): `{item, query, url, title, checked_at}`, 화면 "정리본에 넣기" → 위키 수정(6.2) 흐름. 근거 인용 불가 |
| 감사 | `audit_events` action `WEB_SEARCH`(검색어·URL·결과 수, 원문 없음) |

### 6.5 확인 필요(Clarify) — 6.4 참조 확인 확장 (사용자 요구 11/18 1~8, Fable 권고안 채택)

| 항목 | 계약 |
|---|---|
| 단계 | 새 단계 없음. ReferenceCheck(Lambda·Tool 이름 유지)의 찾기 범위를 넓힘. 화면 이름 "확인 필요" |
| 종류(MVP) | `VAGUE_ACTOR`(담당자·부서 불명), `MISSING_VALUE`(기한·금액·기준·연락처 등 빠짐), `MISSING_LINK`, `INCONSISTENT`. 제외: VAGUE_EXPRESSION(오탐), OUTDATED 는 권고만. 최대 5건(웹 검색은 그중 3건) |
| 해결 순서 | ① 사내 위키 검색(PUBLISHED 문서만, 같은 category_path 우선, 출처 doc_id·쪽) ② 웹 검색은 MISSING_LINK·OUTDATED 만(VAGUE_ACTOR·MISSING_VALUE·INCONSISTENT 는 코드에서 금지 — 내부 사정 유출·오답, 표·본문 모순은 위키 제안만). MISSING_LINK 는 채택 결과가 없으면 1회 재시도 ③ 둘 다 없으면 질문만. 조직도 없음(사람이 입력한 답이 게시되면 다음 문서의 제안 출처) |
| finding | 코드 `CLARIFY_NEEDED`(기존 REFERENCE_SUGGESTION 은 kind=MISSING_LINK 로 통합). data `{kind, item, page, before, question, suggestions[{value, after, source:{type: WIKI·WEB·USER, doc_id?, page?, url?}}], status: OPEN·APPLIED·DISMISSED, dismiss_reason?}` |
| 차단 | `VAGUE_ACTOR`·`MISSING_VALUE` 가 절차·승인·한도 문장에 있으면 MEDIUM(게시 요청 잠금), 나머지 LOW. 풀기: 적용 / 직접 입력 / 해당 없음(사유 한 줄, 감사 기록, 승인 화면 '자세히') |
| 적용 | 화면에서 항목별 before→after 를 모아 `POST /v1/documents/:id/edit {markdown}` 한 번(6.2 새 버전 → 재검사 → diff → 사람 승인). 제자리 수정 금지(승인 해시). IN_REVIEW 문서 edit 허용(6.2 에 이미 있음) |
| PII | 담당자는 **역할+부서**("여신심사부 심사역")로만 제안. 입력란 안내 "이름 대신 부서·직책". 새 버전은 PiiScan 재검사 |
| 화면 | 올린 사람 검토 화면 "확인 필요 n건" 카드(고칠 것과 같은 목록): 질문·원문 강조·AI 제안(출처 배지)·[적용][직접 입력][해당 없음] → 카드 안 전/후 diff → 하단 "n건 반영하고 저장" |
| 일정 | 11/20 까지 dev. 못 맞추면 VAGUE_ACTOR + 위키 검색 + 사용자 입력만 시연 |

## 7. Backend API (Owner dhxorb96, 원본 `01` 10장, 11/17 갱신)

| 메서드·경로 | 역할 | 요약 |
|---|---|---|
| `POST /v1/documents/upload-url` | 로그인 누구나 (6.2 규칙 1) | → `{ doc_id, url }` (SigV4, 리전 엔드포인트) |
| `POST /v1/documents/{id}/analyze` | 올린 사람 | 워크플로 시작 → `{ workflow_id }` |
| `POST /v1/documents/{id}/edit` | 로그인 누구나 | 위키 수정 `{markdown}`. 게시 노하우·매뉴얼 → 새 버전(`source=WIKI_EDIT`, `previous_doc_id`, `{doc}/original.md`), 내 IN_REVIEW 문서 → 그 자리 재분석. 규정 409 |
| `POST /v1/documents/{id}/findings/{fid}/ack` | 올린 사람 | 수정에서 지운 중요 문장 '의도한 삭제' 확인 |
| `GET /v1/documents/{id}` · `/progress` · `/issues` | 권한 내 | 상태·단계 진행(`ConvertToPdf` '문서 변환' 포함)·확인할 내용 |
| `POST /v1/documents/{id}/change-requests` | 게시 문서를 읽을 수 있는 사람 | 위키 수정 요청 `{before, request}` → Haiku 판단 `{id, verdict: APPROPRIATE·INAPPROPRIATE·UNKNOWN, after, ai_reason}`. before 가 본문에 없으면 422 (11/18 사용자 결정: AI 초안 → 관리자 반영) |
| `GET /v1/admin/change-requests` · `POST /v1/admin/change-requests/{doc}/{id}` | 결재자 | 열린 수정 요청 목록 / `{decision: APPLY·REJECT, after?, reason?}`. APPLY 는 위키 수정과 같은 길로 새 버전(→ AI 검사 → 사람 승인), REJECT 는 사유 필수 (11/18) |
| `GET /v1/library/{id}/download?kind=original` | 상세를 볼 수 있는 사람 | 위키 수정 전 처음 올린 파일(버킷 버전). 기본은 지금 원본(위키 수정본이면 `…_수정본.md`) (11/18) |
| `POST /v1/documents/{id}/findings/{fid}/ack` | 올린 사람 | KNOWHOW_CONFLICT 도 허용(사유 필수, '그대로 사용' → 승인자 판단). 위키 수정 재검사에서 고치지 않은 문장의 새 충돌은 `system:recheck` 로 승인자 판단 (11/18 사용자 결정, 규칙 2 완화) |
| `GET /v1/documents/{id}/review` | 올린 사람·결재자 | `fixes`(고칠 것: KNOWHOW_CONFLICT·EDIT_REMOVED_KEY_SENTENCE + AI 수정 제안), `text`(고칠 본문), Findings, `version`(새 버전이면 직전 버전과 바뀐 곳 `{previous, count, changes[]}`, 못 읽으면 null — 11/18), `clarify[]`(확인 필요 6.5: `{finding_id, blocking, severity, kind, item, page, before, question, suggestions[], status, dismiss_reason}`), `text` 는 정리본 기준 |
| `POST /v1/documents/{id}/findings/{fid}/ack` | 올린 사람 | EDIT_REMOVED_KEY_SENTENCE '의도한 삭제' / CLARIFY_NEEDED '해당 없음' `{reason}`(필수, PII 마스킹, 감사 CLARIFY_DISMISS) |
| `POST /v1/documents/{id}/submit` | 올린 사람 | 게시 요청 → Approvals. 고칠 것이 남으면 409 |
| `DELETE /v1/documents/{id}` | 올린 사람·결재자 | 삭제 흐름 (6.0) |
| `GET /v1/approvals?status=PENDING` | REG_APPROVER·SECURITY_REVIEWER | 승인 대기 + `summary_line`·`version.changes`(바뀐 부분)·`source` |
| `POST /v1/approvals/{id}/decision` | REG_APPROVER | `{ decision: APPROVE\|REJECT\|REVALIDATE, reason }` (사람만, 자기 승인 금지. PLATFORM_OPERATOR만 예외: `self_approved`·감사 SELF_APPROVAL, 11/18) |
| `GET /v1/library` | USER+ | 문서 묶음 카드. `?category=`(하위 포함)·`type`·세부 필터, 카드 `category_path` |
| `GET /v1/library/{id}` | 권한 내 | 상세: `pages[].structured`(AI 정리본)·`structured_source`(TEXT\|VISION)·`clause_groups`, `image_pages`, `claims`, `category_path`·`category_id`, `verification.basis[].statement·reason·relation` |
| `GET /v1/library/{id}/external-laws` | 상세를 볼 수 있는 사람 | 본문이 인용한 외부 법령(내부 규정 저장소에 없는 것) 법령당 1건: `{law_name, clause?, result, error?, clauses:[{clause, sub?, result, error?}]}`. `clauses`는 조·항 단위(호·목은 `sub`), 본문 등장 순, 법령·조문 각 최대 10. `clause`·`result`는 첫 조문(하위 호환). 원문은 `regulation___fetch_official_law`(UNVERIFIED) (11/20 데이터팀 합의) |
| `GET /v1/library/{id}/pages` | 문서를 볼 수 있는 사람 | 원본 보기: 모든 쪽 `masked/view/{nnnn}.png`(개인정보만 가림) presigned GET 5분 `[{page,url}]` |
| `GET /v1/library/{id}/pages/{n}/image` | 문서를 볼 수 있는 사람 | 개인정보 가린 쪽 이미지(masked/pages) |
| `GET /v1/categories` · `PATCH /v1/categories/{id}` · `POST /v1/categories/{id}/merge` | USER+ / 결재자 | 업무 분류 트리(볼 수 있는 게시 문서 수) / 이름 수정·병합 (10.1) |
| `GET /v1/search?q=&type=&category=&raw=1` | USER+ | 문서 단위 묶음 + `related`, `rewritten{core,alternates}`(질의 재구성, `raw=1`이면 끔), 일치 조각 `page` |
| `POST /v1/guides` | USER+ | 인용 포함 가이드 (SSE 가능) |
| `GET /v1/admin/runs` · `/runs/{workflow_id}` | 결재자 | Agent 실행 기록(시작·소요·멈춘 단계), 단계별 상태 |
| `GET /v1/admin/impact/laws` · `/impact?law=` | REG_APPROVER | 규정 변경 영향(사용자 Gateway `graph___trace_impact`) |
| `GET /v1/library/{id}` 추가 필드 | 권한 내 | `pages[].figures[{k,url}]`(잘라낸 그림 presigned), `suggestions[]`(참조 확인 참고 주소) |
| `POST /v1/admin/impact/draft` | REG_APPROVER | 변경 영향 수정 초안 `{law, doc_id}` → `{items:[{id, doc_id, before, after\|null, verdict, ai_reason, path}]}` (201 새로 만듦 / 200 같은 문장 OPEN 초안 재사용). 서버가 `graph___trace_impact`를 다시 불러 영향 문서·근거를 확인(없으면 404), 근거 최대 3건마다 AI 초안(`steps/impact-draft.ts` AI팀, `checkImpactDraft` 통과분만) → 위키 수정 요청(`source:'IMPACT'`, `law`, `path`, status OPEN)으로만 저장, 문서 `freshness` CURRENT→REVIEW_REQUIRED. 근거 문장을 본문에서 못 찾으면 그 항목만 UNKNOWN·after null. 이후 결재함 [반영] → 새 버전 → AI 검사 → 사람 승인 (자동 게시 없음, 11/20 AI팀·총괄 합의) |
| `POST /v1/documents/{id}/freshness/confirm` | REG_APPROVER (본인 문서 금지, 관리자 예외) | 재검토(`freshness=REVIEW_REQUIRED`) 게시 문서를 '변경 없이 유효'로 `{reason}`(필수, PII 마스킹) → `{doc_id, freshness:'CURRENT', law_id, revision}`. 본문·버전 그대로, `freshness_confirmed[]`에 기록해 같은 개정판으로는 다시 표시 안 함, 열린 영향 초안(source IMPACT)은 이 사유로 REJECTED. 게시 문서가 아니거나 재검토 중이 아니면 409 |
| `GET /v1/admin/knowledge-debt` | 결재자 | 지식 상태 (`knowledge_debt` 뷰, 10.2) |
| `POST /v1/feedback` | USER+ | `{ doc_id, stars, useful }` 사용자당 문서 1건 (덮어쓰기) |
| `GET /v1/admin/evaluations` | 결재자 | Agent 평가 화면: `{run_at\|null, items[{key,label,target,passed,total,pass}], failures[{key,case_id,reason}], denials[{at,role,tool,reason,trace_id}], trace_url}`. 평가 결과는 30일 안의 마지막 감사 기록 `action=EVALUATION_RUN`(actor `system:evaluations`, `detail.items·failures`, key는 `tests/evaluations/cases/sets.json`)을 그대로 쓴다. denials는 7일 안의 API 403 감사 기록 최대 50건(역할만, sub 없음). Gateway interceptor 거부는 아직 미포함 (11/20) |

공통 오류: `{ error: { code, message, trace_id } }`, 401/403/404/409(CONFLICT)/422.

### 7.1 승인 바인딩 (보안 필수)

Approvals 레코드: `approval_id, doc_id, version, s3_version_id, content_hash, author_sub, approver_sub?, status(PENDING|APPROVED|REJECTED|USED), reason?, decided_at, used_by?`
- 결정 후 재개는 AgentCore 오케스트레이터 `InvokeAgentRuntime({action:"resume", decision, input})` (6.1). `task_token`은 폐기(Step Functions 폐기 11/16) — 이전 레코드에 남은 값은 무시하고 응답에서 숨긴다
- 승인 시 조건부 쓰기: `status = PENDING` AND `approver_sub ≠ author_sub`(PLATFORM_OPERATOR 자기 승인은 `self_approved=true`로만 허용) AND 현재 객체의 `s3_version_id`·`content_hash`가 레코드와 일치.
- Promote 단계는 `APPROVED` → `USED`로 조건부 전환 후에만 진행 (재사용·중복 callback 차단).

## 8. 버전 고정표 (M0에 기입)

| 항목 | 버전 | Owner |
|---|---|---|
| Node.js LTS | 26.13.1 (`.nvmrc` 26, Lambda `nodejs24.x`) | yoyo0704 |
| Terraform / AWS provider | Terraform ≥1.14 (최신 1.17.2) / aws `~> 6.73`, archive `~> 2.7`, random `~> 3.7` (`.terraform.lock.hcl`) | yoyo0704 |
| PaddleOCR 이미지·모델 | paddleocr 3.7.0 (11/18 컨테이너 빌드 시 확정) | yoyo0704 |
| Strands Agents TS SDK | `@strands-agents/sdk` 1.25.0 (Node 24 컨테이너, MCP·structured output 지원 확인) | dhxorb96 |
| ADOT Node 자동 계측 | `@aws/aws-distro-opentelemetry-node-autoinstrumentation` 0.14.0 (agents 컨테이너 `node --require …/register`, AgentCore Observability span) | ai |
| Backend 프레임워크 | Hono 4.13.18 + `@hono/node-server` 2.1.8, `aws-jwt-verify` 5.2.1, AWS SDK v3 3.1169.0, 테스트 `node:test` (TypeScript는 root 6.0.3) | dhxorb96 |
| Next.js | 16.4.6 (React 19.3.1) | dhxorb96 |
| zod | 4.6.7 | let522mj |
| unpdf (PDF 텍스트 레이어) | 2.2.1 | let522mj |
| AWS SDK v3 (`@aws-sdk/client-*`, `lib-dynamodb`) | 3.1169.0 | let522mj |
| `@smithy/signature-v4` / `@aws-crypto/sha256-js` (Neptune SigV4) | 5.7.5 / 5.2.0 | let522mj |
| TypeScript / ESLint / Vitest | typescript 6.0.3 (typescript-eslint가 7.x 미지원), eslint 10.15.0, typescript-eslint 8.72.2, vitest 5.1.0 | yoyo0704 |
| Bedrock 모델 inference profile ID (Haiku/Sonnet/Opus 5.5, Titan V2, Cohere Rerank 3.5) | **5.5 미허용으로 임시 대체**: `us.anthropic.claude-haiku-4-5-20251001-v1:0` / `us.anthropic.claude-sonnet-4-6` / `us.anthropic.claude-opus-4-6-v1`, `amazon.titan-embed-text-v2:0`, `cohere.rerank-v3-5:0` (트러블슈팅 11/16. prod 계정 566533524321에서 11/20 재확인: Haiku·Sonnet 5.5 Converse 거부) | infra |

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


### 10.1 업무 분류 자동화 (사용자 결정 11/17 "A: 완전 자동", 스키마 `db/migrations/006_categories.sql`)

| 항목 | 계약 |
|---|---|
| 테이블 | `categories(category_id, parent_id, name, path, level 1~3, description, embedding vector(1024), origin SEED·AI·ADMIN, merged_into, doc_count)`, `category_events`(추가만: CREATE·MERGE·RENAME·ASSIGN·REASSIGN), `documents.category_id` |
| 문서 배정 (Classify, dhxorb96) | ① 문서 요약+제목 임베딩(Titan v2) ② `SELECT … ORDER BY embedding <=> :v LIMIT 5` 후보(merged_into IS NULL, 임베딩 NULL 칸은 이름+설명으로 먼저 채움) ③ Haiku 가 후보 중 고르거나 "새 칸"(부모 + 이름 + 설명) ④ 새 칸이면 기존 칸과 코사인 유사도 ≥ 0.85 면 기존 칸 사용, 아니면 `origin=AI` 로 생성 ⑤ `documents.category_id`·`doc_count`·`category_events(ASSIGN/CREATE)` 를 한 트랜잭션 |
| 주기 정리 (yoyo0704, 매일) | 유사도 ≥ 0.9 칸 병합(작은 칸 → 큰 칸, `merged_into`, 문서 이동), 문서 0건 AI 칸 정리, '기타' 문서 묶음 → 새 칸 제안·생성. 모든 변경 `category_events` |
| 조회 (API·검색) | 보관함 트리 = `merged_into IS NULL` 칸 계층 + `doc_count`. 검색 필터 `category`(하위 포함). 색인 메타데이터 `category_path` (let522mj) |
| 관리자 | 선택: 이름 수정·병합(`origin=ADMIN`, 기록 남음). 승인 절차 없음 |


### 10.2 주장(Claim) 단위 지식 (사용자 결정 11/17 "얇은 버전", 스키마 `db/migrations/007_claims.sql`)

| 항목 | 계약 |
|---|---|
| 원본 | 노하우 검증 `knowhow_validation.items` 그대로. 새 추출 없음 |
| 저장 (dhxorb96, 검증 단계) | 검증이 끝나면 그 문서의 주장을 한 트랜잭션으로 교체: `DELETE` 대신 같은 `(doc_id, seq)` UPSERT, 사라진 seq 는 `status='SUPERSEDED'`. `claim_id={doc_id}#{seq}`, `verified = !!verified_quote`, `page` 는 찾으면 |
| 답변·집계 대상 | `documents.lifecycle='PUBLISHED'` 문서의 주장만 (JOIN). 삭제·이전 버전은 자동 제외 |
| 개정 시 재검증 (let522mj 개정 처리 → SQL) | 조문이 새 개정으로 바뀌면 `UPDATE claims SET status='REVIEW_REQUIRED', status_reason='provision_revised:'||:new, updated_at=now() WHERE provision_id=:old AND status='CURRENT'`. 노하우 재검증이 다시 돌면 저장 규칙대로 CURRENT 로 돌아옴 |
| 조회 (API, dhxorb96) | 상세: 주장 목록(문장·관계·근거 조문·인용·상태). 조문 기준: "지지 N / 충돌 N" (`GROUP BY provision_id, relation`). 관리자: `SELECT * FROM knowledge_debt` (conflicts·review_required·unverified·healthy·docs_needing_attention) |
| 나중 (칸만 있음) | `condition`(적용 조건), `group_id`·`embedding`(중복 묶기), Neptune CLAIM 노드 |

## 11. 외부 MCP 연결 — `hanaeum-wiki-mcp` (Owner yoyo0704, 사용자 요구 11/18 "다른 챗봇·문서 생성 앱을 붙일 수 있게", 이름 결정 11/18)

| 항목 | 계약 |
|---|---|
| 엔드포인트 | 사용자 Gateway(AgentCore, MCP) 그대로: SSM `/hanaeum-mvp/{env}/USER_GATEWAY_URL` |
| 인증 | Cognito client_credentials. 시크릿 `hanaeum-mvp/mcp-external-client{-env}` = {client_id, client_secret, token_endpoint, scope `hanaeum-wiki-mcp/read`}. 토큰 60분. Gateway allowed_clients 에 등록됨 |
| 신원 (dhxorb96 interceptor) | 사람 sub 없는 토큰(client_id = 외부 클라이언트) → `__actor {sub:"client:{client_id}", groups:[]}`: acl ALL(공개) 게시 문서만 |
| 도구 허용 (dhxorb96 interceptor) | 읽기만: search_wiki·retrieve_evidence·search_legal_clause·get_clause·get_official_policy·verify_version·resolve_reference·compare_versions·trace_impact·get_dependencies·get_wiki_document(신규). 거부: create_review_request·draft_change·detect_sensitive_data·masking_preview·get_status |
| 신규 도구 get_wiki_document (let522mj search-server) | 입력 {doc_id}. 출력 {doc_id, title, document_type, category_path, version, freshness, pages:[{page, markdown(정리본, 마스킹), source}], doc_pages(묶음)}. PUBLISHED·현재 버전·acl 확인. 문서 생성형 앱이 원문 대신 정리본을 받아 씀 |
| 감사 | Gateway 호출마다 audit `MCP_EXTERNAL` {client_id, tool, doc_ids} (질의 원문 없음) |
| 연결 안내 | `docs/외부-MCP-연결.md`(토큰 받기 curl, MCP 클라이언트 설정 예시) |

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
| 2026-11-17 | let522mj | 1(KB 메타데이터)·4(search_wiki) | v0.4: `DocumentMetadata.doc_date?`(YYYYMMDD, 본문 대표 일자 시행>개정>작성>발행>제정, Promote가 기록). `search_wiki` 세부 필터 `dept`·`date_from`·`date_to`(YYYY-MM-DD, doc_date)·`authority_status`(VERIFIED\|UNVERIFIED)·`freshness`(CURRENT\|REVIEW_REQUIRED). 검증 상태·최신성은 Documents 현재 상태로 거름 (사용자 요청: 검색 세부 필터) |
| 2026-11-17 | let522mj | 부록(라이브러리) | `@hanaeum/legal-parser`: `docDates`·`primaryDate`(문서 일자), `titleCandidate`(제목 후보), `previousVersionCandidates`·`similarity`(같은 문서의 이전 버전 후보), `diffDocuments`(버전 간 변경점: 규정은 조·항·호, 그 밖은 줄·쪽). Mark `original`·`revision` (원본·근거·수정 세 칸) |
| 2026-11-17 | let522mj | 4(search_wiki) | 질의 재구성: 인자 `rewrite`(boolean, 기본 true, false=원래 질의 그대로). 응답 `rewritten: { core, alternates≤2 }`, 결과 항목 `matched_query`(점수를 낸 질의). 규칙 정리본·core·alternates 각각 Retrieve+Rerank 후 청크별 최고 점수, 게이트 0.30 유지. 모델 입력은 PII 마스킹본, `MODEL_HAIKU` 없으면 규칙만. 평가 `tests/evaluations/cases/query_rewrite.jsonl` dev 실측 정답 35→38/40, 무관 질의 오탐 0/10 (요청기록 20261117-1910) |
| 2026-11-17 | let522mj | 3(단계 산출물) | 업로드 절차: 모든 형식 PDF 변환 후 전부 OCR (사용자 결정, 요청기록 20261117-2010). `text_layer.json`은 `work/document.pdf`가 있으면 PDF·이미지·DOCX·HWPX 모든 쪽 `needs_ocr=true`·`text:""`(없으면 기존 판정), `SCANNED_PAGE` finding 폐지. `work/document.pdf`(ConvertToPdf) 계약 추가. TXT·MD는 그대로 |
| 2026-11-17 | let522mj | 3(SegmentBuild) | OCR 페이지 `tables:[{table_id,bbox,html}]`(PP-StructureV3, yoyo0704 ed30ac3)가 있으면 `table_id` 줄들 대신 표 세로 위치에 마크다운 표 1개를 본문에 넣음. 표 앞뒤 빈 줄. colspan은 오른쪽 빈 칸, rowspan은 첫 행에만 값·아래 행 같은 열은 빈 칸. 변환 결과가 빈 표는 줄 나열(글자 보존). `tables` 없으면 기존 줄 나열 (요청기록 20261117-2120) |
| 2026-11-17 | let522mj | 1(KB 메타데이터)·4(search_wiki)·10.1 | v0.5: `DocumentMetadata.category_path?`(업무 분류 경로, Promote가 `documents.category_id`→`categories.path`, 병합 칸은 대상 경로, 조회 실패 시 생략). `search_wiki` 필터 `category`(하위 포함: `equals` 또는 `startsWith '경로/'`), 결과 항목 `category_path`. PostgreSQL이면 현재 분류의 게시 문서 doc_id(200건 이하)로 KB를 거르고 현재 분류로 다시 거름(재분류·병합된 문서도 새 분류에서 찾음, 200건 초과면 색인 시점 경로 필터). 분류 필터는 PostgreSQL 전용(DynamoDB 모드는 경로가 없어 0건). 경로 200자 초과·분류 테이블 없음이면 경로 생략, 그 밖의 조회 오류는 Promote 재시도. `dropped_after_revalidation`에 분류로 빠진 건수 포함. 평가 `tests/evaluations/cases/category.jsonl` 16건 (요청기록 20261117-2210) |
| 2026-11-17 | let522mj | 3(SegmentBuild) | 그림 속 글자(화면 캡처 등): OCR 줄의 label이 image·figure·chart·seal이거나 페이지 `figures[].bbox` 안이면 본문 흐름에서 빼고 그 자리에 `[그림 n]`, 쪽 끝에 `⟦그림 p{쪽}⟧ 그림 n 속 글자: …`(그림당 1,500자) 한 줄. 이 줄은 segment `text` 안에 있어 PiiScan이 함께 가리고, kb-chunker가 인용 불가 그림 청크로만 색인(검색은 됨). 저신뢰 판정은 본문 줄만(그림 속 줄·빈 덩어리 제외) (사용자 지적 11/17, 과천 매뉴얼) |
| 2026-11-17 | let522mj | 10.2(claims) | GraphUpsert: VERIFIED 규정 새 버전이 게시되면 직전 버전과 diff(부칙 제외)해 바뀐 조문(겹치는 경로 포함)에 근거를 둔 CURRENT 주장을 `status='REVIEW_REQUIRED'`, `status_reason='provision_revised:{새 버전 조문 ID}'`로. Records(PgRecords) `claimsCiting`·`markClaimReview`. 평가 `tests/evaluations/cases/claims.jsonl` (요청기록 20261117-2300) |
| 2026-11-17 | let522mj | 1(청크)·4(search_wiki)·5(게시본) | 쪽 번호: Promote가 게시본 `content.txt`의 쪽 사이에 폼피드(`\f`) 한 줄을 넣고, kb-chunker가 조각 원문 첫 줄이 처음 나오는 쪽을 `source_page`(0부터)로 기록(`\f`는 본문·인용에서 제거). `search_wiki` 결과 항목 `page`(1부터). 화면 쪽 썸네일용 (사용자 요청 11/17, dhxorb96 1378e2e) |
| 2026-11-17 | let522mj | 5(게시본)·6.3 | 그림 쪽 정리본 `page_markdown`을 게시본 끝에 `⟦그림 p{쪽}⟧ 쪽 정리(AI, 그림 기준): …` 한 줄(공백 정리, 4,000자)로 → kb-chunker가 인용 불가 그림 조각(`has_figure`, `original_text` 비움)으로 색인. 검색에는 쓰이고 근거 인용·주장 대조는 OCR text 기준 그대로 |
| 2026-11-18 | let522mj | 부록(라이브러리)·6.4 | `@hanaeum/regulation-server` `readPage(url, {expression, done, maxWaitSec?, region?, identifier?, sessionName?})`: AgentCore Browser 세션 열기 → 이동 → `expression`(브라우저에서 평가, 문자열)을 `done`일 때까지 1초 간격으로 읽기 → 세션 닫기. 시간 초과는 `PageNotReady`. http(s)만·내부 주소 거부·`allowHosts`로 제한(위반 `BlockedUrl`, 세션 열기 전 검사), 결과는 신뢰할 수 없는 입력(모델에 넘길 때 지시문 검사). 법령 원문 조회(AgentCoreLawFetcher)와 참조 확인(dhxorb96)이 같이 씀 |
| 2026-11-18 | let522mj | 3(SegmentBuild) | `work/segments/{nnnn}.json`에 `figure_boxes: number[][]`(그림으로 분리한 image·figure·chart 영역, 쪽 대비 0~1000 정수 [x0,y0,x1,y1]; 쪽 전체 스캔으로 본 큰 상자·직인 제외, 그림 없으면 생략). PiiScan이 masked/segments로 그대로 넘겨야 ImageDescribe가 씀(yoyo0704 b782529). OCR 줄 합치기: 같은 줄이라도 글자 높이 8배 넘게 떨어진 덩어리는 ` / `로 구분 |
| 2026-11-18 | let522mj | 1(청크) | 노하우·매뉴얼 조각: `## 제목` → 쪽 경계 → 길이(1,800자)로 나눔. 마크다운 표는 중간에서 자르지 않고, 표 하나가 상한을 넘으면 머리행을 반복해 행 단위로. `source_page`는 조각 첫 글자 줄의 쪽 (과천 매뉴얼: 39쪽이 조각 1개 → 39개) |
| 2026-11-18 | let522mj | 1(청크)·4(search_wiki)·6.3 | 쪽 맥락: Promote가 매뉴얼·노하우 그림 쪽마다 `⟦그림 pN⟧ 쪽 맥락(AI, 그림 기준): …`(정리본 제목 중 OCR로 확인된 것 ≤3개·각 40자, 정리본과 맞는 그림 라벨, 합 120자) → kb-chunker가 같은 쪽 본문 조각의 검색 머리 둘째 줄과 메타데이터 `page_context`로(인용 원문 아님). 쪽 정리본 조각은 매뉴얼·노하우에서 `evidence_kind:"FIGURE"`·인용 가능(original_text = 정리본), 규정·그림 속 글자는 인용 불가 유지. search_wiki 결과 `evidence_kind`·`page_context`, FIGURE snippet 머리 `[그림 기준 · AI 정리]` (yoyo0704 결정 11/18, fable 의견 반영) |
| 2026-11-18 | let522mj | 1(청크)·4(search_wiki) | 장(章): 매뉴얼·노하우 조각 메타데이터 `section`(쪽 첫 줄이 0 채운 장 번호 "04 …"·"04.…"이고 앞 장보다 클 때만 새 장. 단계 "1."·"①"은 장 아님. 번호 없는 쪽·글자 없는 쪽은 앞 장을 이음, 60자)·`section_pages`("시작-끝", 1부터). search_wiki `expand:"section"` → 응답 `expanded:[{doc_id, section, section_pages, items}]`(걸린 조각의 장 최대 2개, 장당 8조각, 쪽 순서, 재검증 통과·인용 가능분만), 결과 항목 `section`·`section_pages`. 필터 `section`은 내부용 (사용자 지적 11/18 '여러 쪽에 걸친 걸 왜 못 찾아') |
| 2026-11-18 | let522mj | 1(청크)·4(search_wiki) | 검색 텍스트(augmented_search_text)에서 마스킹 흔적 제거: 자리 표시 `[개인정보]`·`[주민등록번호]` 등(@hanaeum/pii PII_NAME)·Guardrail `{LICENSE_PLATE}` 형식, AI 그림 설명·쪽 맥락에서는 "가림 처리/가려져 있다" 문장(문장 단위, "마스킹된 상태로 표시" 같은 기능 설명은 남김)과 "/ 개인정보 /" 칸 이름. 다 지워지면 원래 텍스트. original_text는 그대로. related(관련 가능 문서)는 Rerank 1위가 근거 미달일 때 조각마다 점수 RELATED_MIN(0.10) 이상만 (HYBRID 대체 시 미적용) (사용자 지적 11/18: 가린 문서가 '개인정보' 검색에 걸림) |
| 2026-11-18 | let522mj | 4(MCP Tool)·11(외부 MCP) | 새 도구 `get_wiki_document {doc_id}` → `{doc_id, title, document_type, version, category_path, authority_status, freshness, page_count, pages:[{page(1부터), markdown, source: TEXT\|VISION, ai_summary?}], truncated?}`. 인자 `from_page`·`as_of`·`include_history`. published 게시본(마스킹)에서만 읽음 → 본문 sha256 = published_content_hash 확인. 폐지·대체 문서는 기본 NOT_FOUND(include_history면 historical). 응답에 effective_from/to·conditional. 응답 4만 자 넘으면 `next_page`로 이어 받기. 본문이 10자 미만인 캡처 쪽은 AI 그림 정리본(VISION). 그림 속 글자·설명 줄은 내보내지 않음. PUBLISHED·ACL 아님·없음은 모두 NOT_FOUND. mcp-search Lambda: env `BUCKET_PUBLISHED`, IAM `s3:GetObject` on published `legal/*`·`knowledge/*` (yoyo0704 요청 11/18) |
| 2026-11-18 | let522mj | 4(search_wiki) | related(관련 가능 문서)는 질의 핵심어(재구성 core·정리 질의, 군더더기 제외 2자 이상)가 조각 제목·본문·분류·경로에 하나라도 있고 인용 가능(quotable)할 때만. 점수 하한은 0.10 유지(0.20이면 11/17 실측 관련 질의 1위 0.13~0.26이 숨음) (yoyo0704 실측: '개인정보 관련 문서'에 과천 그림 설명이 걸림) |
| 2026-11-18 | let522mj | regulation-server·graph-server | 법령명 괄호 인식 확대: 「」 외에 『』, 그리고 [ ]·《》·〈〉는 바로 뒤에 조문 표기가 있을 때만(소제목 "[신청 방법]" 오탐 방지). 법령명 끝 "방법·요령·명령" 제외. `externalLawRefs(text, store)` → `[{law_name, clause?}]` (조문 표기 "제15조제1항" 정규화) 추가, `externalLaws`는 이름만(하위 호환). 그래프 인용 추출(LAW_MENTION)도 같은 괄호. 괄호 없는 법령명은 미인식(경계 모호) (사용자 지적 11/18: '[개인정보 보호법]제15조제1항'이 외부 법령 참고에 안 나옴) |
| 2026-11-18 | let522mj | 3(Finding, SegmentBuild) | SegmentBuild `LOW_OCR_CONFIDENCE`(MEDIUM) finding 제거. 95% 미만 쪽은 ImageDescribe가 Vision으로 다시 읽음 (사용자 결정 11/18 17시, yoyo0704 전달). `NO_TEXT`(HIGH)·구조 경고와 segments의 `avg_confidence`·`low_confidence`는 유지 |
| 2026-11-19 | let522mj | 3(Finding, SegmentBuild·GraphUpsert)·regulation-server | GraphUpsert(규정): 파싱 이슈가 있어도 승인된 게시라 조문 저장소·그래프에 적재하고 이슈 finding은 안내로 남김(`status=REVIEW_REQUIRED`, 게시는 계속). 구조 이슈(`STRUCTURE_ISSUES`: 번호 역행·중복·소속 없는 문장·빈 조문)면 `parse_ok=false`, 노하우 주장 재검토 표시를 생략하고 `CLAIM_REVIEW_SKIPPED`(LOW). 인용 이슈만이면 `parse_ok=true`. `putLaw`는 같은 버전 재적재 시 새 결과에 없는 조문 항목을 지움. `parse_reviewed` 입력 제거(설정하는 곳 없음). SegmentBuild 구조 안내를 번호 역행 외 모든 파싱 이슈로 확대(`STRUCTURE_{코드}`, 번호 역행은 `STRUCTURE_NUMBERING` 유지, 부칙 제외·최대 5건). `get_clause`: 현행 버전이 `parse_ok=false`면 과거 버전에만 있는 조문도 HISTORICAL 대신 UNVERIFIED (yoyo0704 11/19: 이슈가 있으면 KB엔 게시되고 조문 저장소·그래프엔 없는 규정이 생김) |
| 2026-11-17 | dhxorb96 | 7(Backend API) | 11/17 구현 반영: 업로드·게시 요청 역할 제한 제거(6.2), 위키 수정·의도한 삭제 확인, 업무 분류·질의 재구성·운영 도구·지식 상태·쪽 이미지 API, 상세 응답 필드 |
| 2026-11-20 | backend | 7·7.1 | `GET /v1/library/{id}/external-laws` 행 추가(clauses[]). 승인 결정·7.1에 PLATFORM_OPERATOR 자기 승인 예외 명시(코드·마이그레이션 008과 일치) (docs 최신화 공지) |
| 2026-11-20 | backend | 7(Backend API) | `POST /v1/documents/{id}/freshness/confirm` 추가 (Change Impact 재승인: 변경 없이 유효). 문서 `freshness_confirmed[]` |
| 2026-11-20 | backend | 7(Backend API) | `POST /v1/admin/impact/draft` 추가 (Change Impact 수정 초안, AI팀 계약 합의·총괄 승인). 위키 수정 요청에 `source`·`law`·`path`·`requested_by` |
| 2026-11-20 | backend | 7(Backend API) | `GET /v1/admin/evaluations` 추가 (프론트엔드팀 요청, 화면 08). 평가 실행기는 결과를 감사 기록 `EVALUATION_RUN`으로 남긴다. API 403 감사 기록 `detail`에 `roles`·`reason` 추가 |
| 2026-11-20 | data | 5(Regulations 키) | 조문 구조화 저장소 키 확정(구현 그대로), GSI 없음 |
| 2026-11-20 | data | 1(조문 ID)·2(Finding)·regulation-server | 가지번호 `제n-m조` = `ARTICLE:n-m`(parser·clausePath). 외부 법령 인식에 괄호 없는 한 낱말 법령명·`…규정` 추가, 행정규칙 `/행정규칙/` URL·고시 번호 해석. Finding `KNOWHOW_EXTERNAL_MISMATCH`·`KNOWHOW_EXTERNAL_SKIPPED` (AI팀 요청, 사용자 결정 11/20 외부 법령 대조). 사용자 문서 fixture M-002·M-003·MX-002·MX-003 (manifest `user_documents`) |
| 2026-11-20 | infra | 3·4·8 | prod 단일 환경(사용자 결정 11/20): 버킷 `[-닉네임]` 접미사 삭제, `HANAEUM_ENV=prod`, 공유 dev 문구 삭제. 모델 5.5 미허용 재확인(566533524321). 섹션 Owner yoyo0704 → infra |
| 2026-11-20 | data | 1(조문 ID) | 가지번호에 '의'가 붙은 `제n-m조의k` = `ARTICLE:n-m-k` (외국환거래규정 20개 조가 앞 조에 붙던 문제, parser·clausePath·본문 참조 해석) |
| 2026-11-20 | backend | 7(Backend API) | 사람 확인 필요 항목 노출(MX-002 외부 법령 불일치가 화면에 안 보임): `GET /v1/documents/{id}/review` `checks[]`{finding_id, code, severity, message, excerpt, fix_hint, evidence_ref}, `GET /v1/approvals` 카드 `checks_count`·`checks[]`(최대 5: code, text, message). 대상 코드 MEDIUM `KNOWHOW_EXTERNAL_MISMATCH`·`KNOWHOW_BASIS_MISMATCH`·`KNOWHOW_OUTDATED_CITATION`·`KNOWHOW_NO_BASIS`, LOW `KNOWHOW_EXTERNAL_SKIPPED`·`GUARDRAIL_SKIPPED`(확인하지 못함). 게시 잠금 아님. 문서보관함 검증 정보: 매뉴얼도 외부 법령 대조 결과를 basis에. 단계 라벨 `KNOWHOW_VALIDATION`='근거 대조', `EXTERNAL_LAW_CHECK`='외부 법령 대조'. 통지: 프론트·AI |
| 2026-11-20 | ai | 8(버전) | ADOT Node 자동 계측 0.14.0 추가 — 가이드·파이프라인 Runtime span 수집(P1 Observability) |
| 2026-11-20 | data | 평가 | AgentCore Evaluations 정답 데이터셋 `tests/fixtures/evaluations/agentcore-dataset.json` (AgentCore dataset 형식: scenario_id·turns[input, expected_response]·assertions·metadata, expected_trajectory 없음). 46건 = 근거 인용 20·정확 조문 20·검색 실패 판정 6, 질문에 기준일 포함 |
| 2026-11-20 | backend | 7(Backend API) | 평점(인기, 신뢰성과 분리, P1): `GET /v1/library`·`/v1/library/{id}`·`/v1/search` 문서 항목에 `rating`{avg(소수 1자리), count}(별점 0건이면 생략)·`useful_count`(0이면 생략), 상세에 `my_stars`(없으면 null). feedback 집계. 통지: 프론트 |
| 2026-11-20 | backend | 7(Backend API) | `GET /v1/admin/evaluations` denials에 Gateway 거부(AgentCore Policy) 합침: 사용자 Gateway vended logs(`GATEWAY_LOG_GROUP`)의 'Policy evaluation denied request' + 같은 trace_id 요청 이벤트에서 tool·역할만(인자·sub 버림). 항목에 `source`('API'|'GATEWAY'), 시간 역순 최대 50. 로그 읽기 실패 시 API 거부만. `POST /v1/admin/impact/draft` 초안 생성에 개정 규정 `law_name` 전달(AI팀 초안 인용에 규정 이름). 통지: 프론트·데이터QA·AI |
| 2026-11-20 | backend | 2(Finding)·단계 9 | 그림 개인정보 확인 fail-closed 해제(총괄 승인): PiiScan `PII_IMAGE_REVIEW`에 `details.boxes`(글자 개인정보 가림 수). TrustGate가 boxes=0 이고 `masked/segments/{쪽}.json` `figures[].people` 이 1개 이상·전부 `NONE`이면 `acknowledged{by:'system:image-describe'}`로 확인 처리 + 감사 `FIGURE_PII_CHECKED`. UNSURE·없음·읽기 실패·ImageDescribe 꺼짐이면 유지. ImageDescribe(인프라)가 `figures[].people` 기록. 통지: AI·인프라 |
