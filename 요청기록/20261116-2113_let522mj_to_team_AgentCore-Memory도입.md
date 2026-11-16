# let522mj → dhxorb96, yoyo0704 : AgentCore Memory 도입 (사용자 결정)

| 항목 | 내용 |
|---|---|
| 상태 | OPEN |
| 결정 | 사용자 결정(11/16 21시경): **AgentCore Memory 도입**. `docs/01` 679행 "Memory 제외" 문구 개정 필요 |
| 기준 미달 근거 | 사용자 요구: AgentCore 최신 기능(Memory·Gateway·오케스트레이션·Observability) 사용. 현재 계정 `list-memories` 0건, 코드·Terraform 0건 |
| 처리 결과 | (dhxorb96, 21:17) **dhxorb96 몫 완료** (브랜치 `9c0578d`, PR #2): ① 가이드 Agent Memory 연결(`agents/src/memory.ts`, 직접 CreateEvent·ListEvents·RetrieveMemoryRecords). actorId=Runtime이 검증한 JWT `sub`, sessionId=Runtime 세션 헤더 = `guide-{conversation_id}` ② 저장 전 PII 재마스킹(질의·응답 모두), 근거 원문·Tool 인자 미저장 ③ 근거 재검증: 기억은 `<history>`·`<summary>` 맥락으로만 전달하고 **인용은 이번 search 결과만 허용** → 기억 속 폐지 조문을 출처로 내도 제거됨(테스트) ④ 삭제 `DELETE /v1/me/memory`(본인 sub만, 감사 기록) — 단기 이벤트 삭제. summary 레코드 삭제는 전략 네임스페이스 확정 후 추가 ⑤ `docs/01` 679행·11장, `docs/04` 7장 개정(PR #2). 설계 기준 v0 이견 없음<br>**yoyo0704에게 필요한 것**: 사용자 Agent Runtime env `MEMORY_ID`, Runtime Role에 `CreateEvent·ListEvents·RetrieveMemoryRecords`, **API(ECS) Role**에 `ListSessions·ListEvents·DeleteEvent`(삭제 API). summary 전략 네임스페이스를 `/users/{actorId}/`로 맞춰 달라 |

## 설계 기준 (v0 제안 — 이견은 이 파일에 바로)

| 항목 | 기준 | 이유 |
|---|---|---|
| 범위 | **사용자 Agent(가이드·검색 대화)만**. 파이프라인 오케스트레이터는 쓰지 않음(상태는 DynamoDB) | 파이프라인은 반복 가능해야 하고 세션 기억이 결과를 바꾸면 안 됨 |
| 단기 메모리 | 세션 대화 이벤트. `actorId` = Cognito `sub`, `sessionId` = 화면 대화 ID | 후속 질문("그럼 2항은?") 맥락 |
| 장기 메모리 | 요약(summary) 전략 1개만, 네임스페이스 `/users/{actorId}/` (사용자 간 공유 금지). 사실·선호 추출 전략은 MVP 제외 | 최소 범위, 교차 사용자 노출 차단 |
| 개인정보 | **마스킹된 텍스트만 저장** (사용자 질의는 PII 검사 후, 모델 응답도 저장 전 PII 검사). 원문·JWT·presigned URL·Tool 인자 원본 저장 금지 | CLAUDE.md 개인정보 규칙 |
| 근거 재검증 | Memory에서 꺼낸 조문·문서는 **근거로 바로 쓰지 않고** search·regulation Tool로 현재 상태 재검증 후 인용 (폐지·개정·권한 회수 반영) | 검색·색인 원칙: Tool이 DynamoDB 현재 상태로 재검증 |
| 보존 | 이벤트 만료 30일(데모), KMS 고객 관리 키 | 금융 데이터 최소 보존 |
| 삭제 | 사용자별 삭제(actorId 단위) 경로 | 개인정보 삭제 요구 대응 |
| 관측 | Memory 호출을 Observability Trace에 포함 (내용 대신 이벤트 수·지연만) | 원문 로그 금지 |

## 담당

| 담당 | 작업 |
|---|---|
| **yoyo0704** | Memory 리소스(단기 + summary 전략, 만료 30일, KMS), 사용자 Agent Runtime Role에 `bedrock-agentcore:CreateEvent`·`ListEvents`·`RetrieveMemoryRecords`·`DeleteMemoryRecord` 등 최소 권한, SSM `MEMORY_ID`, `interfaces.md` 4장 환경변수 |
| **dhxorb96** | 가이드 Agent에 Memory 연결(Strands 세션 매니저 또는 직접 CreateEvent/ListEvents), 저장 전 PII 검사, 꺼낸 근거 재검증, 삭제 API, `docs/01` 11장·679행 개정 PR |
| **let522mj** | 평가: Golden 대화 후속 질문 케이스 추가(맥락 유지 + 폐지 조문을 Memory에서 꺼내도 재검증으로 DELETED 표시되는지), Memory 저장분 PII 0건 측정 |
