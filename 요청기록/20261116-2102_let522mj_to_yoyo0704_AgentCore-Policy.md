# let522mj → yoyo0704 : AgentCore Policy 구현 (사용자 결정)

| 항목 | 내용 |
|---|---|
| 상태 | OPEN |
| 결정 | 사용자 결정(11/16 21시경): **AgentCore Policy를 이번 범위에서 구현**. 단계 처리는 Lambda(Gateway Target) 유지 — Runtime 안으로 통합하지 않음 (Role 분리 유지, Target 14개 재사용) |
| 대상 기능 | 사용자 Gateway(검색·조문·approval·privacy·graph Tool), 파이프라인 Gateway `hanaeum-mvp-gw-pipeline` |
| 요청 내용 | 1. Gateway에 AgentCore Policy(정책 엔진) 연결, Tool별 deny-by-default + 명시 허용 (`docs/01` 11장 689·711행)<br>2. 최소 규칙: 사용자 Agent는 승인·게시 Tool 호출 불가 / 파이프라인 Gateway는 오케스트레이터 Role만 / `regulation___fetch_official_law`(Browser)는 사용자 Agent 허용, 파이프라인 불가<br>3. DENY 시 Trace·감사 기록 확인 (데모 "승인 없는 AI 게시 차단" 근거) |
| 기준 미달 근거 | main Terraform에 AgentCore Policy 리소스 0건. 현재 IAM 정책만으로 제한 → 설계(`docs/01` 75·111행)의 "AgentCore Policy 도구 호출 차단" 미충족 |
| 참고 | 세부 정책 언어·Gateway 연동은 `docs/01` 725행대로 배포 시점 사양 확인 필요 |
| 처리 결과 | |
