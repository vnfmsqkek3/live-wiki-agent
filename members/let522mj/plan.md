# plan · let522mj · 데이터·검색

## ▶ 다음 세션 시작 절차 (이 순서대로 자동 실행)

`let522mj`는 이미 원격에 push된 브랜치다. **rebase 후 force push는 금지**이므로 동기화는 merge로 한다.

```bash
cd live-wiki-agent
set -a; . ./.env.local; set +a          # 없으면 scripts/setup-env.sh let522mj czy1023-naver
git status --short                      # 깨끗해야 함. 변경 있으면 사용자에게 묻기
git fetch origin --prune
git switch let522mj && git pull --ff-only origin let522mj
git merge --no-edit origin/main         # 충돌 시 아래 'PR #1 병합 후 할 일' 참고
npm install && npx tsc -p tsconfig.json && npm test   # 55개 통과가 기준
gh pr list --state all                  # PR #1·#2 병합 여부 확인
```

그다음 읽기: `공통기록/` 최신 10건 → `요청기록/` 중 `*_to_let522mj.md` OPEN 건 → 이 파일 '남은 작업' → `트러블슈팅.md`.
마지막 상태 (11/16 18:30): 로직·오프라인 테스트 완료, AWS 실연동 대기. 다음 작업은 아래 '남은 작업 (실연동)' 첫 행부터.

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

## 진행 상황 (11/16 17:35)

| # | 상태 | 비고 |
|---|---|---|
| 1~10 | 로직·오프라인 테스트 완료 | TODO의 [x]는 **로직 기준**. AWS 호출부는 mock (실연동 전) |

## 남은 작업 (실연동)

| 작업 | 선행 조건 | DoD |
|---|---|---|
| KB 1건 색인 → HYBRID Retrieve 성공 확인, Custom Transformation 이벤트 형식 검증 | yoyo0704 KB·OpenSearch·Lambda 배포 | 실제 이벤트로 `kb-chunker` 통과 |
| **E2E 1건**: 승인된 F-001 → 색인 → 검색 | 위 + dhxorb96 승인 API | 검색 결과에 F-001 조문·`original_text` |
| 승인 전 문서 KB 가시성 0건 | dhxorb96 미승인 문서 생성 | `golden` expected_kb_visibility=false 전부 0건 |
| Regulations 키 합의 → `DynamoClauseStore` 실연동 | yoyo0704 회신 (요청기록) | `get_clause` 실 테이블에서 FOUND |
| Neptune 실연동 (`NeptuneGraphStore`) | 11/20 Neptune 배포 | trace_impact 5/5 실그래프 |
| 공개 법령 샘플로 파서 일반화 검증 | 국가법령정보센터 자료 (자료/데이터원천/법령) | 조·항·호·목 95% |
| DOCX·HWPX 텍스트 추출 | 필요 시 (데모는 PDF/텍스트) | 미구현 상태 명시 실패 → 구현 |

## PR #1(yoyo0704 repo 골격) 병합 후 할 일

- root `package.json`·`tsconfig.base.json`·`package-lock.json` 충돌 예상 → **yoyo0704 버전 채택** (Owner). 내 root 3파일·`.npmrc`는 버리고 rebase
- yoyo0704 root는 워크스페이스별 `npm test`/`typecheck` 실행 → 각 워크스페이스 `package.json`에 `"test": "node --test src/**/*.test.ts"`, `"typecheck": "tsc -p ../../tsconfig.json"` 류 스크립트 추가 필요
- TS 6.0.3 + `noUncheckedIndexedAccess`에서 typecheck 재확인, `workspaces`에 `tests/evaluations/cases` 추가 요청 (현재 `tests/evaluations/runner`만 있음)
- `docs/interfaces.md` 양쪽 수정 → 섹션별로 병합 (1·2·5 내 것, 8 버전표 합침)
