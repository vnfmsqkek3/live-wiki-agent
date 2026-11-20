# evaluations

AgentCore Evaluations 정답 데이터셋 (합성 하나은행 가상 데이터). `agentcore-dataset.json` 은 `node tests/fixtures/scripts/make-agentcore-dataset.ts` 로 생성 (평가 케이스 `tests/evaluations/cases` + Registry 조문 원문). 형식: [AgentCore dataset schema](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/dataset-evaluations-schema.html)

| 필드 | 평가기 | 내용 |
|---|---|---|
| `turns[].expected_response` | Builtin.Correctness | 기준일 시행 버전 조문 표기·원문 |
| `assertions` | Builtin.GoalSuccessRate | 인용해야 할 조문, 현행으로 인용하면 안 되는 조문(삭제·과거), 근거 없음일 때 단정 금지, 비인가 게시 거부 안내(PD-01~05) |
| `metadata` | (평가기 미사용) | 케이스 종류·기준일·정답 provision_id·`expected_tools`(참고). `expected_trajectory` 는 넣지 않음: 1차 검색은 Agent 밖 코드 호출이라 Trace 도구 호출로 안 찍힐 수 있음 |
