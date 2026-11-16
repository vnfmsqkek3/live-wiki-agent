# 요구사항 추적표 · let522mj (데이터·검색)

기준: `docs/02` 2장 DoD·3장 데이터·4장 정량 기준·5장 데모, `docs/05` 6장 일정. 작업 단위마다 갱신한다.
상태: **완료**(실환경 증빙 있음) / **부분**(로직·오프라인 또는 일부 실환경만, 남은 조건 명시) / **대기**(선행 조건 미충족) / **미착수**
`docs/02` 1장: 화면·mock만으로 완료 처리 금지, 입력→판단→통제→결과→검증 근거 연결, 반복 실행 가능한 테스트.

마지막 갱신: 2026-11-17 03:13 (하나은행 재게시 19건, 공유 dev dc1ba61 반영, 실환경 정량 5종 통과, Nori)

## 1. 기능별 DoD (`docs/02` 2장, let522mj 담당분)

| 우선 | 기능 | 완료 기준 | 상태 | 증빙 | 남은 조건 |
|---|---|---|---|---|---|
| P0 | 승인·게시 (인덱싱) | 승인 전 검색 제외, 승인 후에만 공개 인덱싱 | 부분 | Promote 승인 1회 사용·해시 바인딩, KB 필터 `lifecycle=PUBLISHED`, 검색 재검증 (테스트). Lambda 배포 | 실환경: 승인 API 경유 Promote(USED 1회)→KbIngest→검색 FOUND, Finalize 전 재검증 제외 14/14. 남은 것: 6·9단계 SFN 연결 후 전 구간 무대체 E2E, 가시성 측정 |
| P0 | 법령 전처리 | 조·항·호·목, 삭제, 시행일 보존 + Custom Chunking | 부분 | 공개 법령 10건 구조 12,589/12,589, chunker Lambda 실환경 실행(F-002 → 15청크) | KB 데이터 소스에 chunker 연결 후 실 색인 |
| P0 | 검색 (답변은 dhxorb96) | 정확한 조문·근거·시행 버전·불확실성 | 부분 | 실 DynamoDB 정확 조문 20/20, search Lambda 실환경 응답(빈 KB → UNVERIFIED) | KB 색인 후 HYBRID 검색 결과 확인, Gateway 등록 |
| P0 | Change Impact (탐지) | 개정 규정에 영향받는 노하우 탐지 | 부분 | 오프라인 5/5·오탐 0, F-001→F-002 Diff | Neptune(11/20) 실연동 |
| P1 | Evaluations (정답) | Golden Dataset 평가 결과·실패 사례 조회 | 부분 | Golden 60건, 조문 20·인용 20 케이스, `sets.json` | yoyo0704 평가 실행기 연결 |

## 2. 정량 기준 (`docs/02` 4장, 측정 Owner let522mj)

측정: `measure-kb.ts` 공유 dev 실환경(KB U5XVDUWYLS, Nori, Rerank 3.5, 하나은행 규정 19건 게시, 코드 dc1ba61) — 2026-11-17 03:13

| 항목 | 목표 | 현재 | 측정 환경 | 상태 |
|---|---|---|---|---|
| 법령 구조 파싱 | 95% | 합성 100% (305/305), 공개 법령 100% (12,589), OCR 보정 후 문서별 100% | 오프라인 + 실 OCR | 완료 |
| 정확 조문 검색 | 19/20 | **20/20** | 실환경 | 완료 |
| 삭제 조항 오인용 | 0 | **0** | 실환경 | 완료 |
| 근거 인용 | 19/20 | **19/20**, 금지 근거 0 | 실환경 | 완료 |
| 검색 실패 판정 (UNVERIFIED 단정) | 0 | **0** (UNVERIFIED 5/5) | 실환경 | 완료 |
| 승인 전 KB 가시성 | 0건 | 0/20 (지정 차단 문서는 미업로드 상태) | 실환경 | 부분 (위조·공격 문서 실제 업로드 차단 확인 남음) |
| 변경 영향 탐지 | 5/5 | 오프라인 5/5·오탐 0, 실환경 Neptune 탐지 1건 확인(QA K-001) | 오프라인 + 실 Neptune | 부분 (노하우 정답 문서 게시 후 실환경 5/5) |

## 3. 데이터 (`docs/02` 3장)

| 항목 | 상태 | 증빙 |
|---|---|---|
| 데모 핵심 10건 (F/K/A/L) | 완료 | `tests/fixtures/documents/manifest.json`, SYNTHETIC 표시 테스트 |
| Golden Dataset 60건 (15/15/10/10/10) | 완료 | `tests/fixtures/golden/manifest.json`, 구성 테스트 |
| Registry 기준본 | 완료 | `registry*.json` 해시 일치 테스트, 실 Regulations 테이블 적재 |

## 4. 데모 구간 중 let522mj 몫 (`docs/02` 5장)

| 구간 | 항목 | 상태 |
|---|---|---|
| 02 | 차단 문서가 일반 사용자 검색 결과에 없음 | 대기 (E2E) |
| 04 | 개정 전후 Diff 표시, K-001/K-003 탐지 | 부분 (오프라인, Neptune 대기) |
| 05 | 승인된 규정·노하우 함께 검색 | 대기 (KB 색인) |
| 05 | 제12조제2항제3호가목 계층 탐색 | 완료 (실 DynamoDB 조회) |
| 05 | 출처·시행일·검증 상태 제시 | 부분 (응답 계약 반영, 실 KB 대기) |
| 05 | 삭제/미확인 조항 DELETED / UNVERIFIED 구분 | 완료 (실 DynamoDB 조회) |

## 5. 일정 (`docs/05` 6장)

| 날짜 | let522mj 완료 조건 | 상태 | 비고 |
|---|---|---|---|
| 11/16 M0 | `packages/schemas` v0, 합성 10건 | 완료 | schemas 리뷰는 PR #3 (dhxorb96) |
| 11/17 | Parser v0, Registry 기준본·해시 fixture | 완료 | 공개 법령 검증까지 |
| 11/18 | Chunker·Promote·KbIngest·search Tool, **E2E 1건** | 완료 (11/16 21:01 AgentCore 오케스트레이터 전 구간 대체 없이 PUBLISHED, dhxorb96 검증 `doc_01M7J3JDCF85X2T0AENC1F14K8`) | Lambda 7개 배포·SFN·KB chunker 연결 완료(yoyo0704, 11/16). E2E는 승인 API 경유로 진행 예정 |
| 11/19 | Exact Lookup·검색 상태, Golden 60 | 완료 | 실 DynamoDB 20/20 |
| 11/20 | GraphUpsert·Change Impact | 부분 | 로직·오프라인 완료, Neptune 대기 |
| 11/21 | 정량 기준 측정 | 부분 | 오프라인 완료, 실환경 재측정 필요 |
| 11/22·23 | 데이터 QA 결과표 → `docs/02` 4장 기입 | 부분 | 실환경 5종 완료(위 2장), 영향 탐지·차단 업로드 남음 |

## 6. 측정 도구

| 도구 | 환경 | 실행 |
|---|---|---|
| `tests/evaluations/cases/src/measure.ts` | 오프라인 (메모리 KB) | `node …/measure.ts` |
| `tests/evaluations/cases/src/measure-kb.ts` | 실환경 (SSM의 KB·DynamoDB) | `set -a; . ./.env.local; set +a; node …/measure-kb.ts` (약 1분 30초) |
| `tests/evaluations/cases/src/public-laws.ts` | 오프라인 (공개 법령 10건) | `node …/public-laws.ts` |

실환경 기준값 (11/16 19:10, KB 색인 0건): 조문 20/20, 삭제 오인용 0, 노출 0/20, Recall@5 0/20. **E2E 색인 후 같은 명령으로 재측정해 4장에 기입**.
