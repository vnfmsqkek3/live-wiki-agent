# TODO · 김민정 (let522mj) · 데이터·검색

필수 문서: `docs/05`, `docs/06`, `docs/interfaces.md` 1·2·5장. 참조: `docs/01` 6·7·8·13장, `docs/02` 3·4장, `docs/04` 4·5·6장(정규식·엣지 케이스·KB 메타데이터).
소유 경로: `packages/schemas/`, `packages/legal-parser/`, `services/legal-etl/`, `services/kb-chunker/`, `mcp/{regulation,search,graph}-server/`, `tests/fixtures/`, `tests/evaluations/cases/`.
**데이터 QA 담당**: 파싱·청킹·메타데이터·검색 정확도.

## 11/16 · M0
- [ ] `scripts/setup-env.sh let522mj`, 계정 ID 확인
- [ ] `packages/schemas` v0: `interfaces.md` 1·2·5장의 ID·enum·메타데이터를 zod로 (dhxorb96 리뷰)
- [ ] 합성 데이터 데모 핵심 10건 초안 (F-001~003, K-001~004, A-001~002, L-001) — `SYNTHETIC` 표시

## 11/17
- [ ] Legal Parser v0 (TS 상태 머신, `docs/04` 6.2 정규식) + 엣지 케이스 테스트 (`docs/04` 6.3)
- [ ] Registry 기준본: F-001 승인 기준 해시·버전 fixture (Trust Gate가 대조할 기준, 업로드 문서가 기준이 되지 않게)
- [ ] 단계 3a TextLayerExtract, 5 SegmentBuild
- [ ] 조문 구조화 저장소 설계 (DynamoDB Regulations 키·GSI를 yoyo0704와 합의) — Exact Lookup·과거 버전 조회용

## 11/18
- [ ] KB Custom Transformation Lambda (`services/kb-chunker`): 조 Parent / 항 Child, 문맥 헤더(법령명·시행일·경로), `original_text`·`augmented_search_text` 분리, **임베딩 입력이 본문인지 테스트**
- [ ] 단계 11 Promote(`.metadata.json` 생성, `interfaces.md` 5장) · 12 KbIngest(COMPLETE 확인 후에만 다음 단계)
- [ ] `mcp/search-server`: `search_wiki`, `retrieve_evidence` — KB Retrieve HYBRID + 서버 주입 ACL 필터(`listContains`) + Rerank + DynamoDB 현재 상태 재검증 (`docs/04` 4.3)
- [ ] **E2E 1건**: 승인된 F-001 → 색인 → 검색 결과 확인

## 11/19
- [ ] Exact Lookup(조문 ID + 유효기간) + 검색 상태 `FOUND/HISTORICAL/DELETED/NOT_FOUND_VERIFIED/UNVERIFIED`
- [ ] `mcp/regulation-server`: `get_official_policy`, `verify_version`, `get_clause`, `resolve_reference`, `compare_versions`
- [ ] Golden Dataset 60건: `tests/fixtures/documents/` (문서) + `tests/evaluations/cases/` (질의·역할·기준일·정답 조문·기대 가시성) 분리
- [ ] 승인 전 문서 KB 가시성 0건 테스트

## 11/20
- [ ] 단계 13 GraphUpsert (Neptune openCypher, 결정적 ID, `UNWIND MERGE` 배치 50, 쓰기 직렬화, 모든 노드에 `doc_id`) — `docs/04` 5장
- [ ] Change Impact: F-001→F-002 조항 Diff, 역방향 탐색으로 영향 노하우 집합·근거 생성 → dhxorb96에 전달
- [ ] `mcp/graph-server`: `trace_impact`, `get_dependencies`

## 11/21
- [ ] 정량 기준 측정 (`docs/05` 5장 담당분): 파싱 95%, 조문 검색 19/20, 삭제 오인용 0, 영향 탐지 5/5, KB 가시성
- [ ] 미달 항목은 Owner에게 `요청기록/`

## 11/22 · 11/23
- [ ] 데이터 QA 결과표 확정 → `docs/02` 4장 측정 결과 기입
