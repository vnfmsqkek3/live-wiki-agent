E2E·통합 시나리오 (Owner dhxorb96). 문서 처리 검증은 AgentCore 오케스트레이터 CLI `agents/scripts/pipeline.ts`로 한다 (Step Functions 폐기, 11/16).

- `qa-prod-flow.mjs`: prod 끝까지 시험(올리기→검토→게시→정리본 그림→다운로드→수정 요청). 입력은 `inputs/`, 항목 표는 `members/dhxorb96/qa/20261118_prod시험_체크리스트.md` (11/18)

## qa-demo 점검표 (데모 01~06 + 정량 화면 확인)

`QA_BASE=https://<prod CloudFront> QA_SCRIPT=qa-demo.mjs tests/e2e/qa-run.sh`. 결과는 `$QA_OUT/qa-demo-result.json`과 스크린샷. 샘플은 `tests/evaluations/cases/sets.json`을 읽는다.
`QA_PART=demo`는 데모 문서 6건만 올린다. prod가 데모 환경이므로 기본은 아무것도 게시하지 않는다: Q1은 결재함 승인 버튼까지 보고, 끝에 이 실행이 게시 요청한 `[SYNTHETIC] QA …` 문서를 admin이 모두 반려한다(BLOCKED, 검색 제외). 실제 승인·게시까지 보려면 `QA_APPROVE=1`(총괄팀 승인 필요, M04 F-002 업로드도 이때만). 실행 전 총괄팀 승인.

| ID | 기준 (`docs/02`) | 통과 |
|---|---|---|
| Q1 {id} | 4장 정상 등록 5 | 분석 통과 → 게시 요청 성공 → 결재함에 승인 버튼 (`QA_APPROVE=1`이면 승인 후 10분 안에 PUBLISHED까지) |
| Q2 {id} | 4장 위조 차단 5 | 분석 차단·게시 요청 거부·결재함 반려만 중 하나, user 검색에 안 보임. 결재함에 승인 가능으로 올라오면 PART |
| Q3 {id} | 4장 Injection 5 | Q2와 같음 (KB 유입 0) |
| Q4 | 4장 비인가 게시 5 | user 세션의 결재 결정 요청 5회가 모두 403, user가 `/admin`을 열면 '볼 수 없는 화면' |
| M01 | 5.1 데모 01 | 메인에 검색창·추천 카드·태그 |
| M02 | 5.1 데모 02 | F-001 승인 가능, F-003 차단, A-001 보안 검사 결과, 차단 문서 검색 제외 |
| M03 | 5.1 데모 03 | K-001 근거 규정 표시, K-002 충돌 표시와 게시 보류 |
| M04 | 5.1 데모 04 | F-001 게시 뒤 F-002가 새 버전으로 표시, 규정 변경 영향에 바뀐 조문·영향 노하우 1건 이상 |
| M05 | 5.1 데모 05 | '담보평가 시 확인 절차는?' 검색에 조문·시행일·검증 인장, 업무 가이드 생성 |
| M06 | 5.1 데모 06 | Q4 통과, Agent 실행 기록·Trace 링크, 평가 결과 화면 (없으면 PART: docs/02 허용 경로는 자체 평가 결과표) |
