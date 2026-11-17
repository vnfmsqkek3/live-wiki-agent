# 참고 구현 패턴 · 문서 처리(IDP)·그래프·Bedrock KB·AgentCore·법령 전처리

> 용도: `01_architecture_spec.md`를 구현할 때 바로 가져다 쓸 **검증된 구현 패턴**과 **피해야 할 실수**.
> 근거: 팀이 검토한 사내 참고 구현 2건 (① 문서 처리 IDP 파이프라인: OCR → LLM 분석 → 그래프·벡터 적재, AWS 운영 이력 있음 ② 한국 법령 RAG PoC: 법령 계층 파싱·하이브리드 검색). 이 문서만 읽어도 이해되도록 내용을 옮겨 적었다.
> 표기: **[검증]** 참고 구현 코드에서 동작 확인된 패턴 / **[권장]** 참고 구현의 한계를 보완해 팀이 정한 방식 / **[확인 필요]** 배포 전 AWS 공식 문서·계정에서 확인.
> 01과 충돌하면 01이 우선이고, 01에 없는 구현 세부는 이 문서를 따른다.

---

## 0. 한눈에 보기

| 영역 | 채택 패턴 | 담당 |
|---|---|---|
| 업로드 | Presigned URL(SigV4·리전 엔드포인트) → Quarantine S3 → EventBridge → SQS(+DLQ) → Step Functions | dhxorb96(API) · yoyo0704(인프라) |
| 악성·PII | GuardDuty Malware Protection for S3 + 파일 구조 검사 + Guardrails/정규식 PII | dhxorb96 · yoyo0704 |
| 변환·OCR (사용자 결정 11/17) | 모든 형식을 PDF로 변환(ConvertToPdf) → 모든 쪽 OCR. 디지털 글자는 본문에 쓰지 않음. TXT·MD만 글자 그대로 | yoyo0704(변환·OCR) · let522mj(본문) · dhxorb96(라우터) |
| OCR | PaddleOCR on SageMaker **Async** 엔드포인트, 10페이지 단위 병렬, S3 마커 병합, **confidence 보존** | yoyo0704 |
| 분류 | 고정 택소노미 + `temperature 0` + 구조화 출력, 실패 시 `REVIEW_REQUIRED` | dhxorb96 |
| 승인 | Step Functions `waitForTaskToken`, 사람 승인 API가 토큰 반환 | dhxorb96 |
| 색인 | Published S3 + `.metadata.json` 사이드카 → **Bedrock KB** Custom Transformation Lambda → OpenSearch Serverless | let522mj |
| 검색 | **Bedrock KB Retrieve** HYBRID + 메타데이터 필터 + Rerank, 서버에서 ACL 필터 주입 | let522mj |
| 그래프 | Neptune openCypher(SigV4), 결정적 ID, `UNWIND … MERGE`, 배치 50, 쓰기 직렬화 | let522mj |
| Agent | **AgentCore Runtime**(Strands TS) + **Gateway**(MCP Tool = Lambda) + Identity·Policy·Observability·Evaluations | dhxorb96 · yoyo0704 |
| 법령 파싱 | 결정적 정규식 상태 머신 + 태그 분리 + Unicode 정규화, 항 단위 청크 + 상위 경로 헤더 | let522mj |

---

## 1. 문서 처리 파이프라인 (Step Functions)

### 1.1 흐름

```
[업로드] Presigned PUT → S3 quarantine/{doc_id}/original.{ext}
  → EventBridge "Object Created" → SQS(TriggerQueue, DLQ maxReceiveCount 3)
  → Lambda type-detection (MIME·확장자·매직바이트, 허용: PDF·DOCX·HWPX·PNG/JPG)
  → Step Functions Standard "hanaeum-mvp-sfn-ingest" (timeout 24h)

Step Functions
 1. MalwareCheck      GuardDuty S3 스캔 결과 태그 확인 (Wait→Check 폴링) ─ 탐지 시 QUARANTINED 종료
 2. FileStructureCheck PNG/PDF 메타데이터·임베디드 스크립트 검사 (A-002)
 3. ParallelPreprocess (Parallel)
      (앞) ConvertToPdf     원본 → work/document.pdf. PDF 복사, PNG·JPG 1장=1쪽, DOCX LibreOffice(HWPX는 변환 시험 통과 시). TXT·MD는 변환 안 함
      a. TextLayerExtract  document.pdf가 있으면 쪽 수만 기록, 모든 쪽 OCR 대상 (TXT·MD만 글자 그대로). 디지털 글자는 추출하지 않음. 없으면(배포 전) 기존 판정
      b. PageRender        document.pdf 모든 쪽 → PNG (가로 2000px)
 4. OcrIfNeeded         모든 쪽 OCR (2장)
 5. SegmentBuild       쪽별 OCR 결과 → S3 segments/{page:04d}.json (숨은 글자 비교 없음: OCR 본문엔 안 보이는 글자가 들어오지 않음)
 6. PiiScan            ① 정규식·체크섬·금융 사전 → ② Guardrails ApplyGuardrail(모델 추론 아님) → 마스킹
                      → 불확실 구간이 남으면 REVIEW_REQUIRED (사람 검토), 원문은 모델에 보내지 않음
                      → ③ LLM 문맥 검토는 **마스킹된 텍스트에만** (01 §4.3 3차를 팀 결정으로 순서 조정)
 7. InjectionScan      Prompt Injection 탐지 (마스킹된 텍스트, 문서 텍스트는 untrusted)
 8. Classify           기반/노하우 + 문서 유형 (3장)
 9. TrustGate          Registry 대조·규정 충돌 → PASS / REVIEW_REQUIRED / QUARANTINED
10. WaitForApproval    .waitForTaskToken — 승인 API가 SendTaskSuccess/Failure
11. Promote            quarantine → published 복사 (마스킹본) + .metadata.json 생성
12. KbIngest           StartIngestionJob → 상태 폴링 → COMPLETE 확인 (4장)
13. GraphUpsert        승인된 관계만 Neptune 적재 (5장)
14. Finalize           DynamoDB 상태 PUBLISHED, 감사 이벤트
```

### 1.2 운영 규칙 [검증]

| 항목 | 규칙 |
|---|---|
| 재시도 | Bedrock 호출 태스크: `ThrottlingException`·`TooManyRequests`·`ServiceUnavailable`에 interval 10s, maxAttempts 2, backoff 2, jitter FULL |
| 실패 처리 이중화 | 각 태스크 `Catch` → `HandleError`(DynamoDB에 단계·오류 기록) → `Fail`. 추가로 EventBridge가 SFN `FAILED/TIMED_OUT/ABORTED`를 받아 failure-catcher Lambda 실행 (Catch를 우회한 실패까지 기록) |
| 비동기 대기 | 외부 비동기 작업(OCR, KB Ingestion, Malware 스캔)은 `Wait(10~15s) → Check → Choice` 루프 |
| 단계 상태 | DynamoDB `WF#{id}/STEP#{name}`: `status, started_at, ended_at, error` — 화면의 "n/4 단계" 진행 표시와 Observability에 사용 |
| 동시성 예산 | 동시 분석 수 상한(기본 3)을 Bedrock 쿼터에 맞춰 조정. [권장] 조회 후 비교 방식은 경쟁 조건이 있으므로 DynamoDB 조건부 쓰기(카운터 `< limit`)로 확보 |
| DLQ | **모든 SQS에 DLQ** (참고 구현에서 DLQ 없는 큐가 조용한 데이터 손실 원인) |
| 멱등성 | 모든 단계 출력은 `{doc_id}/{step}/` 결정적 S3 키에 저장 → 재실행해도 결과 동일 |

### 1.3 [권장] 참고 구현보다 강화할 점

| 참고 구현 | Living Wiki |
|---|---|
| 디지털/스캔 무조건 OCR + 페이지 전체 Vision LLM 분석 (비용 큼) | 모든 쪽 OCR은 같음(사용자 결정 11/17: 디지털 글자가 깨지거나 다른 글자로 바뀐 PDF, 섞인 쪽의 사진 속 글자, 숨긴 글자를 한 번에 해결). Vision LLM 분석은 그림 쪽만(선택). 참고: megazone-idp는 DOCX를 LibreOffice로 PDF 변환, 디지털 글자·OCR·이미지를 모두 모델에 넣음 |
| 격리·악성·PII·승인 단계 없음 | 1.1의 2·6·7·9·10단계 신설 |
| 분류 실패 시 "미분류"로 계속 진행 | 분류 실패·저신뢰는 `REVIEW_REQUIRED`로 사람 검토 (P0 데이터 분류) |
| 엔티티 추출 실패 시 빈 리스트 반환 (조용한 누락) | 실패는 Findings에 기록하고 단계 상태 FAILED |

---

## 2. OCR (PaddleOCR)

| 항목 | 방식 |
|---|---|
| 배포 [검증] | SageMaker **Async Inference** 엔드포인트, `ml.g5.xlarge`, `maxConcurrentInvocationsPerInstance=1`, `InvocationTimeoutSeconds=3600`, 결과는 SNS 성공/실패 토픽 |
| 비용 절감 [검증] | Scale-to-zero (min 0 / max 1). 호출 직전 `UpdateEndpointWeightsAndCapacities(DesiredInstanceCount=1)`로 확장. 축소는 CloudWatch `ApproximateBacklogSizePerInstance < 0.1` 10회 연속(1분 간격, 누락 데이터 BREACHING) → SNS → Lambda가 Desired=0 |
| 대안 [검증] | CPU 경량 모델(PP-OCRv5)을 Lambda(2048MB, 10분)로 돌리는 방식도 동작함. GPU 콜드스타트를 피하려면 데모용으로 고려. 01 설계는 SageMaker이므로 기본은 SageMaker |
| 분할 [검증] | 페이지 수를 센 뒤 10페이지 단위 payload(`chunk_index, start_page, end_page`) → Step Functions DistributedMap |
| 병합 [검증] | 청크 결과 `ocr/chunks/chunk_{0000}.json`, 실패 시 `.failed` 마커. 병합기는 S3 목록만 근거로 `page_index` 정렬 후 `ocr/result.json` 작성 → 멱등 |
| 렌더링 [검증] | OCR 입력은 가로 2000px. Vision LLM 입력 이미지는 150 DPI, 3.75MB 초과 시 축소 |
| 언어 | `lang=korean` 계열 모델. 모델·컨테이너 버전은 설치 시 최신 안정판 조회 |
| 성능 참고 [검증] | VL(레이아웃) 모델: 페이지당 약 14초, 모델 약 12GB로 GPU당 프로세스 1개 |

### 2.1 출력 스키마 (팀 표준)

```json
{
  "doc_id": "…", "model": "paddleocr-…", "model_version": "…", "page_count": 3,
  "pages": [{
    "page_index": 0, "width": 2000, "height": 2828, "source": "ocr | text_layer",
    "blocks": [{
      "block_id": "p0-b3", "label": "paragraph | title | table | list",
      "text": "제12조(승인 기준) ① …", "confidence": 0.97,
      "bbox": [x1, y1, x2, y2], "reading_order": 3, "table_id": null
    }]
  }]
}
```

- **[권장] `confidence`를 반드시 보존한다** (참고 구현은 변환 중 버렸음). 블록 confidence < 0.85 또는 페이지 평균 < 0.9면 "저신뢰 페이지"로 OCR·PII 검토 화면에 표시 (01 §4.1 3단계, 기준치는 실측 후 조정).
- bbox는 PII 마스킹을 이미지에도 적용하기 위해 필요하다 (01 §4.3).
- **OCR 결과·segments·중간 산출물은 원본 등급**이다. 모두 quarantine 버킷 `{doc_id}/work/` 아래에 두고, 모델 호출 Role은 마스킹 완료본(`{doc_id}/masked/`)만 읽는다.

---

## 3. 분류 (기반 / 노하우)

[검증된 방식을 Living Wiki용으로 조정]

| 항목 | 방식 |
|---|---|
| 모델 | Haiku 5.5 기본, 저신뢰 시 Sonnet 5.5 (01 §9) |
| 설정 | `temperature 0`, 구조화 출력(Strands structured output + zod 스키마) |
| 입력 | 본문 앞 6,000자 + 파일명 + 업로드 시 선택한 공개 범위(힌트) |
| 택소노미 | **최상위 고정**: `document_type ∈ {REGULATION, KNOWHOW, MANUAL}` → 하위 `업무(여신·수신·외환·…)` → 세부. 병렬 실행끼리 새 카테고리를 서로 못 보므로 최상위를 고정해야 분류가 흩어지지 않음 |
| 출력 | `{document_type, business_path[], tags[], confidence, rationale}` |
| 실패 | 파싱 실패·`confidence < 0.7` → `REVIEW_REQUIRED` (작성자가 분류 수정) |

---

## 4. Bedrock Knowledge Base 적극 활용

Living Wiki의 검색·색인은 **Bedrock KB를 중심**으로 구성한다. 직접 OpenSearch에 쓰지 않고 KB의 Ingestion·Retrieve를 쓴다 (예외: 조문 ID 정확 조회는 DynamoDB/구조화 저장소 직접 조회).

### 4.1 KB 구성

| 항목 | 값 |
|---|---|
| KB | `hanaeum-mvp-kb-wiki` **1개 · 벡터 인덱스 1개**, 데이터 소스 2개: `legal`(법령·규정), `knowledge`(노하우·매뉴얼). 01 §8의 3개 논리 인덱스(legal-clauses, wiki-knowledge, official-manuals)는 물리 인덱스가 아니라 메타데이터 `index_group`으로 구분 (팀 결정: KB 저장 설정은 인덱스 1개만 지정 가능) |
| 벡터 저장소 | OpenSearch Serverless (Hybrid 검색 지원) |
| 임베딩 | Titan Text Embeddings V2 (1024차원) |
| 데이터 소스 | **Published 버킷만** (`s3://…-published/legal/`, `…/knowledge/`) |
| 청킹 | `chunkingStrategy=NONE` + Custom Transformation Lambda `POST_CHUNKING` (법령 계층 청킹, 6장) + intermediateStorage S3 |
| 메타데이터 | 원본 옆 사이드카 `{file}.metadata.json` |

```json
{ "metadataAttributes": {
    "doc_id": "SYN-LOAN-001", "document_type": "REGULATION",
    "index_group": "legal-clauses", "authority_status": "VERIFIED", "freshness": "CURRENT", "lifecycle": "PUBLISHED",
    "law_id": "SYN-LOAN", "revision_id": "2026-11-01",
    "effective_from": 20261101, "effective_to": 99991231,
    "acl_groups": ["ALL"], "dept": "여신", "approval_id": "APR-…", "content_hash": "sha256:…" } }
```

- **[권장] 날짜는 `yyyymmdd` 숫자**로 저장한다 (참고 구현은 문자열이라 범위 필터 불가). → `effective_from <= as_of <= effective_to` 필터 가능.
- 청크 단위 메타데이터(`provision_id`, `provision_path`, `status`)는 Custom Transformation Lambda가 청크마다 추가한다.

### 4.2 Ingestion

| 규칙 | 내용 |
|---|---|
| 트리거 | 승인 후 Promote 단계에서만 `StartIngestionJob` (Quarantine 데이터는 KB에 절대 안 들어감) |
| 완료 확인 [검증된 교훈] | 참고 구현은 색인을 워크플로 밖에서 비동기로 해서 "워크플로 성공인데 벡터 없음" 사고가 났다. **Ingestion Job이 COMPLETE이고 실패 문서 0건일 때만** PUBLISHED로 전환 |
| 동시성 | 데이터 소스당 Ingestion Job은 동시에 1개 [확인 필요] → SQS로 모아 직렬 실행 |
| 삭제·재검증 | 문서 폐지·SUPERSEDED 시 S3에서 제거 또는 메타데이터 갱신 후 재동기화. 삭제 실패는 3회 재시도 후 오류로 중단 (참고 구현에서 삭제 후 인덱스 잔존 사고) |
| Terraform 주의 [검증] | 데이터 소스가 `RETAIN`이면 destroy 전에 데이터 소스를 먼저 지워야 함 |

### 4.3 Retrieve (검색)

```
사용자 질의
 → Backend: JWT에서 그룹·부서 추출 → 필터 생성 (LLM이 필터를 만들지 않음)
     filter = andAll[
       orAll[ listContains(acl_groups, "ALL"), listContains(acl_groups, g1), listContains(acl_groups, g2) … ],
       equals(lifecycle, "PUBLISHED"), notEquals(authority_status, "REJECTED"),
       lessThanOrEquals(effective_from, as_of), greaterThanOrEquals(effective_to, as_of),
       (선택) in(index_group, ["legal-clauses", "wiki-knowledge"]) ]
     ※ 배열 메타데이터는 `in`이 아니라 `listContains`. 사용자 그룹이 1개면 orAll 대신 단일 조건 (orAll은 2개 이상 필요)
 → KB Retrieve: overrideSearchType=HYBRID, numberOfResults=50, filter
     + rerankingConfiguration(Cohere Rerank 3.5) → 15  [확인 필요: us-east-1 지원·설정 형식]
 → 재검증(authority·effective·ACL) → 추천 5 → Sonnet 종합 + 인용 → Guardrails 출력 검사
```

- 조문 번호가 들어간 질의(`제12조제2항…`)는 KB 검색 전에 **Exact Lookup**(구조화 저장소)을 먼저 한다 (01 §8.7).
- **KB 호출은 AgentCore Gateway의 MCP Tool(`search_wiki`, `retrieve_evidence`) 안에서만** 한다. Agent가 KB를 직접 호출하지 않는다 → ACL 필터를 서버가 강제.
- **사용자 질의·Tool 인자도 모델 호출 전에 PII 검사**(정규식 + ApplyGuardrail)하고, 탐지 시 치환 또는 차단한다. 캐시·Trace에도 원문을 남기지 않는다.
- Tool은 KB 결과를 모델에 넘기기 전에 DynamoDB의 **현재 상태**(PUBLISHED·ACL·버전·content_hash)를 다시 확인한다. KB 동기화가 늦어 폐지 문서가 남아 있어도 노출되지 않게 하기 위함이다.
- 필수 인덱스 조건 [확인 필요]: HYBRID 검색에는 OpenSearch 인덱스에 filterable text 필드 매핑이 필요하다. M0에 1건 색인 → HYBRID Retrieve 성공을 먼저 확인한다.

### 4.4 [선택] KB GraphRAG

Bedrock KB는 Neptune Analytics를 벡터 저장소로 쓰는 GraphRAG 구성을 지원한다 [확인 필요]. 01 설계는 Neptune(조문-노하우 관계, Change Impact)을 별도로 두므로 **MVP는 5장 방식(직접 적재)을 유지**하고 GraphRAG는 P2 검토로 둔다.

---

## 5. 그래프 적재 (Neptune)

| 항목 | 방식 |
|---|---|
| 엔진 [검증] | Neptune Serverless, IAM 인증. 접속은 HTTPS `POST /openCypher` + SigV4(`neptune-db`) — TS에서는 `@aws-sdk/signature-v4`로 서명 |
| 노드·관계 | 01 §5·§7 Graph 모델 사용 (LAW_VERSION, ARTICLE_VERSION, CLAUSE_VERSION, WIKI_VERSION … / REFERENCES, CITES, SUPERSEDES, IMPACTS …) |
| ID [검증] | 결정적 ID만 사용. 조문: `SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:2`, 노하우: `{doc_id}@{version}`, 엔티티: `sha256(lower(name))[:16]` |
| 쓰기 [검증] | `UNWIND $items AS i MERGE (n:Label {id:i.id}) SET n += i.props` 배치 50건. 재실행해도 결과 동일 |
| 직렬화 [검증] | 쓰기는 Step Functions Map 동시 1(또는 Lambda reserved concurrency 1). 동시 쓰기 충돌·ConcurrentModification 회피 |
| 재시도 [검증] | 500/503/429·빈 응답·연결 오류에 백오프 최대 5회 |
| 삭제 [검증] | 문서 단위 `MATCH (n {doc_id:$d}) DETACH DELETE n`. 대량 삭제는 관계부터 `LIMIT` 배치. **[권장] 모든 노드·엣지에 `doc_id` 속성** (참고 구현은 일부 노드에 없어 문서 단위 삭제 불가) |
| 승인 게이트 | 승인 전 관계는 DynamoDB에 `candidate`로만 보관, 승인 후 Neptune 게시 (01 §7.2) |
| 엣지 속성 | `evidence_span, source_version, confidence, reviewer_status, valid_from, valid_to` (01 §7) |

### 5.1 벡터 → 그래프 확장 [검증된 패턴]

KB 검색 결과 청크의 `provision_id`로 Neptune에서 `(:CLAUSE_VERSION)<-[:CITES]-(:WIKI_VERSION)` 및 `REFERENCES` 1~2홉을 조회해 관련 조문·노하우를 확장 (최대 30건, 원 청크 제외). 본문은 다시 KB/S3에서 가져온다. Change Impact(규정 개정 → 영향 노하우)도 같은 역방향 탐색을 쓴다.

---

## 6. 한국 법령 전처리

### 6.1 수집

| 항목 | 방식 |
|---|---|
| 공개 법령 | [권장] 국가법령정보센터 Open API(XML)로 법령ID·공포번호·시행일·개정 이력 함께 수집 [확인 필요: 엔드포인트·인증키 발급]. 참고 PoC는 Word 수동 추출이라 버전 관리가 불가했음 |
| 합성 규정 | 하나은행 가상 규정(가상 데이터)은 공식 법령과 같은 표기 규칙으로 작성 (6.3 엣지 케이스 포함) |
| 중간 포맷 | **JSON만**. CSV는 쓰지 않는다 (참고 PoC에서 CSV 단계에 `<개정` 이후 잘림, 조 경계 섞임 발생) |

### 6.2 파싱 규칙 (결정적 상태 머신)

전처리: Unicode **NFC** 정규화 → `ㆍ`(U+318D)·`·` 통일 표기 보존(원문 glyph 별도 저장) → 줄 단위 처리. 원문 텍스트는 불변 보관.

| 계층 | 정규식 (TS, `u` 플래그) | 주의 |
|---|---|---|
| 편/장/절 | `^제(\d+)(편\|장\|절)\s+(.+)$` | 없을 수 있음 |
| 조 | `^제(\d+)조(?:의(\d+))?(?:\(([^)]*)\))?\s*(.*)$` | **`제N조의M`을 먼저** 인식. 줄 머리에서만 매칭 (본문 중 "제N조" 인용으로 잘못 분할 방지) |
| 항 | `^([①-⑳])\s*(.*)$` → 번호 = `codePoint - 0x2460 + 1` | ①~⑳ 지원 (참고 PoC는 ⑩까지만 처리해 ⑪이 ⑩에 합쳐짐) |
| 호 | `^(\d+)(?:의(\d+))?\.\s+(.*)$` | 호 가지번호 `1의2.` 포함 |
| 목 | `^([가나다라마바사아자차카타파하])\.\s+(.*)$` | **14자로 제한** (`[가-힣]`이면 아무 한글+마침표를 목으로 오인) |
| 개정·신설 태그 | `<(개정\|신설)\s+((?:\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.,?\s*)+)>` | **여러 날짜** `<개정 2013. 12. 3., 2016. 10. 5.>` 처리 |
| 삭제 | `^(?:제\d+조(?:의\d+)?\|[①-⑳]\|\d+\.)\s*삭제\s*<(\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.)>` | `삭제 <날짜>`와 `삭제<날짜>` 둘 다. `status=DELETED, deletion_date` |
| 조 꼬리 태그 | `\[본조신설\s+([^\]]+)\]`, `\[시행일\s*:\s*([^\]]+)\]`, `<종전의\s+([^>]+)에서\s+이동[^>]*>` | 본문에서 분리해 메타데이터로 |
| 별표·별지 | `[<\[](별표\|별지)\s*(?:제\s*)?(\d+)(?:호)?(?:의(\d+))?(?:\s*서식)?[>\]]` | 참조로 추출, 별표 본문은 별도 청크 |
| 부칙 | `^부\s*칙(?:\s*<([^>]+)>)?` 이후는 `supplementary_provision` | 부칙 제N조는 본칙과 별도 네임스페이스 |
| 참조 | `「([^」]+)」\s*제(\d+)조(?:의(\d+))?(?:제(\d+)항)?(?:제(\d+)호)?(?:([가-하])목)?`, 상대참조 `전항\|전조\|같은 조\|같은 항\|각 호\|다음 각 목` | 대상 ID 해석은 코드에서 검증 (LLM이 참조 내용을 지어내지 않게) |

- 하위 계층이 있으면 상위 텍스트는 첫 줄(제목·도입문)만 상위 노드에 둔다 [검증].
- 파서 결과는 zod 스키마로 검증하고 누락·중복·고아 노드·번호 역행은 QA 큐로 보낸다 (01 §7).

### 6.3 테스트 엣지 케이스 (실제 법령에서 관찰) [검증]

| 케이스 | 예 |
|---|---|
| 항 11개 이상 | ⑪, ⑫ … |
| 여러 날짜 개정 태그 | `<개정 2013. 12. 3., 2016. 10. 5.>` |
| 연속 태그 | `<종전의 제9항에서 이동 2015. 6. 24.><개정 …>` |
| 조 끝 태그 | `[본조신설 2013. 12. 3.]`, `[시행일 : 2015. 4. 16.] 제73조제1항ㆍ…` |
| 삭제 표기 | `11. 삭제<2013. 12. 3.>`, `⑤ 삭제 <2025. 1. 1.>` |
| 하위법령 별표 참조 | `시행령 [별표 1의2] 제2호다목` |
| 불규칙 띄어쓰기 | `제1호 부터`, `「…법」제2조` |
| 가지번호 | `제14조의2` ≠ `제14조제2항` |

이 케이스는 `tests/fixtures/legal/`의 L-001 계열 합성 법령에 모두 넣는다.

### 6.4 청킹·인덱스

| 항목 | 방식 |
|---|---|
| 단위 [검증] | 항 1개 = 청크 1개. 항이 없으면 조 전체. 긴 항은 호·목 경계에서 분할 (01 §8) |
| 문맥 헤더 [검증·보강] | 각 청크 앞에 `[법령명 · 시행일 · 장/절 제목 · 제N조(제목) · 제M항]` 헤더. 참고 PoC는 법령명·시행일이 빠져 다법령 구분 불가 → 반드시 포함 |
| 원문 분리 | `original_text`(인용용)와 `augmented_search_text`(헤더 포함, 검색용) 분리 (01 §8) |
| 임베딩 대상 [검증된 교훈] | **임베딩 입력이 실제 본문인지 테스트로 확인**. 참고 PoC는 필드 경로 버그로 "장번호+장제목"만 임베딩되어 벡터 검색이 무력화됨 |
| 길이 | Titan V2 토큰 한도 기준으로 계산 (다른 모델 토크나이저로 세지 않음) |
| 키워드 필드 | 번호 필드(조·항·호·목, provision_id)는 keyword로 정확 매칭, 본문은 한국어 분석기(Nori) [확인 필요: KB 관리형 OpenSearch Serverless 인덱스의 분석기 설정 가능 여부] |
| 재색인 | 인덱스 삭제 후 재생성 금지. KB 재동기화 또는 alias 교체 |

### 6.5 검색 실패 처리

참고 PoC는 결과 0건이면 검색 범위만 넓혀 재시도하고 "찾을 수 없음"만 반환했다. Living Wiki는 01 §8.7 복구 흐름(Exact Lookup → 상위·상대참조 확장 → 과거 버전·삭제·부칙 → 공식 API)과 상태(`FOUND / HISTORICAL / DELETED / NOT_FOUND_VERIFIED / UNVERIFIED`)를 따른다. **근거 없이 참조 내용을 요약하게 하는 프롬프트는 금지** (환각 원인).

---

## 7. AgentCore 적극 활용

| 구성 | 사용 방식 |
|---|---|
| Runtime | Strands Agents(TS) 컨테이너 호스팅, 세션 격리. **[검증된 교훈] 이미지가 arm64 고정** → 빌드는 Graviton(arm64) 또는 `docker buildx --platform linux/arm64` |
| Gateway | MCP 서버 6종(01 §10.4)을 Gateway Target(Lambda)으로 등록. Agent는 Gateway Tool만 호출 |
| Identity | 사용자 JWT(Cognito) 컨텍스트를 Runtime → Gateway → Tool Lambda로 전달. Tool Lambda는 JWT를 재검증 |
| Policy | Tool별 deny-by-default. `publish_wiki`·`approve_regulation`은 Agent에 노출하지 않거나 역할 조건으로 Deny (01 §11) |
| Observability | Runtime·Gateway Trace를 CloudWatch(OTel)로. trace_id를 DynamoDB 워크플로 단계와 연결 → 관리자 화면 08 |
| Evaluations | Golden Dataset(60건)으로 배포 전 오프라인 평가 + 운영 샘플 평가 분리 |
| Memory | 사용하지 않음 (01 §11 범위 제외) |

공통: 모델 ID·리전은 **환경변수/SSM**으로만 주입 (참고 구현은 하드코딩으로 리전 이식 불가).

---

## 8. 운영 교훈 (그대로 체크리스트로 사용)

| # | 교훈 | 대응 |
|---|---|---|
| 1 | Presigned URL을 글로벌 엔드포인트·SigV2로 만들면 307 리다이렉트 → 브라우저에서 "CORS 오류"로 보임 | S3 클라이언트에 `region` 명시, SigV4, virtual-hosted 주소 |
| 2 | 백엔드·Agent가 같은 DynamoDB 아이템을 다른 스키마로 검증해 null 필드에서 런타임 크래시 | `packages/schemas`(zod) 공유 스키마 하나만 사용 |
| 3 | 사용자 ID를 헤더로 받아 검증 없이 신뢰 (IDOR) | JWT에서만 사용자 식별, CORS `*` + credentials 금지 |
| 4 | CloudFront용 WAF는 us-east-1 필수 | 해커톤 리전과 동일하므로 문제없음, 서울 전환 시 주의 |
| 5 | VPC lookup 의존으로 첫 배포 실패 | Terraform은 network 모듈 출력 참조, 순서 의존 최소화 |
| 6 | 색인 비동기로 "성공인데 데이터 없음" | 4.2 완료 확인 |
| 7 | 삭제 후 인덱스·그래프 잔존 | 4.2·5장 삭제 규칙 |
| 8 | 자격증명·엔드포인트 평문 하드코딩 | Secrets Manager·환경변수만, 커밋 전 secret 스캔 |
| 9 | 쓰기 경합 | 쓰기 Lambda reserved concurrency 1 또는 Map 동시 1 |
| 10 | 단계별 OCR·LLM 결과를 버리고 최종만 저장 | 단계 산출물 S3 보존 → 재처리·디버깅·감사 |

---

## 9. 가져오지 않는 것

| 항목 | 이유 |
|---|---|
| 자체 벡터 DB(LanceDB 등)·Rust 토크나이저·S3 Express | Bedrock KB + OpenSearch Serverless로 대체 |
| 영상·음성·웹크롤링·CAD 처리 | 범위 밖 |
| QA 쌍을 색인 단위로 쓰는 방식 | 법령은 원문 조문 단위 인용이 필요 (근거 인용 정확도 기준) |
| 질의 임베딩 없이 BM25 1위 문서 벡터로 k-NN | 검색 품질 저하. KB HYBRID 사용 |
| 다른 모델 토크나이저로 한국어 길이 계산 | 한도 불일치 |
| temperature 1.0 답변 생성 | 규정 답변은 낮은 temperature(0~0.3) |
