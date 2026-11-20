# R&R · 코드 소유권 · 일정

> 누가 어떤 코드·단계·검증을 책임지는지의 단일 기준. 역할 요약은 `00` 2장, 일정 요약은 `00` 3장.
> 소유자(Owner)만 해당 경로를 직접 수정한다. 다른 사람은 PR로 제안하거나 Owner 팀에 Orca로 요청한다.
>
> **11/20부터 역할별 팀 체제로 바뀌었다.** 팀·소유 경로·소통 방식은 `role/README.md`가 기준이다. 아래 닉네임 기준 표는 11/20 이전 이력이다. 일정(6장)과 측정 항목(5장)은 계속 유효하다.

## 1. 역할

| 닉네임 | 이름 | 영역 | 한 줄 책임 |
|---|---|---|---|
| yoyo0704 | 김동연 | 인프라·플랫폼 | AWS 리소스 전체, OCR 컨테이너, 워크플로 배선(ASL), CI, 관측·평가 실행기, **최종 배포** |
| let522mj | 김민정 | 데이터·검색 | 합성 데이터·정답, 법령 파서, 공유 스키마, KB 색인·검색, 그래프, 검색 계열 MCP Tool |
| dhxorb96 | 오태규 | 업무 로직·Agent·UI | Backend API, 승인·Trust Gate·PII, Agent, 승인·개인정보 MCP Tool, 화면 8종 |

## 2. 경로별 소유권

| 경로 | Owner | 리뷰어 | 비고 |
|---|---|---|---|
| `package.json`(root), `tsconfig.base.json`, `.github/workflows/` | yoyo0704 | dhxorb96 | 워크스페이스 추가는 각자 PR, root 설정 변경만 Owner |
| `package-lock.json` | 수정한 사람 | — | 충돌 시 main으로 rebase 후 `npm install`로 재생성 (손으로 병합 금지) |
| `hanaeum-terraform/` | yoyo0704 | let522mj | 다른 사람이 필요한 리소스는 `요청기록/`으로 |
| `services/ocr/` (Python 컨테이너) | yoyo0704 | let522mj | 출력 스키마는 `04` 2.1 |
| `services/convert-pdf/` (LibreOffice 컨테이너 Lambda) | yoyo0704 | let522mj | ConvertToPdf 단계 (11/17) |
| `workflows/` (Step Functions 정의·에러 처리·failure-catcher) | yoyo0704 | dhxorb96 | 단계 Lambda 코드는 3장 Owner |
| `mcp/observability-server/` | yoyo0704 | dhxorb96 | |
| `tests/evaluations/runner/`, `observability/` | yoyo0704 | let522mj | 평가 실행·결과 집계 |
| `packages/schemas/` (zod, enum, ID) | let522mj | dhxorb96 | **공유 계약의 단일 원본**. 변경 시 `interfaces.md` 변경 이력 기록 |
| `packages/legal-parser/` | let522mj | dhxorb96 | |
| `services/legal-etl/`, `services/kb-chunker/` | let522mj | yoyo0704 | Custom Transformation Lambda |
| `mcp/regulation-server/`, `mcp/search-server/`, `mcp/graph-server/` | let522mj | dhxorb96 | Gateway Lambda Target |
| `tests/fixtures/`, `tests/evaluations/cases/` | let522mj | dhxorb96 | 합성 문서와 평가 질의는 분리 |
| `apps/api/` | dhxorb96 | yoyo0704 | |
| `apps/web/` | dhxorb96 | let522mj | |
| `agents/` | dhxorb96 | let522mj | |
| `mcp/approval-server/`, `mcp/privacy-server/` | dhxorb96 | yoyo0704 | |
| `mcp/gateway-interceptor/` | dhxorb96 | yoyo0704 | Gateway REQUEST interceptor (`__actor` 주입) |
| `services/auth-triggers/` | yoyo0704 | dhxorb96 | Cognito Pre Token V2 (access token `dept`) |
| `tests/e2e/`, `tests/security/` | dhxorb96 | yoyo0704 | |
| `docs/interfaces.md` | 섹션별 Owner | 나머지 2명 | |

리뷰 규칙: 리뷰어 1명 승인 + CI 통과 후 main 병합 (`06` 2장).

## 3. 문서 처리 14단계 담당

입출력 계약은 `interfaces.md` 6장. 단계 정의는 `04` 1.1.

| 단계 | 코드 Owner | 입력 | 출력 |
|---|---|---|---|
| 0. 업로드 URL·type-detection | dhxorb96 | 업로드 요청 | `quarantine/{doc_id}/original.*` |
| 1. MalwareCheck | yoyo0704 | S3 객체 | GuardDuty 결과 |
| 2. FileStructureCheck | dhxorb96 | original | Findings |
| 2.5 ConvertToPdf (11/17 신규) | yoyo0704 | original | `work/document.pdf` |
| 3a. TextLayerExtract | let522mj | original·document.pdf | `work/text_layer.json` (document.pdf가 있으면 쪽 수·모든 쪽 OCR 대상. TXT·MD만 글자) |
| 3b. PageRender | yoyo0704 | document.pdf | `work/pages/{n}.png` (모든 쪽) |
| 4. OcrIfNeeded | yoyo0704 | 페이지 이미지 | `work/ocr/result.json` (모든 쪽) |
| 5. SegmentBuild | let522mj | ocr (TXT·MD는 text_layer) | `work/segments/{n}.json` |
| 6. PiiScan·마스킹 | dhxorb96 | segments | `masked/` + Findings |
| 7. InjectionScan | dhxorb96 | masked | Findings |
| 8. Classify | dhxorb96 | masked | Documents.classification |
| 9. TrustGate | dhxorb96 | masked + Registry | PASS / REVIEW_REQUIRED / QUARANTINED |
| 10. WaitForApproval | dhxorb96 (API) · yoyo0704 (ASL) | task token | Approvals |
| 11. Promote + `.metadata.json` | let522mj | 승인 레코드 | `published/…` |
| 12. KbIngest | let522mj | published | Ingestion Job COMPLETE |
| 13. GraphUpsert | let522mj | 승인된 관계 후보 | Neptune |
| 14. Finalize | dhxorb96 | 전 단계 결과 | lifecycle=PUBLISHED, 감사 이벤트 |
| 공통: 에러 처리·failure-catcher·재시도 | yoyo0704 | — | — |

## 4. MCP Tool 소유

| MCP 서버 | Tool | Owner | 정책 |
|---|---|---|---|
| regulation | `get_official_policy`, `verify_version`, `get_clause`, `resolve_reference`, `compare_versions` | let522mj | 읽기 전용 |
| search | `search_wiki`, `retrieve_evidence`, `search_legal_clause` | let522mj | ACL 필터 서버 주입 |
| graph | `trace_impact`, `get_dependencies` | let522mj | 사용자 범위 필터 |
| approval | `create_review_request`, `get_status`, `draft_change` | dhxorb96 | 승인·게시 실행 Tool 없음 |
| privacy | `detect_sensitive_data`, `masking_preview` | dhxorb96 | 원본 전달 최소화 |
| observability | `get_agent_trace`, `get_usage` | yoyo0704 | PLATFORM_OPERATOR 전용 |

- `publish_wiki`·`approve_regulation`은 **Agent에 노출하지 않는다** (Backend API에서 사람만 실행). 데모 06의 "비인가 게시 호출 거부"는 아래 두 경로로 각각 검증한다.
  - Policy 경로: 테스트 전용 Tool `publish_wiki_probe`를 Gateway에 등록하고 Policy로 USER·AUTHOR를 Deny → Deny Trace 확인 (P1)
  - Backend 경로: USER 토큰으로 `POST /v1/approvals/{id}/decision` → 403 + 감사 기록 (P0 대체 경로)

## 5. 정량 기준 측정 담당 (`02` 4장)

| 항목 | 측정 Owner | 데이터 제공 |
|---|---|---|
| 정상 등록 5 / 위조 차단 5 / Injection 5 | dhxorb96 | let522mj |
| 노하우 충돌 4/5 | dhxorb96 | let522mj |
| 법령 구조 파싱 95% | let522mj | let522mj |
| 정확 조문 검색 19/20 | let522mj | let522mj |
| 삭제 조항 오인용 0 | let522mj | let522mj |
| 변경 영향 탐지 5/5 | let522mj | let522mj |
| 승인 전 KB 가시성 0건 | let522mj | dhxorb96 (미승인 문서 생성) |
| 비인가 게시 5건 거부 | dhxorb96 | yoyo0704 (Policy) |
| 근거 인용 19/20, UNVERIFIED 오판 0 | dhxorb96 (답변 단계) | let522mj (정답) |
| 전체 결과표 집계 | yoyo0704 (평가 실행기) | 전원 |

## 6. 일정 (일 단위 완료 조건)

| 날짜 | 공동 완료 조건 (증빙) | yoyo0704 | let522mj | dhxorb96 |
|---|---|---|---|---|
| 11/16 (M0) | 공유 스키마·경로 소유권·버전 고정, 계정·모델·GPU 쿼터 확인 | State 버킷, 모델 액세스·쿼터 확인, 버전 고정표 | `packages/schemas` v0, 합성 문서 10건 초안 | Runtime→Gateway Tool 1회 호출 시험, API 목록 v0 |
| 11/17 | **공유 dev 환경 배포**, 로그인·업로드·텍스트 추출 | VPC·S3·Cognito·DynamoDB·SFN 골격 배포 | Parser v0, Registry 기준본·해시 fixture | 업로드 URL·type-detection·로그인 화면 |
| 11/18 | **정상 문서: 검사 → 승인 → KB 색인 → 검색** E2E 1건 | KB·OpenSearch·OCR 엔드포인트 | Chunker Lambda·Promote·KbIngest, search Tool | PII·분류·승인 API·검색 화면 |
| 11/19 | 위조·Injection·미승인 차단, 정확 조문 조회·근거 답변 | Guardrails·GuardDuty, Observability 수집 | Exact Lookup·검색 상태, Golden 60건 | Trust Gate·Injection, 검색·가이드 Agent |
| 11/20 | 노하우 충돌, v1→v2 Diff·영향 탐지·재검증 반영 | Neptune·평가 실행기 | GraphUpsert·Change Impact | 노하우 검증·변경 영향 화면·수정 초안 |
| 11/21 | **P0 자동 평가 전체 통과** 후 P1 착수 | AgentCore Policy·Evaluations | 정량 기준 측정 | 보안 테스트(승인 재사용·ACL·PII), 추천·평점 |
| 11/22 | 전체 회귀, 12분 리허설 1회, 결과표 확정 | prod 환경 배포 리허설 | 데이터 QA 결과표 | UI QA·E2E 01~06 |
| 11/23 (M3) | 검증된 버전 prod 배포·smoke·최종 리허설 | 최종 배포 | 결과표 `02`에 기입 | 데모 진행 |

- P1(Policy·Evaluations·추천)은 11/21 P0 통과 후 착수한다. 미완성 시 데모 06은 Backend 권한 거부 + 평가 결과표로 대체한다.
- 매일 18:00(KST) main 통합. 다음 날 작업은 최신 main에서 시작한다.
- 앞 단계가 늦으면 mock(fixture·stub)으로 진행하되, `공통기록/`에 mock임을 표시하고 실연동 날짜를 적는다.
