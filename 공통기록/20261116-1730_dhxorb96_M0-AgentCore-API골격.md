# M0 · AgentCore 연결 실험 완료, API 골격

| 항목 | 내용 |
|---|---|
| 상태 | 완료 (API 저장소·검색은 mock) |
| AgentCore | Runtime(JWT authorizer) → Strands Agent → Bedrock 모델 → Gateway(CUSTOM_JWT) → interceptor → Lambda Tool 전 구간 성공 |
| 신원 전달 | **access token** 사용. Gateway는 Tool Lambda에 신원을 안 넘김 → interceptor가 `arguments.__actor={sub,groups}` 주입. `interfaces.md` 9장 확정 |
| Tool 작성자(let522mj) 영향 | Tool Lambda는 `event.__actor`만 신뢰. 스키마 외 인자도 그대로 들어오므로 다른 신원 인자는 무시. Tool 이름은 `{target}___{tool}` |
| 모델 | Claude 5.5 호출 불가 (yoyo0704 트러블슈팅과 동일) → Sonnet 4.6/Haiku 4.5로 실험 |
| API | `apps/api`: 업로드 URL, analyze, review, submit, 승인(바인딩), search(mock), feedback. 단계 0·2·6·7·9 규칙 엔진. 테스트 17건 |
| 버전 | `interfaces.md` 8장 dhxorb96 행 기입 (Strands 1.25.0, Hono 4.13.18, Next.js 16.4.6) |
| 개인 dev 리소스 | `hanaeum-mvp-*-dhxorb96` (Cognito exp pool, Lambda gwstub·gwicpt, Gateway gw-exp, ECR agent, Runtime rt_exp, IAM role 3개). 공유 dev 배포 후 삭제 |
| 경로 | `apps/api/`, `agents/`, `mcp/gateway-interceptor/` |
| 코드 | 브랜치 `dhxorb96`, PR #2 (main 병합 전) |
