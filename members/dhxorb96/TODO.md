# TODO · 오태규 (dhxorb96) · 업무 로직·Agent·UI

필수 문서: `docs/05`, `docs/06`, `docs/interfaces.md` 2·7·9장. 참조: `docs/01` 3·4·5·9·10·11·16장, `docs/02` 2·4·5·6장, `docs/04` 1·3·4.3·7·8장.
소유 경로: `apps/api/`, `apps/web/`, `agents/`, `mcp/{approval,privacy}-server/`, `tests/e2e/`, `tests/security/`.
**UI QA·E2E·보안 테스트 담당**.

## 11/16 · M0
- [ ] `scripts/setup-env.sh dhxorb96`, 계정 ID 확인
- [ ] **AgentCore 연결 실험**: Strands TS 최소 Agent → arm64 이미지 → Runtime `/ping`·`/invocations` → 모델 1회 호출 → Gateway `tools/list`·`tools/call` (stub Lambda 1개) 성공. 신원 전달 방식 확정 → `interfaces.md` 9장
- [ ] Backend 프레임워크·Strands SDK·Next.js 버전 결정 → `interfaces.md` 8장
- [ ] UI 디자인 skill 확인 (공식 출처). 없거나 막히면 skill 없이 진행

## 11/17
- [ ] `apps/api` 골격: Cognito JWT 검증, RBAC(그룹) 미들웨어, 공통 오류 형식
- [ ] `POST /v1/documents/upload-url`(SigV4·리전 엔드포인트), 단계 0 type-detection(허용 PDF·DOCX·HWPX·PNG/JPG), 단계 2 FileStructureCheck
- [ ] `apps/web` 골격: 로그인, 하단 탭(홈/검색/등록/관리), 업로드 화면 04

## 11/18
- [ ] 단계 6 PiiScan: 정규식·체크섬·사전 → ApplyGuardrail → 마스킹 → 불확실 시 REVIEW_REQUIRED. **원문은 모델에 보내지 않음**, bbox 이미지 마스킹 (`docs/04` 1.1)
- [ ] 단계 8 Classify (마스킹 텍스트, `temperature 0`, 구조화 출력, 결과·confidence·rationale·사람 수정 이력 저장)
- [ ] 승인 API: 대기 목록, decision(APPROVE/REJECT/REVALIDATE + 사유), **승인 바인딩**(`interfaces.md` 7.1), 단계 10 task token 처리
- [ ] 화면: OCR·PII 검토(05), 승인 관리, 메인 검색(01)·결과(02)
- [ ] **E2E 1건**: 업로드 → 승인 → (let522mj 색인) → 검색

## 11/19
- [ ] 단계 7 InjectionScan, 9 TrustGate (Registry 대조 → PASS/REVIEW_REQUIRED/QUARANTINED), 14 Finalize
- [ ] 검색·가이드 Agent (Strands, `docs/01` 9장 라우팅): 질의 PII 검사 → search Tool → 인용·시행일·검증 상태·불확실성 표시 → Guardrails 출력 검사
- [ ] `mcp/privacy-server`, `mcp/approval-server` (`create_review_request`, `get_status`, `draft_change`)
- [ ] 화면: Trust Gate, 가이드(03)
- [ ] 테스트: 정상 5 승인, 위조 5 차단, Injection 5 KB 유입 차단

## 11/20
- [ ] 노하우 검증: 관련 조문 충돌·근거 (K-002), 최신성 (K-003), 조건부 (K-004)
- [ ] Change Impact 화면·수정 초안: let522mj 영향 집합 → `freshness=REVIEW_REQUIRED` 전환 → 수정안 → 재승인 (자동 게시 금지)
- [ ] 화면: 노하우 검증, 변경 영향(07), 관리자 대시보드(06)
- [ ] 테스트: 노하우 충돌 4/5

## 11/21
- [ ] 보안 테스트 `tests/security`: 승인 재사용·자기 승인·검사 후 변경·중복 callback, ACL(모든 조회 경로), 질의 PII, 비인가 게시 5건(Backend 403)
- [ ] 답변 품질: 근거 인용 19/20, UNVERIFIED 오판 0 (let522mj 정답 사용)
- [ ] (P0 통과 후) 추천·평점(`POST /v1/feedback`, 인기와 신뢰성 분리), Agent 평가 화면(08)

## 11/22 · 11/23
- [ ] UI QA (모바일·데스크톱 반응형), E2E 데모 01~06
- [ ] 12분 데모 리허설·진행 (`docs/02` 5장)
