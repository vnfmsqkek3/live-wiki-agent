# Living Wiki 기술 정의서

> 원본: `공통문서/Living_Wiki_Final_Integrated_Architecture.pdf` (작성 2026-11-12, 실제 45쪽 · 꼬리말 번호 31까지)
> 원본의 규제·서비스 지원 정보는 실제 배포 시점에 재검증해야 한다.

---

## 0. 문서 안내

| 항목 | 내용 |
|---|---|
| 원본 PDF | `공통문서/Living_Wiki_Final_Integrated_Architecture.pdf` |
| 해커톤 기본 리전 | us-east-1 |
| 데이터 원칙 | 실제 은행 데이터 반입 금지. 합성 문서만 사용 |
| 함께 볼 문서 | `공통문서/Living_Wiki_MVP_DoD_Demo_Scenarios.pdf` (완료 기준), `공통문서/혁신금융서비스 1차 신청 아키텍처.pdf` (규제 원칙) |

읽는 순서

> 팀 판단: 아래 읽는 순서는 원문에 없는 팀 가이드다.

| 담당 | 우선 읽을 장 |
|---|---|
| 전원 | 1, 2, 3 |
| 인프라·IaC | 2, 11, 12, 14, 15 |
| 데이터·검색 | 4, 5, 6, 7, 8, 13 |
| Agent·앱 | 4, 9, 10, 11, 16 |

---

## 1. 서비스 개요

Living Wiki는 직원의 업무 노하우와 공식 규정을 업로드·검증·연결하는 금융기관 내부 지식 관리 서비스다. 태그·검색으로 필요한 지식을 찾아주고, 규정이 개정되면 관련 Wiki를 검토·갱신하도록 돕는다.

### 1.1 데이터 구분

| 구분 | 내용 | 검증 |
|---|---|---|
| 기반 데이터 | 법령·내부 규정·승인 매뉴얼. 업무 판단의 공식 기준 | 출처·시행일·버전·승인 상태 검증 필수 |
| 노하우 데이터 | 실무 경험·사례·체크리스트 | 작성자·적용 조건·근거 연결, 규정 충돌 검증 |

- 핵심 구조: 기반 데이터로 노하우를 검증한다. 기반 데이터가 바뀌면 관련 노하우도 재검증한다.
- 통제 원칙: AI가 법적 효력·진실성을 단독 확정하지 않는다. 위험도별 사람 승인, 근거·불확실성을 표시한다.
- 노하우 상태: 검증 완료 / 조건부 검증 / 검토 필요 / 반려 / 재검증 필요
- 공식 규정에 명시되지 않은 경험을 자동으로 허위 판정하지 않는다. 재현성·적용 조건·위험도를 확인한다.

데이터 분류·노하우 검증 프로세스 (원문 도식)

```
업로드 → 분류
  ├─ 기반 데이터 → 출처·시행일·승인본 검증 → Trust Gate
  │               └─ (병행) 개정·폐지 감지 → 관련 노하우 재검증
  └─ 노하우 데이터 → 절차·적용조건 구조화 → 공식 근거와 충돌 대조
                  → Trust Gate·사람 승인
                  → 검증된 Wiki 게시 | 검토·수정·차단
```

### 1.2 핵심 엔진

| 엔진 | 목적 | 핵심 처리 | 사용자 가치 | 통제 원칙 |
|---|---|---|---|---|
| Trust Gate | 지식 유입 통제 | 진위·악성·PII·규정 충돌 검증 후 승인 | 출처·민감정보·규정 충돌 확인 | AI는 공식성을 선언하지 않음 |
| Change Impact | 지식 최신성 유지 | 규정 개정 → 영향 노하우 추적 → 수정안 → 재승인 | 규정 변경 시 영향 Wiki와 수정안 제공 | 승인 없이 자동 게시 금지 |
| Trust-aware Retrieval (Explainable Recommendation) | 신뢰 기반 검색 | 권한·유효기간 필터 → 재랭킹 → 근거 기반 답변 | 권한에 맞는 추천·근거·업무 가이드 | 공식 규정 우선, 출처 명시 |
| Knowledge Governance | 이력 관리 | 버전·유효기간·담당자·감사 이력 | 버전·유효기간·담당자·감사 이력 | 승인본만 게시·인덱싱 |

### 1.3 기존 Wiki 대비 차별화

| 위험 | 해결 방식 |
|---|---|
| 위조·악성 문서 유입 | Quarantine, 악성코드·PII·Prompt Injection 탐지, 공식 Registry 대조 후 승인 |
| 허위 노하우 확산 | 공식 기반 데이터와 충돌·조건·예외 검증, 검토 필요/반려 상태 운영 |
| 오래된 지식 사용 | 시행일·개정·폐지 추적, 참조 관계 기반 영향 분석 및 재검증 |
| 한국 법령 검색 실패 | 조·항·호·목 파싱, 상대참조·삭제·부칙·과거 버전 검색 복구 |
| 근거 없는 AI 답변 | ACL 사전 필터, Hybrid Search, Rerank, 공식 출처 인용 및 검증 상태 |
| 승인 없는 AI 게시 | AgentCore Identity + Policy로 MCP 도구 권한 강제, 사람 승인 |
| AI 품질 불명확 | AgentCore Evaluations와 합성 Golden Dataset으로 인용·검색·보안 평가 |

### 1.4 불변 조건

1. 검증 전 원본은 Quarantine에 격리하며 게시용 Knowledge Base에 색인하지 않는다.
2. 문서 유형, 공식성, 최신성을 분리한다.
   - 유형: `REGULATION` / `KNOWHOW` / `MANUAL`
   - 공식성: `VERIFIED` / `UNVERIFIED` / `REJECTED`
   - 최신성: `CURRENT` / `REVIEW_REQUIRED` / `SUPERSEDED`
3. ACL은 검색 전·Tool 호출 전·원문 조회 전에 적용한다. 관리자는 운영 권한만으로 모든 원문을 열람할 수 없다.
4. 모든 규정 판단과 수정안은 규정 ID, 버전, 조항, 적용일, 근거 텍스트를 동반한다.
5. 실제 고객 정보·사내 기밀 없이 합성 문서만 사용한다.

### 1.4.1 상태 매핑

> 팀 결정(기본값): 원문은 상태 집합 간 매핑을 정의하지 않는다. MVP는 아래 축으로 통일한다.

| 축 | 값 | 사용처 | 비고 |
|---|---|---|---|
| 공식성 `authority_status` | `VERIFIED` / `UNVERIFIED` / `REJECTED` | Documents, 검색 배지 | 노하우 "검증 완료"=VERIFIED, "반려"=REJECTED, "조건부 검증"=VERIFIED + `conditional=true` |
| 최신성 `freshness` | `CURRENT` / `REVIEW_REQUIRED` / `SUPERSEDED` | Documents, 검색 배지 | 원문 `REVALIDATION_REQUIRED`(6장)와 노하우 "재검증 필요"는 `REVIEW_REQUIRED`로 통일 |
| 수명주기 `lifecycle` | `QUARANTINED` → `IN_REVIEW` → `PENDING_APPROVAL` → `PUBLISHED` / `BLOCKED` | 업로드·승인 워크플로 | 노하우 "검토 필요"=IN_REVIEW. `PUBLISHED`만 KB 색인 |
| Trust Gate 판정 | `PASS` / `REVIEW_REQUIRED` / `QUARANTINED` | 자동 검사 결과 (4.4) | |
| 게시 정책 판정 | `APPROVE` / `REVIEW` / `BLOCK` | 게시 요청 시 정책 결과 (4.1 6단계) | 이후 사람 승인 필수 |
| 조문 상태 | `ACTIVE` / `HISTORICAL` / `DELETED` | 법령 청크 메타데이터 (8.3) | |
| 검색 결과 상태 | `FOUND` / `HISTORICAL` / `DELETED` / `NOT_FOUND_VERIFIED` / `UNVERIFIED` / `ACCESS_DENIED` | 검색 응답 (8.7) | |

### 1.5 MVP 시연 시나리오

| 시나리오 | 검증 포인트 | 기대 결과 |
|---|---|---|
| 위조 규정 업로드 | 공식 Registry/승인본 불일치 | 게시 차단 |
| 규정 위반 노하우 | 근거 조문과 충돌 탐지 | 검토 필요 |
| 규정 개정 | 조문-노하우 관계 역추적 | 재검증 요청 |
| 복잡한 법령 질의 | 제12조제2항제3호가목 계층 검색 | 정확한 출처·시행일 |
| 권한 없는 게시 | AgentCore Policy 도구 호출 차단 | 거부 및 감사 기록 |
| 검색 실패 | 과거 버전/부칙/공식 API 재탐색 | 검증 상태 분리 |

---

## 2. AWS 아키텍처

### 2.1 전체 흐름

```
사용자/관리자 → Next.js (CloudFront/WAF 또는 은행 내부 ALB)
  → FastAPI (ECS Fargate) → Cognito/사내 IdP + RBAC/ABAC
  ├─ Upload        → S3 Quarantine → Malware Scan → Step Functions
  │                → SageMaker PaddleOCR → Guardrails/Custom PII → Trust Gate
  │                → Human Approval → S3 Published → KB/OpenSearch + Neptune
  ├─ Search        → ACL/Tag Filter → KB Hybrid Retrieve → Cohere Rerank
  │                → Recommendation Agent → Synthesis Agent → Guardrails Output
  ├─ Policy Update → Registry → Clause Diff → Neptune Impact
  │                → Wiki Draft → Human Approval → Versioned Republish
  └─ AgentCore Runtime/Strands + Gateway(MCP) → CloudWatch/OTel
```

원문 AWS 도식에만 있는 연결

```
사내 IdP / AgentCore Identity → AgentCore Runtime
AgentCore Runtime → Gateway/MCP → AgentCore Policy
  → { Neptune (Change Impact), Trusted Regulation Registry, OpenSearch Legal/Wiki Index }
AgentCore Runtime → Observability / Evaluations
업로드 경로: … → 담당자 승인 → Bedrock KB → Custom Chunking Lambda → OpenSearch
```

> 팀 결정: TypeScript로 구현 (원문은 Python/FastAPI)

### 2.2 서비스별 책임

| 서비스 | 책임 | 설계 메모 |
|---|---|---|
| S3 + KMS | Quarantine / Published / Artifact / Log 버킷 | 버킷 분리, 접근권한, 버전관리 |
| SageMaker + PaddleOCR | 스캔 PDF/이미지 OCR, 좌표·표 추출 | 추론 엔드포인트 또는 비동기 배치 |
| Bedrock Guardrails | PII 후보 탐지, 입력·출력 정책 | 정규식/문맥 검증으로 보완 |
| Bedrock KB + OpenSearch | Hybrid Search, 메타데이터 필터 | 승인본만 동기화 |
| Cohere Rerank 3.5 | 후보 검색 결과 재정렬 | 관련성 ≠ 공식성 |
| Neptune | 조항·문서·업무 관계 탐색 | 증거와 버전 포함 |
| DynamoDB | 문서 상태, 승인, 평가, Registry | 조건부 갱신·감사 이벤트 |
| AgentCore + Step Functions | 추론 및 장기 워크플로 | 승인·상태 변경은 백엔드 수행 |
| CloudWatch / OTel / CloudTrail | Trace, Token, 비용, 보안 감사 | PII 로그 비노출 |

### 2.3 기술 적용 이유

| 기술 | 이유 |
|---|---|
| PaddleOCR | 스캔 문서 복원 |
| Legal Parser | 법령 구조 유지 |
| KB Lambda | 사용자 정의 청킹 |
| OpenSearch | Hybrid Search |
| Cohere | 관련성 재정렬 |
| Neptune | 조문·노하우 참조 그래프 |
| AgentCore Runtime·Gateway | Agent·MCP 실행 |
| Identity·Policy | 도구 권한 |
| Evaluations | 품질 측정 |
| Terraform | 환경별 재현성. HPG Landing Zone 자원과 충돌하지 않도록 모듈·배포 권한 분리 |

---

## 3. 역할·권한

### 3.1 사용자 역할과 화면

| 역할 | 기본 화면 | 가능한 행동 |
|---|---|---|
| 일반 사용자 | 검색 홈, 태그, 결과, AI 가이드 | 권한 내 조회·평가·신고 |
| 작성자 | 업로드, OCR 검토, 내 문서 | 분류·마스킹 검토, 게시 요청 |
| 규정 승인자 | 승인 대기, 공식 Registry, 영향 분석 | 규정 공식성 승인, 수정안 승인 |
| 보안 검토자 | PII/위협 보류함 | 검토·반려·예외 처리 |
| 운영 관리자 | Agent Observability, 배포/장애 | 마스킹된 Trace 확인. 원문 기본 차단 |

- 사용자 홈은 문서 유형별 폴더가 아니라 검색창 + 태그 칩 + 추천 문서 카드로 구성한다.
- 관리자 메뉴는 역할에 따라 서버가 제공한다. 프론트엔드 숨김만으로 권한을 구현하지 않는다.

> 팀 결정(기본값): 원문은 같은 역할을 여러 이름으로 부른다(규정 승인자/규정 담당자/approver, 운영 관리자/Platform Operator). 코드에서는 아래 enum 하나만 쓴다.

| enum | 한글명 | 원문 이칭 |
|---|---|---|
| `USER` | 일반 사용자 | 사용자 |
| `AUTHOR` | 작성자 | |
| `REG_APPROVER` | 규정 승인자 | 규정 담당자, approver |
| `SECURITY_REVIEWER` | 보안 검토자 | |
| `PLATFORM_OPERATOR` | 운영 관리자 | Platform Operator |

### 3.2 RBAC + ABAC

| 구분 | 기준 |
|---|---|
| RBAC | 사용자 / 작성자 / 규정 담당자 / 보안 검토자 / 운영 관리자 |
| ABAC | 부서, 문서 등급, 업무, 문서 소유권 |

- 모든 API와 MCP Tool에서 정책을 재검증한다. 검색 메타데이터에도 허용된 ACL을 반영한다.
- 민감정보 원문 접근은 JIT 승인·감사·시간 제한을 권장한다.

---

## 4. 문서 등록·OCR·PII·Trust Gate

### 4.1 업로드 단계

| 단계 | 시스템/AI 동작 | 사용자 개입 |
|---|---|---|
| 1. 업로드 | 확장자·MIME·크기 확인, Quarantine 저장 | 작성자: 파일/공개 범위 선택 |
| 2. 보안 스캔 | 악성 파일 검사, 위험 형식 격리 | 보안 검토자: 차단 해제 검토 |
| 3. OCR | PaddleOCR로 텍스트/표/좌표 추출 | 오인식·저신뢰 페이지 확인 |
| 4. 분류·PII | 유형·태그·요약, PII 후보 표시 | 작성자: 분류·마스킹 수정 |
| 5. 공식성 검증 | Registry 원본·승인·시행일·내용 비교 | 규정 승인자: 불일치 확인 |
| 6. 게시 요청 | 정책 기반 APPROVE / REVIEW / BLOCK | 담당 승인자: 최종 게시 승인 |
| 7. 색인 | 게시: S3 Published 버킷 → 청킹/임베딩/Graph | 자동, 실패 시 재처리 |

### 4.2 SageMaker PaddleOCR

> 팀 결정 예외: PaddleOCR(SageMaker 컨테이너)은 Python 유지

- PDF를 페이지 이미지로 렌더링하고 페이지별 PaddleOCR 추론을 수행한다.
- 출력 필드: `text`, `polygon/bounding_box`, `confidence`, `page`, `reading_order`, `table_id`
- PDF 내 디지털 텍스트는 Parser로 추출하고 OCR과 품질을 비교해 중복을 제거한다.
- 긴 문서: S3 이벤트 → Step Functions Map → 비동기 SageMaker 추론

### 4.3 PII·기밀정보 다층 방어

| 단계 | 방법 |
|---|---|
| 1차 | 정규식·체크섬 (주민등록번호 형식, 휴대전화, 이메일, 계좌번호 후보) |
| 2차 | Bedrock Guardrails Sensitive Information Filters + 사용자 정의 정규식 |
| 3차 | 금융 도메인 사전 + Sonnet 문맥 검토 (고객번호, 신용정보, 미공개 정책) |
| 4차 | 사람 검토 |

> 팀 결정: 혁신금융 원칙(`03` ②, AI에는 비식별 데이터만)에 따라 3차의 Sonnet 문맥 검토는 1·2차로 **마스킹된 텍스트에만** 수행한다. 1·2차 후 불확실 구간이 남으면 모델에 보내지 않고 사람 검토(REVIEW_REQUIRED)로 보낸다. 상세 순서는 `04` 1.1.

- 탐지 span을 OCR 좌표와 연결해 이미지·텍스트를 모두 비식별화하고, 재OCR로 잔존 노출을 검사한다.
- 원본은 제한된 S3/KMS 영역에 보존하고 게시용 Sanitized Document를 별도 생성한다.
- AI Trace, 오류 로그, 프롬프트, 검색 스니펫, 캐시에 원문 PII가 남지 않도록 필드별 로그 마스킹을 적용한다.
- 한국어 PII 지원 범위는 실제 계정에서 합성 데이터로 검증한다 (확인 필요).

### 4.4 Trust Gate 판정

| 판정 | 조건 예시 | 후속 동작 |
|---|---|---|
| `PASS` | 악성코드 없음, PII 조치, 출처 검증 완료 | 게시 승인 단계로 이동 |
| `REVIEW_REQUIRED` | 공식 원본 불일치, PII 불확실, 시행일 불명 | 근거 표시 후 담당자 검토 |
| `QUARANTINED` | 악성코드 탐지, 명확한 보안 정책 위반 | 게시/검색 차단, 보안 처리 |

> 팀 결정(기본값): Trust Gate 판정(`PASS`/`REVIEW_REQUIRED`/`QUARANTINED`)은 업로드 후 **자동 검사 결과**다. 게시 판정(`APPROVE`/`REVIEW`/`BLOCK`, 4.1 6단계)은 작성자가 게시 요청할 때의 **정책 결과**이며, 그 뒤에 사람 승인 단계가 따로 있다. 두 enum은 별개 단계이고 `PASS`여도 사람 승인 없이는 게시하지 않는다.

---

## 5. 공식 규정 검증·Knowledge Graph

문서가 규정처럼 보이는 것과 공식 규정임을 입증하는 것은 다르다.

- 내부 규정: 사내 DMS/전자결재/규정관리시스템 또는 지정 담당자가 승인한 Trusted Regulation Registry 기준으로 확인한다.
- 외부 규정: 공식 사이트의 발행처·문서번호·시행일·원문을 확인한다. 웹 검색 결과만으로 공식성을 확정하지 않는다.

### 5.1 검증 증거

| 증거 | 검증 방법 | 주의 |
|---|---|---|
| 규정 ID/버전 | DMS API/Registry 메타데이터 비교 | 업로드 파일명 신뢰 금지 |
| 원본 해시 | SHA-256 동일성 확인 | 재저장만으로 해시 변경 가능 |
| 전자서명 | 서명·신뢰체인·서명자 권한 확인 | 서명 자체가 법적 효력 보장하지 않음 |
| 조항 정합성 | 승인본 조항별 수치/조건/예외 비교 | 시행일·적용 범위 고려 |
| 담당자 승인 | 승인 권한·근거·이력 저장 | AI 단독 승인 금지 |

### 5.2 Graph 모델

일반 문서 Graph

| 구분 | 값 |
|---|---|
| Nodes | Document, Version, Clause, Requirement, Topic, Process, Owner |
| Edges | REFERENCES, DEPENDS_ON, SUPERSEDES, APPLIES_TO, DERIVED_FROM, CONFLICTS_WITH, OWNED_BY |
| Edge 필수 속성 | evidence_id, source_version, confidence, reviewed_by, valid_from |

법령 Graph

| 구분 | 값 |
|---|---|
| Nodes | LAW, LAW_VERSION, ARTICLE_VERSION, CLAUSE_VERSION, ANNEX, WIKI_VERSION, OWNER, APPROVAL |
| Edges | CONTAINS, REFERENCES, EXCEPTION_CANDIDATE, SUPERSEDES, APPLIES_TO, DERIVED_FROM, CITES, IMPACTS, OWNED_BY |
| Edge 필수 속성 | evidence_span, source_version, confidence, reviewer_status, valid_from/to |

---

## 6. Change Impact

```
공식 규정 신규 승인
  → 이전/신규 버전 조항 Diff
  → 변경된 조건·수치·예외 추출
  → Neptune 역방향 관계 탐색
  → 직접/간접 영향 후보
  → 적용 범위·시행일 검증
  → Wiki Maintenance Agent 수정 Draft
  → 담당자 승인
  → 새 버전 게시 및 KB 재색인
```

- 영향받은 미수정 문서는 `REVALIDATION_REQUIRED`로 표시하거나 고위험 검색에서 제외한다.
- 예시: 가상 여신 규정 제12조 승인 기준 5억 → 3억. 이 조항을 인용한 체크리스트 2개와 FAQ 1개를 찾는다. FAQ는 적용 대상이 불명확하므로 자동 수정하지 않고 검토 요청한다.

---

## 7. 한국 법령 ETL

한국 법령의 편·장·절·조·항·호·목, 가지번호, 상대참조, 삭제·개정, 부칙·별표, 시행일을 보존한다. 법령을 임의 토큰 길이로 분할하지 않는다.

### 7.1 설계 원칙

- 법령 원문은 불변(immutable) 보관. 검색용 텍스트·임베딩·요약은 파생 데이터이며 법적 원문을 대체하지 않는다.
- 공식 XML/HTML 또는 HWPX 구조를 우선 파싱한다. 스캔 PDF·이미지는 SageMaker PaddleOCR을 쓴다.
- 법령과 일반 노하우는 전처리·청킹·검색 인덱스를 분리한다. 사용자 검색 시 권한 필터를 적용해 통합 조회한다.
- 조문·참조·유효기간은 Structured Store, 검색용 청크는 OpenSearch, 관계는 Neptune에 저장한다.
- AI는 구조가 모호하거나 의미 비교가 필요한 구간만 지원한다. 공식성·시행일·접근권한·게시 승인은 신뢰된 시스템과 사람이 확정한다.

### 7.2 데이터 흐름

```
업로드 → Quarantine/악성파일 검사 → 포맷 라우터
  → [공식 구조화 원문 파싱 | SageMaker PaddleOCR]
  → 텍스트·좌표 정규화 → Legal Structure Parser → Reference Resolver
  → Version/Effective Date Manager → PII·Trust Gate → 담당자 승인
  → S3 구조화 원본 + DynamoDB 메타데이터 + OpenSearch Legal Index + Neptune Graph
```

KB 색인 구간 (원문 도식)

```
Trust Gate·승인 → 승인된 S3 정규화 원문 → Bedrock KB Ingestion Job 트리거
  → POST_CHUNKING Lambda → 조·항·호·목 청크 + 메타데이터 → Embedding / OpenSearch
```

> 팀 결정(기본값): 원문 도식은 Reference Resolver·Version Manager에서 Neptune으로 Trust Gate와 병렬 분기하지만, 본문은 승인 후 저장으로 되어 있다. MVP는 **Neptune에 승인 후에만 게시**한다(9.2 "검증된 관계만 그래프 게시"). 승인 전 관계는 DynamoDB에 후보 상태로만 보관한다.

원본 검증과 법령 구조 복원은 KB 수집 이전에 수행한다. KB Custom Transformation Lambda는 이미 승인된 정규화 데이터를 읽어 청킹·메타데이터만 구성한다.

### 7.3 형식별 추출

| 입력 | 우선 처리 | 검증 포인트 |
|---|---|---|
| 법령 XML/HTML | 공식 구조 데이터 파서 | 공식 출처·문서 식별자·개정 이력 |
| HWPX/DOCX | 문단/스타일/번호 목록 구조 추출 | 들여쓰기·자동 번호·각주·표 |
| 텍스트 PDF | 텍스트 추출 + 레이아웃 분석 | 2단 편집·머리말·쪽번호 |
| 스캔 PDF/이미지 | SageMaker PaddleOCR | ①/②·가/나·괄호·표 셀 OCR 오류 |

### 7.4 계층 모델과 정규화

편(PART) → 장(CHAPTER) → 절(SECTION) → 조(ARTICLE) → 항(PARAGRAPH) → 호(ITEM) → 목(SUBITEM)

- 편·장·절은 없을 수 있다.
- 조문 제목·본문·단서·별표·부칙은 별도 속성/노드로 관리한다.

| 원문 표현 | 정규화 필드 | 주의 |
|---|---|---|
| 제12조 | `article_no=12` | 제12조의2와 구분 |
| 제12조의2 | `article_no=12, article_branch=2` | 가지번호는 항이 아님 |
| ①/②/⑩ | `paragraph_no=1/2/10` | 원문 glyph 별도 보존 |
| 1. / 2. | `item_no=1/2` | 번호 목록인지 문맥 검증 |
| 가. / 나. | `subitem=가/나` | 항·호 상위 문맥 필수 |
| ③ 삭제 <2025.1.1.> | `status=DELETED, deletion_date` | 과거 버전 보존 |
| 부칙 제2조 | `supplementary_provision` | 시행·경과조치 영향 |

### 7.5 필수 구조화 필드

`document_id`, `source_system`, `authority_status`, `law_id`, `law_name`, `revision_id`, `promulgated_at`, `effective_from`, `effective_to`, `provision_id`, `provision_path`, `original_marker`, `original_text`, `normalized_text`, `parent_id`, `sibling_order`, `status`, `source_page`, `bbox`, `references[]`, `exception_candidates[]`, `approval_id`, `hash`, `parser_version`, `acl_tags`

### 7.6 표준 식별자

```
SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:2/ITEM:1/SUBITEM:GA
```

- 표시용 조문명: "제12조제2항제1호가목"
- 내부 ID는 조문 개정 버전과 상위 경로를 포함한다.
- 원본 glyph, Unicode 정규화 값, 원본 OCR 좌표를 모두 보존한다.

> 팀 결정(기본값): 원문에 목 코드 변환 규칙이 없다. 국어 로마자 표기를 대문자로 쓴다: 가→GA, 나→NA, 다→DA, 라→RA, 마→MA, 바→BA, 사→SA, 아→A, 자→JA, 차→CHA, 카→KA, 타→TA, 파→PA, 하→HA.

### 7.7 파서 구현

> 팀 결정: TypeScript로 구현 (원문은 Python 상태 머신 + Pydantic)

- 결정론적 상태 머신을 우선한다. 제목·조문·항·호·목 정규표현식과 문서 스타일/들여쓰기를 결합한다.
- "제12조의2"를 먼저 인식한 뒤 "제12조"를 매칭한다.
- 파서 결과는 Schema로 검증한다. 누락·중복·고아 노드·번호 역행·비정상 OCR 토큰은 QA 큐로 보낸다.

### 7.8 Reference Resolver

| 유형 | 예시 |
|---|---|
| 직접 참조 | 제12조제2항제1호가목, 「가상법」 제3조 |
| 상대 참조 | 전항, 전조, 같은 조, 각 호, 다음 각 목 |
| 외부 참조 | 다른 법령·시행령·고시·별표 |

참조 표현을 추출한 뒤 기준 조문·법령 ID·개정 시점에 따라 실제 대상 ID로 해석한다.

| 표현 | 처리 | 실패 시 동작 |
|---|---|---|
| 제12조제2항 | 절대 참조 경로 파싱 | 미존재/삭제 조문 경고 |
| 전항 / 같은 조 | 현재 조문 기준 상대 해석 | 기준 문맥 없으면 미해결 |
| 제○조에도 불구하고 | REFERENCES + EXCEPTION_CANDIDATE | 예외 확정은 검토 |
| 별표 1 | 별표 ID 및 적용 조문 연결 | 표/셀 매핑 재검토 |
| 다른 법령의 조항 | 법령 ID + 버전 + 적용일로 연결 | 동명이법·폐지법 확인 |

### 7.9 개정·삭제·부칙

- 공포일, 승인일, 시행일, 유효종료일, 등록일을 분리한다.
- 삭제 조문은 물리 삭제하지 않고 해당 버전의 `DELETED` 상태로 유지한다. 현재시점 기본 검색에서는 제외한다.
- 일부개정, 전부개정, 신설, 삭제, 이동, 조문 번호 변경을 구분하고 이전 버전과 연결한다.
- 부칙의 적용례·경과조치·유예기간은 현재 유효 규정을 결정하는 데 필수이며, 단순 날짜 비교로 확정하지 않는다.
- 과거 시점 질의는 `as_of_date`와 적용 업무·상품·관할 정보로 당시 유효 조문을 조회한다.

---

## 8. 청킹·인덱스·검색

### 8.1 문서 종류별 청킹

| 문서 종류 | 청킹 기준 | 권장 메타데이터 |
|---|---|---|
| 공식 규정 | 조/항/호·예외·시행일 보존, 부모 조항 연결 | policy_id, clause_id, version, effective_date |
| 노하우 | 업무 단계·상황·실패 사례 단위 | task, tags, owner, reviewed_at |
| 표/체크리스트 | 표 헤더+행, 체크 항목 묶음 | table_id, source_page, row_range |
| FAQ | 질문·답변 쌍 단위 | question_intent, applicable_process |

- 조항 단위는 지나친 세분화로 문맥이 손실되지 않도록 부모-자식 계층 구조와 인접 조항을 보존한다.

### 8.2 Adaptive Legal Chunking

| 단위 | 인덱싱 전략 | 검색 시 확장 |
|---|---|---|
| 편·장·절 | 문맥 메타데이터로 상속 | 상위 제목 포함 |
| 조 (Article) | Parent 원문/제목/범위 보존 | 필요시 전체 조문 조회 |
| 항 (Paragraph) | 기본 Child 검색 청크 | 관련 항·단서 포함 |
| 호·목 | 긴 항일 때 조건부 분할 | 상위 항·호 함께 조회 |
| 별표·별지 | 표 제목·행·열 구조 별도 청크 | 참조 조문과 연결 |
| 부칙 | 시행일·적용례 중심 독립 청크 | 관련 본칙 조문 연결 |
| 삭제 조항 | 이력 저장, 현행 기본검색 제외 | 과거 시점 질의만 포함 |

청크 구성

```
search_text = 법령명 + 버전/시행일 + 편/장/절 제목 + 조문 제목
            + 조·항·호·목 경로 + 대상 원문 + 최소한의 상위 조건
```

`original_text`와 `augmented_search_text`는 별도 필드로 저장한다. AI가 보강 문구를 법령 원문처럼 인용하지 못하게 하기 위해서다.

### 8.3 KB Custom Chunking Lambda

| 설정 | 값 |
|---|---|
| `vectorIngestionConfiguration.chunkingConfiguration.chunkingStrategy` | `NONE` |
| `vectorIngestionConfiguration.customTransformationConfiguration.transformations[].stepToApply` | `POST_CHUNKING` |
| `vectorIngestionConfiguration.customTransformationConfiguration.transformations[].transformationFunction` | Lambda ARN |
| `vectorIngestionConfiguration.customTransformationConfiguration.intermediateStorage` | 중간 S3 위치 |

설정 위치는 KB 데이터 소스의 `vectorIngestionConfiguration` 아래다.

Lambda 실행 계약 (원문 도식, 9단계)

1. KB: POST_CHUNKING · chunkingStrategy NONE · 중간 S3 설정으로 Lambda 호출
2. Lambda 입력 확인: 입력 파일·청크 위치 확인
3. S3 읽기: 정규화 조문
4. 법령 청킹: 항 기본, 긴 조항은 호·목 분할
5. 검색 문맥 보강: 법령명·제목·조문 ID
6. 메타데이터 검증: 버전·ACL·상태·시행일
7. S3 결과 저장: KB 요구 출력 스키마
8. Lambda 응답: 변환 결과를 저장한 S3 URI를 반환
9. KB 인덱싱: Embedding + Vector Store

실제 AWS API/Provider 지원과 이벤트·결과 JSON 계약은 배포 전 공식 스키마로 검증한다 (확인 필요).

| 항목 | 규칙 |
|---|---|
| 기본 분할 | 조 단위 Parent 보존, 항을 기본 Child 청크로 사용 |
| 긴 조항 | 호·목 경계에서 추가 분할, 상위 문맥과 조건·단서 연결 |
| 원문 표기 | ①/②, 제12조의2, 가목 등을 원형과 정규화 ID로 함께 저장 |
| 삭제·버전 | DELETED/HISTORICAL/ACTIVE, effective_from/to를 메타데이터로 기록 |
| 출처·ACL | law_id, clause_id, source_hash, approval_id, access_scope 필수 검증 |
| 오류 처리 | 구조 파싱 실패·참조 불일치·메타데이터 누락은 격리 및 재검토 |

운영 주의: Lambda는 실행 시간·메모리·페이로드·중간 S3 접근 제약이 있다. 대용량 OCR·법령 전체 연혁 처리·Graph 구축을 Lambda 단일 호출에 넣지 않는다. 법령 인덱스와 Wiki 인덱스를 논리 분리하고 검색 시 ACL 및 시행일 필터를 강제한다. 모델 리전·서비스 가용성은 us-east-1 기준으로 확인하고 HPG·서울 전환 시 재검증한다.

### 8.4 인덱스 구성

| OpenSearch 논리 인덱스 | 내용 |
|---|---|
| `legal-clauses` | 조문 번호 정확 검색 + BM25 + vector |
| `wiki-knowledge` | 노하우·태그·별점 |
| `official-manuals` | 승인 매뉴얼 |

- 하나의 컬렉션에서 시작하되, 데이터 접근 경계가 다르면 분리한다.
- Structured Store가 원본 구조·버전의 기준이다. OpenSearch는 파생 인덱스다.

### 8.5 임베딩·Rerank

| 항목 | 기준 |
|---|---|
| 임베딩 | Titan Text Embeddings V2로 시작. 한국어 업무 용어·금융 약어 Recall@5로 평가 |
| 후보 수 | 원문 범위: 30~50 → Rerank 10~15 → 최종 추천 5~10 (실험으로 조정) |
| 규정 임베딩 | 항·호 검색 청크를 임베딩하고 법령 ID·조문 경로·effective date·ACL을 필터로 유지 |
| Rerank | Cohere Rerank 3.5. 권한 필터 후 관련성만 평가 |
| 하드 게이트 | 공식성·유효성·권한은 Rerank 전에 적용. Rerank 점수에 법적 효력 판단을 위임하지 않음 |
| 별점 | 보조 신호. 인기가 공식 규정보다 우선하지 않음 |

> 팀 결정(기본값): 후보 수 기본값은 50 / 15 / 5로 시작하고 위 범위 안에서 실험으로 조정한다.

### 8.6 검색 실행 순서

```
인증·ABAC → 태그/업무/시점 파악
  → ACL·상태(공식성·유효기간) 사전 필터
  → legal + wiki 병렬 Hybrid Retrieve (top 50)
  → exact citation match → reference expansion
  → Cohere Rerank 3.5 (top 15)
  → authority / effective-date / ACL 재검증 (policy-aware scoring, 사전 필터 후 재확인)
  → Haiku 추천 근거 (top 5) → Sonnet 종합 가이드 + citations
  → Guardrails 출력 검사 → 사용자 응답
```

### 8.7 검색 실패 복구와 상태

"검색 결과 없음 ≠ 법령에 없음". "제12조제2항제3호가목"은 제12조 → ② → 3. → 가. 순서로 탐색한다. 내부 인덱스, 조문 계층, 참조 그래프, 공식 API를 우선 사용하고 AgentCore Browser는 허용된 사이트에 한정한 보조 수단으로 둔다.

| 상태 | 응답 원칙 |
|---|---|
| `FOUND` | 공식 원문과 기준일을 확인한 조문 및 출처 제시 |
| `HISTORICAL` / `DELETED` | 과거 유효기간 또는 삭제 이력 명시 |
| `NOT_FOUND_VERIFIED` | 특정 법령·버전·범위를 확인한 경우에만 부재 판정 |
| `UNVERIFIED` | 접근 장애·파싱 실패·근거 부족이면 "확인 불가"로 표현 |
| `ACCESS_DENIED` | 권한 부족을 존재 여부 판단과 분리 |

`UNVERIFIED`를 `NOT_FOUND_VERIFIED`로 표현하지 않는다.

검색 실패 복구 흐름 (원문 도식)

```
질문 분석 (법령명·조항·기준일)
  → Exact Lookup (조문 ID + 유효기간)
  → 확인됨? ── 예 ──────────────────────────────────────────┐
       └─ 아니오 → 상위 조문·상대참조 확장                       │
                → 과거 버전·삭제·부칙 확인 (Neptune·부칙·별표)    │
                → 공식 API · 허용 Browser                       │
  → 시행일·출처·권한 검증 ◀──────────────────────────────────┘
  → 상태 판정 → 최종 답변 (근거 제시 또는 UNVERIFIED)
```

Exact Lookup에서 확인되면 확장 단계를 건너뛴다.

---

## 9. Agent·모델 라우팅

### 9.1 Multi-Agent

| Agent | 기본 모델 | 에스컬레이션 |
|---|---|---|
| Orchestrator | Sonnet 5.5 | 복합 계획만 Opus 검토 |
| Document Intelligence | Haiku 5.5 | 불확실 분류 → Sonnet |
| Privacy & Security | Haiku 5.5 + 규칙 | 금융 민감정보 문맥 → Sonnet |
| Authority Verification | Sonnet 5.5 | 중대한 출처 충돌 → Opus |
| Trust Verification | Sonnet 5.5 | 고위험 불일치 → Opus |
| Knowledge Graph | Sonnet 5.5 | 복잡한 관계 검토 → Opus |
| Change Impact | Sonnet 5.5 | 간접 영향/예외 → Opus |
| Wiki Maintenance | Sonnet 5.5 | 고위험 수정안 → Opus |
| Recommendation | Haiku 5.5 | 근거 충돌 → Sonnet |
| Knowledge Synthesis | Sonnet 5.5 | 상충 규정 → Opus |

### 9.2 Legal 구성요소

| 구성요소 | 기본 모델 | 업무 |
|---|---|---|
| Legal Structure Parser | 규칙 기반 + Sonnet 5.5 | 구조 불확실 구간만 LLM 보조 |
| Reference Resolver | 규칙 기반 + Haiku 5.5 | 상대 참조 후보 추출, 대상 연결은 코드 검증 |
| Legal Change Analyzer | Sonnet 5.5 | 개정 전후 의미·적용범위 비교 |
| High-risk Reviewer | Opus 5.5 | 고위험 충돌·예외·모호한 영향 후보 검토 |
| Authority Verification | Registry/API 우선 | 공식 원본·승인·시행일 증거 확인 |
| Knowledge Graph | Sonnet 5.5 보조 | 검증된 관계만 그래프 게시 |

- 모델 ID, 리전, Inference Profile은 배포 시 실제 계정에서 검증한다 (확인 필요).
- 모든 모델을 상시 호출하지 않는다. 정책 기반 에스컬레이션을 적용한다.
- Agent는 승인·게시·원본 삭제 권한을 직접 보유하지 않는다. 상태 전이는 AgentCore 오케스트레이터(Gateway Tool = 단계 Lambda)와 인증된 API가 수행한다 (11/16 팀 결정, Step Functions 대체).

> MVP 구현 대응 (11/16, dhxorb96). 위 10개 역할은 **독립 Agent 10개가 아니라 역할 단위**로 구현했다. 판단 흐름이 고정된 역할은 오케스트레이터의 단계(규칙 + 필요할 때만 모델 1회)로, 사용자와 대화하는 역할만 Agent로 둔다. 이유: 단계마다 Agent를 두면 Agent 간 LLM 왕복이 늘어 지연·비용·비결정성이 커지고, 승인 전 상태 전이를 LLM이 고를 여지가 생긴다(9.1 마지막 원칙과 충돌).
>
> | 9.1 역할 | 구현 | 모델 | 상태 |
> |---|---|---|---|
> | Orchestrator | AgentCore Runtime 파이프라인 오케스트레이터 (Strands Graph, 단계 순서 고정) | 없음 | 완료 |
> | Document Intelligence | Classify 단계 (분류 + 문서·쪽 요약) | Haiku → 신뢰도 0.7 미만 Sonnet | 완료 |
> | Privacy & Security | PiiScan·InjectionScan 단계 (규칙·체크섬) + Guardrails(PII ANONYMIZE). 가이드 답변도 출력 검사(ApplyGuardrail OUTPUT, 탐지 값 가림·차단 시 답변 버림·호출 실패는 fail-closed) | 규칙. Guardrails는 GUARDRAIL_ID 설정 시 | 완료 (11/20 prod guide runtime env·IAM 반영) |
> | Authority Verification | TrustGate 단계 Registry 해시·조문 대조 | 없음 (Registry 우선) | 완료 |
> | Trust Verification | TrustGate 단계 노하우 검증 (인용 추출·조문 검색·판정·인용 원문 대조). 11/20 외부 법령 대조 추가: 본문이 인용한 외부 법령 조문(최대 3)을 law.go.kr 원문(UNVERIFIED)과 비교 → 불일치 `KNOWHOW_EXTERNAL_MISMATCH` MEDIUM + 수정 제안, 조회 실패·60초 초과·지시문 의심 `KNOWHOW_EXTERNAL_SKIPPED` LOW. 게시 차단·잠금·verdict 반영 없음. MANUAL 은 외부 대조만(`validateExternal`) | Sonnet 판정·Haiku 수정 제안, temperature 0 | 완료 (로컬 실측 MX 4곳 5회 20/20·원본 오탐 0) |
> | Knowledge Graph | GraphUpsert 단계·graph Tool (let522mj) | 없음 | 완료 |
> | Change Impact | graph `trace_impact` Tool (let522mj) + 화면 07·초안 (dhxorb96) | 없음 | **탐지 Tool만. 게시된 노하우 자동 재검증 표시·화면 07 미구현** |
> | Wiki Maintenance | Change Impact 수정 초안: `POST /v1/admin/impact/draft` → 영향 근거 문장마다 개정 조문대로 고친 초안(`steps/impact-draft.ts`, 숫자 지어내기·PII·조문 삭제는 코드로 UNKNOWN) → 위키 수정 요청(OPEN)으로만 저장 → [반영] → 새 버전 → AI 검사 → 사람 승인 | Haiku | 완료 (11/20, 화면은 프론트) |
> | Recommendation | 피드백 API(별점)만 | — | P1 미착수 |
> | Knowledge Synthesis | 가이드 Agent (AgentCore Runtime, 검색 Tool 근거만 인용) | Sonnet | 완료 (검색 Tool 실연동 전) |
> | 고위험 Opus 검토 | 없음 | — | **미구현** |
- 고위험 조항은 Opus 5.5 검토를 추가하되 최종 승인자는 사람이다.
- 11/20 (AI엔지니어팀): prod 계정은 5.5 미허용이라 Haiku 4.5·Sonnet 4.6(모델 ID는 환경변수). `structured` 호출은 temperature 0(5.5·Fable 은 거부해 뺌). 위 표 Privacy·Trust·Wiki Maintenance 행 갱신.

---

## 10. API·데이터 모델·MCP

> 팀 결정: TypeScript로 구현 (원문은 FastAPI)

### 10.1 Backend API

| Method | Path | 결과 |
|---|---|---|
| POST | `/v1/documents/upload-url` | presigned URL, doc_id |
| POST | `/v1/documents/{id}/analyze` | workflow execution |
| GET | `/v1/documents/{id}/review` | OCR/PII/Trust findings |
| POST | `/v1/documents/{id}/submit` | approval request |
| POST | `/v1/approvals/{id}/decision` | approve/reject (human only) |
| GET | `/v1/search?q=&tags=` | ACL-filtered reranked results |
| POST | `/v1/guides` | cited synthesis job |
| POST | `/v1/policies/{id}/impact` | clause-level impact analysis |
| GET | `/v1/admin/observability` | sanitized metrics |

> 팀 결정(기본값): 승인 API는 범위로 나눈다. 일반 문서(노하우·매뉴얼·규정 게시) 승인은 `/v1/approvals/{id}/decision`, 법령 수집(ingestion) 파싱 결과 검토는 `/v1/legal/reviews`.

### 10.2 Legal API

| Method | Path | 입력 → 결과 |
|---|---|---|
| POST | `/v1/legal/ingestions` | 파일 ID, source_type, policy_id → ingestion_id |
| GET | `/v1/legal/ingestions/{id}` | 파싱 상태, 검토 필요 구간, 오류 |
| GET | `/v1/legal/provisions/{id}?as_of=YYYY-MM-DD` | 유효 조문 및 원문 근거 |
| POST | `/v1/legal/references/resolve` | provision_id, revision_id → 대상 조문 후보 |
| POST | `/v1/legal/versions/compare` | old_revision, new_revision → clause diff |
| GET | `/v1/legal/impact/{revision_id}` | 영향 Wiki, 관계 근거, 위험도 |
| POST | `/v1/legal/reviews` | 담당자 승인·반려 (Agent 직접 승인 금지) |

### 10.3 핵심 테이블

| 테이블 | 필드 |
|---|---|
| Documents | doc_id, owner, classification, authority_status, freshness, acl, tags, version |
| Regulations | policy_id, version, effective_from, approved_by, hash |
| Findings | finding_id, evidence_ref, severity, disposition |
| Approvals | request_id, reviewer, decision, timestamp |
| Feedback | doc_id, stars, usefulness |
| AuditEvents | actor, action, resource, trace_id |

### 10.4 MCP 서버

| MCP 서버 | 주요 Tool | 통제 |
|---|---|---|
| Regulation MCP | get_official_policy, verify_version (+ get_clause, resolve_reference, compare_versions) | Registry read-only, 승인은 별도 API |
| Search MCP | search_wiki, retrieve_evidence | 문서별 ACL 강제 |
| Graph MCP | trace_impact, get_dependencies | 사용자 범위·조항 필터 |
| Approval MCP | create_review_request, get_status | 승인 실행 Tool 금지 |
| Privacy MCP | detect_sensitive_data, masking_preview | 원본 전달 최소화 |
| Observability MCP | get_agent_trace, get_usage | 관리자 전용, PII 제거 |

> 팀 결정(기본값): 원문은 MCP Tool명(10.4)과 정책 Tool명(11.2·11.4)이 다르다. 11장 Tool은 개념명이며, 아래처럼 snake_case 하나로 통일하고 서버에 매핑한다. `search_wiki`와 `wiki_search`는 `search_wiki`로 통일한다.

| Tool | MCP 서버 | 허용 역할 (기본) |
|---|---|---|
| `search_wiki` | Search MCP | 전 역할 (ACL 내) |
| `retrieve_evidence` | Search MCP | 전 역할 (ACL 내) |
| `search_legal_clause` | Regulation MCP | 전 역할 (허용 법령 scope) |
| `get_official_policy`, `verify_version`, `get_clause`, `resolve_reference`, `compare_versions` | Regulation MCP | 전 역할 (read-only) |
| `trace_impact`, `get_dependencies` | Graph MCP | AUTHOR, REG_APPROVER |
| `draft_change` | Approval MCP | AUTHOR, REG_APPROVER |
| `create_review_request`, `get_status` | Approval MCP | AUTHOR, REG_APPROVER |
| `publish_wiki` | Approval MCP | 서버 검증 통과 시만 (4.4·11.4 조건), Agent 직접 호출 시 Policy Deny가 데모 06 대상 |
| `approve_regulation` | 제공하지 않음 (승인 API 전용) | REG_APPROVER, 사람만 |
| `export_document` | 제공하지 않음 (MVP 범위 외) | |
| `detect_sensitive_data`, `masking_preview` | Privacy MCP | AUTHOR, SECURITY_REVIEWER |
| `get_agent_trace`, `get_usage` | Observability MCP | PLATFORM_OPERATOR |

---

## 11. AgentCore Identity·Policy·Evaluations

적용 범위: AgentCore Identity + Policy, AgentCore Evaluations. AgentCore Memory·Optimization·AgentCore Registry는 이번 변경 범위에서 제외한다 (Trusted Regulation Registry와 무관하며 Registry 대조 기능은 유지).

> 팀 결정(11/16, 사용자): 문서 처리 오케스트레이션은 Step Functions 대신 **AgentCore Runtime(Strands Graph) + Gateway**로 한다(`interfaces.md` 6.1). 상태 전이는 오케스트레이터가 Gateway Tool(단계 Lambda)과 인증된 API로만 수행하며, 승인·게시 Tool은 없다. AgentCore Memory는 도입하지 않는다(11/16 사용자 결정 C안: 요구사항에 대화 기능 없음).

### 11.1 Identity + Policy 책임

목적: 사용자 인증, Agent의 도구 호출 권한, 문서 접근 권한, 게시 승인 권한을 서로 분리한다. LLM 프롬프트는 보조 지침이다. 실제 권한 결정은 API/도구 서버와 Policy에서 강제한다.

| 구성요소 | 설계 책임 | 강제 검증 |
|---|---|---|
| 사용자 인증 / API | 은행 IdP 또는 IAM Identity Center 연계. JWT의 subject·tenant·role 검증 | 백엔드에서 인증·세션·요청자 식별 |
| AgentCore Identity | Agent/Tool 호출에 필요한 신원 및 자격증명 전달·관리 | 사용자 신원과 실행 주체를 혼동하지 않음 |
| AgentCore Gateway + Policy | MCP 도구 노출 및 호출 정책. 승인·게시·규정조회 조건 설정 | Tool별 deny-by-default, 명시적 허용 |
| 업무 API / 승인 저장소 | 문서 ACL, 승인자 역할, 문서 상태, 버전·해시 재검증 | 정책 통과만으로 게시 승인하지 않음 |
| 감사 / 관측 | 요청자·도구·정책결과·승인 ID·문서 버전 기록 | PII·법령 원문·자격증명 로그 제외 |

### 11.2 필수 시나리오

1. 일반 사용자는 `search_legal_clause`와 허용된 `wiki_search`만 사용한다.
2. 작성자는 `draft_change`를 실행할 수 있으나 `publish_wiki`는 호출할 수 없다.
3. 규정 승인자만 `approve_regulation`이 가능하다.
4. `publish_wiki`는 승인 ID, 문서 해시, 버전, 승인자 분리, 최신 상태를 서버에서 검증한다.
5. Platform Operator는 배포·관측을 담당하되 민감한 문서 내용 열람 권한을 기본 부여하지 않는다.

정책 실패는 403/`ACCESS_DENIED`로 기록한다. Agent는 다른 도구를 이용해 권한을 우회하지 않는다.

### 11.3 요청 흐름

요청 흐름은 인증 → 정책 검사 → 업무 상태 재검증 → 실행 → 감사 기록의 순서를 유지한다.

| 단계 | 처리 | 실패 시 |
|---|---|---|
| 1. 사용자 요청 | 백엔드에서 JWT·테넌트·역할·세션 확인 | 401 또는 403 |
| 2. Agent 실행 | AgentCore Runtime에 신원 컨텍스트 전달 | 요청 중단 |
| 3. MCP 도구 호출 | Gateway 및 AgentCore Policy에서 Tool/조건 평가 | DENY + 추적 기록 |
| 4. 도메인 권한 재검증 | 법령 ACL, 승인 역할, 문서 상태, 버전, 승인 ID 확인 | ACCESS_DENIED / CONFLICT |
| 5. 변경 실행 | 승인된 특정 버전만 게시, 멱등성 키 적용 | 재시도 또는 수동 검토 |
| 6. 감사 | 정책 판정, 실행 결과, correlation ID 기록 | 민감 정보 마스킹 |

### 11.4 정책 예시 (개념 설계)

| Tool | 조건 |
|---|---|
| `search_legal_clause` | 요청자에게 허용된 법령 scope만 조회 |
| `approve_regulation` | approver 역할 + 지정 조직 + 대상 상태 PENDING |
| `publish_wiki` | 승인 ID 유효 + 승인 문서 해시 일치 + 현재 버전 일치 + 작성자/승인자 분리 |
| `export_document` | 데이터 분류·외부 반출 정책 확인 후 실행 |

- AgentCore Policy의 세부 정책 언어와 Gateway 연동 범위는 배포 시점 지원 사양을 검증한다 (확인 필요).
- 최종 승인 기록과 ACL은 DynamoDB/업무 DB에서 원자적으로 재검증한다.
- AgentCore Identity는 최종 사용자 인가를 자동 대체하지 않는다.

### 11.5 Evaluations

목적: 법령 검색과 변경 영향 분석 품질을 Agent Trace와 정답 데이터로 지속 평가한다. 모델의 주관적 평가만으로 규정 정확성을 확정하지 않는다.

| 지표 | 평가 방법 | 출시 기준 예시 |
|---|---|---|
| 조문 인용 정확도 | citation을 law_id·version_id·clause_id·시행일 정답과 대조 | 합성 핵심 테스트 100% |
| 삭제 조항 오추천률 | DELETED 조항이 현행 규정으로 인용되는지 검사 | 0건 |
| 검색 실패 상태 정확도 | FOUND / HISTORICAL / DELETED / NOT_FOUND_VERIFIED / UNVERIFIED 분류 | 필수 케이스 100% |
| ACL·정책 위반률 | 권한 없는 Tool 호출, 타 테넌트 인용·게시 시도 | 0건 |
| 참조 관계 해석 | 제N조제M항제K호·상대참조·부칙 정답 비교 | 목표치 별도 확정 |
| 개정 영향 탐지 | 변경 조항에 연결된 Wiki/매뉴얼 탐지 재현율 | 목표치 별도 확정 |

평가 파이프라인

1. 합성 법령 Golden Dataset 생성 (정상·삭제·개정·예외·OCR 오류·권한 없음)
2. 배포 전 AgentCore Evaluations 지원 기능과 자체 deterministic evaluator 실행
3. AgentCore Observability/CloudWatch Trace에서 요청 ID, Tool 선택, 검색 근거, 판정 상태 수집
4. 정확성·보안 실패를 CI/CD 배포 차단 기준에 연결
5. 운영 중 샘플링 평가와 승인자 피드백 별도 보관

테스트 예시

| 구분 | 내용 |
|---|---|
| 입력 | "2025년 기준 제12조제2항제3호가목의 내용은?" |
| 정답 | 해당 시행 버전의 정확한 조문 ID·본문·출처, 또는 DELETED/HISTORICAL 상태 |
| 실패 | 현행 버전만 검색하고 "존재하지 않는다"고 답하거나, 삭제 조항을 현행처럼 인용 |

도입 조건: us-east-1과 ap-northeast-2의 기능·리전 가용성, HPG SCP/Endpoint/로그 정책을 각각 확인한다 (확인 필요). 실시간 운영 평가와 배포 전 오프라인 평가는 별도 실행한다. 개인정보가 포함된 Trace를 평가 입력으로 쓰지 않는다.

---

## 12. Observability·보안·운영

### 12.1 Observability

- AgentCore Observability/OpenTelemetry + CloudWatch로 `trace_id`, `agent_id`, `model`, `latency`, `token usage`, `tool call`, `Guardrails intervention`, `workflow state`를 연결한다.
- 운영 대시보드: 비용·지연·오류·재시도·검토 적체
- 업무 감사 로그(승인자·규정 버전·근거 변경)는 별도 불변 이벤트로 관리한다.

### 12.2 보안

- Prompt Injection 방어: 문서 텍스트를 untrusted content로 취급한다. Agent의 도구 실행권한을 최소화한다. 규정 원본 변경이나 외부 전송 Tool을 직접 제공하지 않는다.
- Guardrails는 추가 방어 계층이며 권한 통제를 대체하지 않는다.

### 12.3 IaC 운영 원칙

모듈별 provider alias, Terraform Remote State (S3 + DynamoDB Locking 또는 Terraform 지원 Locking), CI/CD Plan 승인, 정책 검사(Checkov/tfsec), Secret 비저장, 환경별 최소권한 IAM

### 12.4 CI/CD·장애·비용

| 항목 | 내용 |
|---|---|
| CI/CD | lint/unit → Terraform fmt/validate/plan → IaC 보안 검사 → 승인 → apply → synthetic smoke → 권한/PII E2E |
| 장애 대응 | 원본 보존, Workflow 재시도, KB 색인 롤백, 이전 문서 버전 복원 |
| 비용 관찰 | SageMaker 엔드포인트 유휴시간, OpenSearch/Neptune 상시비용, Bedrock Token, OCR 페이지 수를 분리 관찰 |

---

## 13. 테스트·품질 게이트

### 13.1 합성 데이터 원칙

- 실제 은행 내부 규정·고객정보를 쓰지 않는다.
- 가상 법령명과 가상 금융기관을 사용하고 모든 샘플에 `SYNTHETIC` 표시를 남긴다.
- 구조는 현실적으로 구성하되 실제 법률처럼 오인되지 않게 한다.

### 13.2 법령 Fixture

| 파일 | Ground Truth | 검증 |
|---|---|---|
| legal-01-circle.pdf | ①②⑩ → 항 번호 1, 2, 10 | 특수기호 OCR |
| legal-02-branch.hwpx | 제12조의2 ≠ 제12조제2항 | 가지번호 파싱 |
| legal-03-ref.pdf | 제1항제2호 / 전항 / 같은 조 | 참조 해석 |
| legal-04-deleted.pdf | 삭제 조항 및 삭제일 | 현행 검색 제외 |
| legal-05-amendment.pdf | v1/v2 조문 변경·시행일 | 버전·시점 검색 |
| legal-06-supplement.pdf | 부칙·경과조치·예외 | 적용 범위 검토 |
| legal-07-annex.pdf | 별표 1 행/열 및 조문 링크 | 표 파싱 |
| legal-08-poison.pdf | Prompt Injection 포함 | 격리·게시 차단 |
| legal-09-conflict.pdf | 공식 원본과 금액 상충 | Trust Gate 보류 |

### 13.3 일반 테스트 묶음

| 묶음 | 문서 예시 | 정답/평가 |
|---|---|---|
| 정상 규정 | 가상 여신규정 v1/v2, 시행일 차이 | 조항·버전·적용 범위 정답 |
| 정상 노하우 | 신입 심사 체크리스트, 반려 사례 | 검색 질문 → 관련 문서 라벨 |
| 변조 의심 | 가상 승인 금액 3억 → 10억 수정 | 충돌 탐지·보류 |
| PII | 가상 고객명, 가짜 계좌·전화·주소 | span/bbox 정답, 누락률 |
| Injection | 문서 내부 시스템 지시 무시 문구 | 도구 권한 우회 불가 |
| ACL | 부서 A/B 전용 문서 | 비인가 검색 노출 0건 |
| 변경 영향 | 조항 → 체크리스트 → FAQ 연쇄 | 영향 문서 정답 세트 |

### 13.4 평가 지표

| 지표 | 내용 |
|---|---|
| Structure Exact Match | 조·항·호·목 경로 완전 일치율, 고아/중복 노드 수 |
| Reference Precision/Recall | 참조 조문 ID 정확성, 미해결 비율 |
| Temporal Accuracy | 특정 날짜·적용 범위의 유효 조문 반환 정확도 |
| Deletion Safety | 삭제 조문을 현행 근거로 잘못 쓴 비율 |
| Retrieval | Recall@5, nDCG@5, MRR. Rerank 전후 비교 |
| Evidence Fidelity | 인용 ID·원문 구간 일치율, 허위 인용률 |
| Security | ACL 우회 0건, PII 노출 0건 (릴리스 게이트) |
| Change Impact | 영향 조항·Wiki 탐지 재현율, 오탐률, 검토 소요시간 |
| 기타 | OCR CER/WER, PII Precision/Recall, Trust Gate 오탐·미탐, Citation Faithfulness, P95 지연시간, 문서당 처리비용 |

| UNVERIFIED 판정 적절성 | 근거 부족·접근 장애를 UNVERIFIED로 판정하는 비율 |
| 인덱스 메타데이터 완전성 | 필수 메타데이터(law_id, clause_id, 버전, 시행일, ACL 등) 누락 없는 청크 비율 |

Baseline은 규칙 기반 / Hybrid Search only와 비교한다.

법령 수용 기준 검증 항목 (원문): ①/②/⑩, 제12조의2, 제12조제2항제3호가목, 전항·같은 조, 삭제·신설, 별표·부칙, 과거 시행일, OCR 혼동, 권한 거부. 측정: 조문 ID 파싱 정확도, 참조 해석 정확도, 삭제 조항 오추천률, UNVERIFIED 판정 적절성, 인덱스 메타데이터 완전성.

### 13.5 배포·검토 게이트

다음 경우 자동 게시를 금지한다: OCR 오류, 미해결 참조, 부칙 적용 불명확, 원본 승인 실패, 시행일 충돌. 담당자 검토 큐에는 원문 위치, AI 판단, 비교 기준, 변경 이력을 표시한다.

### 13.6 원문 일정 (참고)

> 팀 판단: 이 일정과 7분 데모는 적용하지 않는다. 일정은 `00_project_plan.md`, 데모는 `02_mvp_dod_checklist.md`(12분) 기준.

| 주차 | 개발 산출물 | 완료 조건 |
|---|---|---|
| 1주 | 합성 문서, Terraform, Auth, S3, SageMaker OCR | 업로드 → OCR → 검토 화면 |
| 2주 | Guardrails/PII, Registry, Trust Gate, 승인 | 변조 의심 문서 보류 |
| 3주 | 청킹/KB/Rerank, Neptune, 변경 영향 | 근거 검색 및 영향 탐지 |
| 4주 | Agent 가이드, 관리자 UX, Observability, E2E | 7분 데모 및 테스트 리포트 |

---

## 14. Repo·Terraform 구조

> 팀 결정: TypeScript로 구현 (원문 `apps/api`는 FastAPI, `packages/schemas`는 Pydantic). PaddleOCR 컨테이너는 Python 유지.
> 팀 결정: 원문의 `infra/` 경로는 `hanaeum-terraform/`으로 읽는다 (`infra/modules/*` → `hanaeum-terraform/modules/*`, 환경은 `hanaeum-terraform/envs/{dev-닉네임,prod}`). 경로별 소유자는 `05_rnr_ownership.md`.

### 14.1 Monorepo

```
living-wiki/
  apps/web/              # Next.js App Router, 모바일 우선 UI
  apps/api/              # 인증/검색/업로드/승인 API
  agents/                # Strands Agent, 모델 라우터, 프롬프트
  mcp/                   # regulation/search/graph/approval tools
  packages/schemas/      # 스키마/OpenAPI/공통 타입
  infra/modules/         # network, iam, s3, ocr, bedrock, kb, graph, api, observability
  infra/environments/
    hackathon-us-east-1/ # 합성 데이터 PoC
    bank-hpg/            # 기존 Landing Zone 자원 재사용
    bank-seoul/          # 국내 리전 대체 구현
  tests/fixtures/        # 합성 문서 및 정답 JSON
  tests/e2e/             # UI/API/권한/규정 변경 테스트
  docs/                  # ADR, 운영, 보안, 규제, 배포 Runbook
```

### 14.2 Legal·AgentCore 추가 경로

```
apps/api/app/legal/{routes,schemas,services,policies}/
apps/api/authz/                           # ABAC·문서 ACL·승인 상태 검증 (원문 표기 apps/backend/authz)
packages/legal-parser/{structure,unicode,reference,version,annex}/
agents/legal/{change_analyzer,ambiguity_reviewer}/
mcp/regulation-server/tools/{get_clause,resolve_reference,compare_versions}/
services/legal-etl, services/legal-reference-resolver
infra/modules/{legal-index,legal-processing,legal-graph}/
infra/modules/{legal-kb-datasource,legal-chunker-lambda,legal-intermediate-s3}/
infra/modules/agentcore-identity/         # 신원 연동 및 도구 자격증명
infra/modules/agentcore-policy/           # Gateway 정책 연결 및 권한 경계
infra/modules/agentcore-gateway/          # MCP Tool 등록과 정책 적용
infra/modules/agentcore-evaluations/      # 지원되는 평가 리소스·권한·설정
tests/fixtures/legal/{source,expected,mutations}/   # 원문 권장 tests/legal-fixtures 를 여기로 통합
tests/e2e/legal/{reference,temporal,acl,change_impact}/
tests/security/                           # 권한 우회, 역할 변경, 승인 재사용, cross-tenant
tests/evaluations/golden_legal_cases.jsonl   # 합성 정답셋 (원문 권장 tests/legal-golden 을 여기로 통합)
tests/evaluations/evaluators/             # 정형 검사 + 평가 모델 보조 판정
docs/diagrams/                            # Mermaid(.mmd) 도식 원본
observability/                            # Trace correlation, 평가 집계, 품질 대시보드
```

> 팀 결정(기본값): 경로는 `apps/api/authz`, `tests/fixtures/legal`, `tests/evaluations`로 통일하고 `docs/diagrams`를 둔다.

### 14.3 환경별 책임

| 환경 | Terraform 책임 | 제약 |
|---|---|---|
| hackathon-us-east-1 | 테스트 VPC, 저장소, OCR, API, UI, AI 연동 | 실제 은행 정보 반입 금지 |
| bank-hpg | 허용된 Workload 리소스만 배포 | Control Tower, TGW, Audit, 중앙 KMS 재생성 금지 |
| bank-seoul | 서울 리전 지원 서비스/대체 런타임 | 새 State, 데이터 이전 및 재색인 |

### 14.4 Legal KB Terraform 리소스

| 리소스 | 설계 포인트 |
|---|---|
| `aws_bedrockagent_data_source` | KB 연결, NONE 청킹, POST_CHUNKING Lambda, 중간 S3 |
| `aws_lambda_function` | 법령 청킹, 제한된 실행 역할, timeout/memory 튜닝 (원문: Python. 팀 결정: TypeScript로 구현) |
| `aws_lambda_permission` | Bedrock의 제한된 SourceArn/SourceAccount 호출 허용 |
| `aws_s3_bucket` | 정규화 원본 / 중간 산출물 분리, SSE-KMS, 수명주기 |
| IAM / KMS | S3 read/write, CloudWatch Logs, KMS 최소권한 |
| Step Functions | 사전 OCR·검증·승인·수집 실행 및 실패 재처리 |

---

## 15. HPG 이관·서울 리전 전환

> 팀 판단: MVP 범위가 아니며 참고용이다 (DoD P2는 설계만).

### 15.1 HPG 제약

| 제약 | 확인 항목 | 대응 |
|---|---|---|
| Control Tower/SCP | 허용 Region/서비스/태그/IAM | 배포 전 SCP·IAM 시뮬레이션 |
| 중앙 네트워크 | TGW, DX, Private DNS, NAT, Proxy | VPC Endpoint 우선, Egress 승인 |
| 보안·감사 | KMS, CloudTrail, Log Archive, 백업 | 중앙 통제와 연동, 재생성 금지 |
| 사내 IdP | SSO, 그룹, 권한 승인 | Cognito federation 또는 사내 인증 |
| 서비스 제한 | Bedrock/AgentCore/SageMaker/Neptune 허용 | 미지원 시 ECS/EKS 대체 |
| 운영 통제 | 변경 승인, 보안 심사, 장애 대응 | Terraform Plan/운영 Runbook 증빙 |

실제 SCP·VPC Endpoint·서비스 허용 목록·KMS 정책을 받기 전에는 구축 가능성을 확정할 수 없다. 배포는 별도 Workload Account에서 하고, Landing Zone·중앙 공유 계정 리소스는 Terraform data source로 참조한다.

### 15.2 혁신금융 검토

- 혁신금융서비스 지정은 자동 필수 요건이 아니다.
- 망분리·클라우드·개인정보·신용정보·국외 처리 규정과 은행 내부 정책을 먼저 검토한다. 기존 규정으로 구현할 수 없는 부분에 특례가 필요한지 판단한다.
- 법무·준법·정보보호 담당자와 신청 대상·보안 증빙·운영 책임을 확정한다.
- 혁신금융서비스 지정이 금융정보 국외 처리·망분리 검토의 자동 면제를 뜻하지 않는다.

### 15.3 서울 리전(ap-northeast-2) 전략

| 구성 | 전략 | 검증 게이트 |
|---|---|---|
| Claude 5.5 | 모델별 지원 및 추론 프로파일 확인, 대체 모델 옵션 | 실제 처리 리전/국외 전송 여부 |
| Cohere Rerank | 서울 미지원 시 SageMaker 자체 Reranker | 품질·성능·라이선스 |
| AgentCore | 지원 확인, 미지원 기능은 ECS/EKS Strands | MCP·추적·인증 기능 동등성 |
| PaddleOCR | 서울 SageMaker 재배포 | 컨테이너·모델·GPU 가용성 |
| KB/Graph | 서울 KB/OpenSearch/Neptune 지원 확인 | 재색인·스키마 마이그레이션 |
| Guardrails | 서울 정책·언어·PII 지원 확인 | 동등한 검출·마스킹 검증 |
| IaC/데이터 | 별도 Terraform State, S3/KMS 재암호화 | 원본·로그·백업 위치 확인 |

전환 절차

1. 데이터 등급/국외 처리 허용성 확인
2. 서비스별 리전·모델 가용성 테스트
3. 서울 전용 Terraform 배포
4. 승인된 데이터만 이관 및 재암호화
5. 청킹·임베딩·KB/Graph 재구축
6. 검색·PII·권한 회귀 테스트
7. 보안/준법 승인 후 전환

법령 파서·버전 관리자·Graph 스키마는 리전 독립적인 서비스로 설계한다.

> 팀 결정: TypeScript로 구현 (원문은 리전 독립적인 Python 서비스) 서울 리전 사용만으로 모든 규제 요구가 자동 충족되지는 않는다.

---

## 16. 화면 목록

원문 캡처는 HTML/CSS 프로토타입을 브라우저에서 렌더링한 모바일 화면이다. 실제 AWS API와 연결된 화면은 아니며 합성 데이터로 구성했다.

| No | 화면 |
|---|---|
| 01 | 사용자 홈: 검색·태그 |
| 02 | 검색 결과: 문서 카드·근거 |
| 03 | AI 업무 가이드 |
| 04 | 문서 업로드 |
| 05 | OCR·PII 검토 |
| 06 | 관리자 대시보드 |
| 07 | 규정 변경 영향 |
| 08 | Agent Observability |

공통: 하단 탭 4개 — 홈 / 검색 / 등록 / 관리.

### 16.1 화면별 필드·버튼

| 화면 | 표시 필드 | 버튼·동작 |
|---|---|---|
| 01 사용자 홈 | 검색창, "자주 찾는 태그" 칩 + 전체 보기, 추천 Wiki 카드(상태 배지 검증 완료/공식 기준, 팀·날짜·별점, 추천 이유) | [검색 결과 보기] |
| 02 검색 결과 | 태그 필터(전체/체크리스트/실무사례/공식규정), 결과 건수, 정렬 표기 "적합도순 · 권한 적용", 카드 배지(최신성 확인/공식 규정/검토 필요), 추천 근거 + 섹션 링크 | [AI 업무 가이드 생성] |
| 03 AI 업무 가이드 | "검증된 Wiki n개 기반 생성 · Sonnet 5.5", 참고용 경고 배너, 단계별 "근거: 문서명 §n" 링크 | [근거 문서 보기], [유용해요] (Feedback.usefulness에 저장) |
| 04 문서 업로드 | 허용 형식 안내(원문: PDF·DOCX·PPTX·이미지), 문서명, 공개 범위(부서 드롭다운), 문서 유형("AI 자동 분류 예정"), 실문서 업로드 금지 경고 | [분석 시작] |
| 05 OCR·PII 검토 | 배지 "작성자 확인 필요", 진행 표시 "3/4 단계", 분석 결과(문서 유형, 탐지 PII n개 구간, 공식 규정 충돌 여부, "노하우 후보" 배지), 마스킹 미리보기, 좌표 마스킹 후 재검증 안내 | [수정하기], [검토 후 게시 요청] |
| 06 관리자 대시보드 | 헤더 "ADMIN CONSOLE · APPROVER", 카운터(승인 대기, 재검증 필요), 우선 처리 카드 "규정 불일치"(공식 원본 3억 / 업로드 5억, "위조 확정 아님 · 출처 검토 필요"), "게시 승인 대기" 카드("작성자 검토 완료 · PII 마스킹 확인"), 운영 도구 링크(Agent Observability, 변경 영향 분석) | [검토하기] |
| 07 규정 변경 영향 | 공식 규정 §7 변경 전 5억 → 변경 후 3억, 영향 문서 총 n건, 문서별 "직접 영향"/"간접 영향" 배지와 사유(예: "제4절 승인 기준 수정 필요", "참조 규정 재확인 필요"), 자동 게시 안 됨 안내 | [수정안 생성 및 담당자 검토 요청] |
| 08 Agent Observability | 오늘 실행(Agent Runs), 실패 실행(재시도 포함), 모델별 호출 비중(Haiku/Sonnet/Opus %), 최근 실행 추적(단계명·지연·경로. 예: Document Intake 1.2s PaddleOCR→Haiku, PII Guardrail 0.4s "민감정보 2건 탐지·내용 비노출", Trust Verification 2.7s Sonnet→Regulation MCP, Approval Pending), "AgentCore Telemetry 연동" 표기 | — (`/v1/admin/observability` 응답 필드 후보) |

- 06의 "위조 확정 아님" 문구는 AI가 단독으로 확정하지 않는다는 원칙(1.1)을 UI로 구현한 것이다.
- 07 화면 예시(§7, 3건)와 6장 예시(제12조, 체크리스트 2 + FAQ 1)는 합성 예시 차이다.

> 팀 결정(기본값): PPTX는 MVP에서 지원하지 않는다. 업로드 허용 형식은 PDF·DOCX·HWPX·이미지(PNG/JPG).

> 팀 결정(기본값): 05 화면의 4단계와 4.1의 7단계 대응 — ① 업로드(1) ② 자동 분석(2 보안 스캔·3 OCR·4 분류·PII) ③ 작성자 검토(4 마스킹 수정·5 공식성 확인) ④ 게시 요청(6). 7 색인은 승인 후 백그라운드.

> 팀 결정(기본값): 02의 "검토 필요" 배지는 게시 후 재검증 대상(`freshness=REVIEW_REQUIRED`)을 뜻한다. 미승인 문서(`lifecycle≠PUBLISHED`)는 검색 결과에 절대 노출하지 않는다.

연동 기준: Next.js 화면 → 백엔드 인증/업무 API → Step Functions 또는 AgentCore → 상태 조회 및 감사 이벤트. 버튼 활성화는 서버 권한과 문서 상태로 판단한다.

---

## 결론

- Living Wiki의 핵심은 Agent 수가 아니라 지식의 출처·권한·버전·유효성·감사 가능성을 보장하는 Knowledge Governance다.
- 해커톤에서는 합성 문서로 정상 업로드 → 의심 문서 보류 → 규정 변경 영향 → 승인 기반 수정 → 검색·가이드의 전체 흐름을 검증한다.
- 은행 이관 전에는 HPG 실제 정책, 모델 리전, 개인정보 처리, 법적 특례 필요성을 별도 승인받아야 한다.
