# plan · let522mj · 데이터·검색

기준: `TODO.md`, DoD `docs/02` 4장. AWS 리소스(KB·DynamoDB·Neptune)는 yoyo0704 배포 전이라 **AWS 호출부는 얇은 어댑터 + 인메모리 mock**으로 두고, 로직은 오프라인 테스트로 검증한다.

공통 도구: npm workspaces, TypeScript, Node 내장 test runner(`node --test`, type stripping). 추가 테스트 프레임워크 없음.

| # | 작업 | 경로 | 완료 조건 (DoD·QA) | 의존 / mock |
|---|---|---|---|---|
| 1 | 공유 스키마 v0 | `packages/schemas` | `interfaces.md` 1·2·5·6장 전 항목이 zod로 존재, ID 정규식 테스트 통과 | dhxorb96 리뷰 |
| 2 | Legal Parser v0 | `packages/legal-parser` | `docs/04` 6.2 규칙 + 6.3 엣지 케이스 전부 테스트 통과, L-001 정답 대비 구조 정확도 ≥ 95% | 없음 |
| 3 | 합성 데이터 10건 + Registry 기준본 | `tests/fixtures` | F/K/A/L 10건, 모두 `SYNTHETIC` 표시, F-001 해시 fixture | 없음 |
| 4 | 단계 3a·5·11·12 | `services/legal-etl` | 단계 IO 계약(`interfaces.md` 6장) 준수, 빈 결과 성공 금지, Ingestion COMPLETE+실패 0건만 OK | S3·KB는 yoyo0704 배포 후 실연동 (mock) |
| 5 | KB Chunker | `services/kb-chunker` | 항 단위 청크, 헤더 포함 `augmented_search_text`, **임베딩 입력이 본문 포함** 테스트 | KB 이벤트 계약은 공식 문서로 재확인 필요 |
| 6 | search-server | `mcp/search-server` | 서버 주입 ACL 필터(`listContains`, 1그룹 단일 조건), DynamoDB 현재 상태 재검증 테스트 | KB Retrieve mock |
| 7 | regulation-server | `mcp/regulation-server` | Exact Lookup + 검색 상태 5종, UNVERIFIED ≠ NOT_FOUND_VERIFIED | 조문 저장소 인메모리 (DynamoDB 키는 yoyo0704와 합의) |
| 8 | graph-server + Change Impact | `mcp/graph-server` | F-001→F-002 Diff, 역방향 탐색으로 영향 노하우 5/5, openCypher `UNWIND MERGE` 배치 50 | Neptune mock |
| 9 | Golden Dataset 60 + 평가 케이스 | `tests/fixtures`, `tests/evaluations/cases` | 3.2 구성 60건, 4장 측정 질의 포함 | 없음 |
| 10 | 데이터 QA 측정 스크립트 | `tests/evaluations/cases` | 파싱 95%, 조문 검색 19/20, 삭제 오인용 0, 영향 5/5 오프라인 측정 | KB 실측은 배포 후 |
