평가 질의·정답 (Owner 데이터QA팀). 합성 문서는 `tests/fixtures/`(데이터엔지니어팀), 여기에는 질의·역할·기준일·정답 조문·기대 가시성만 둔다.

| 측정 | 명령 | 대상 |
|---|---|---|
| 오프라인 | `node tests/evaluations/cases/src/measure.ts` | 파싱·조문 검색·삭제 오인용·변경 영향 (메모리 KB 에뮬레이터, 로직 검증) |
| 실 KB | `set -a; . ./.env.local; set +a; node tests/evaluations/cases/src/measure-kb.ts` | prod 실 KB·DynamoDB: 조문 검색·삭제 오인용·승인 전 KB 가시성. 시드(`seed-prod.sh`) 뒤에 실행 |
| 테스트 | `npm test -w @hanaeum/eval-cases` | 측정 로직 |

- 기준일 `EVAL_TODAY = 20261216` 고정: 합성 개정본 v2 시행일(2026-12-01) 이후 시나리오. 케이스 `as_of`도 대부분 2026-12-15 (총괄팀 결정 11/20).
- 근거 인용(`citation.jsonl`)·UNVERIFIED(`unverified.jsonl`)는 AI엔지니어팀이 답변 단계에서 측정한다. 인용 정답 12/20건이 F-002(데모 업로드) 근거라 F-002 게시 후 측정.
