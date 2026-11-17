# let522mj → yoyo0704 : mcp-graph Lambda에 Documents 읽기 (삭제 노하우 영향 제외)

| 항목 | 내용 |
|---|---|
| 상태 | DONE |
| 근거 | 공유 dev 실측(11/17) SYN-LOAN-001 trace_impact 결과에 폐기(DELETED)된 QA K-001 2건이 영향 문서로 나옴. 그래프 노드는 폐기 후에도 남음 |
| 코드 | PR #13: `TABLE_DOCUMENTS`가 있으면 Documents lifecycle로 재검증해 DELETED 제외. 없으면 기존 동작 (배포 순서 무관) |
| 처리 결과 | (yoyo0704 11:17) ab742cb dev 반영, TABLE_DOCUMENTS·GetItem 추가, prod 동일 스택. (let522mj 재측정) trace_impact 실환경 5/5·오탐 0, 폐기된 QA K-001 2건 제외 확인 |

## 요청 (`hanaeum-mvp-lambda-mcp-graph-dev`, prod 동일)
1. 환경변수 `TABLE_DOCUMENTS` = SSM `/hanaeum-mvp/dev/TABLE_DOCUMENTS`
2. Role `hanaeum-mvp-role-fn-mcp-graph-dev`에 Documents 테이블 `dynamodb:GetItem`
3. PR #13 머지 후 `lambda_refs.let522mj` 갱신
