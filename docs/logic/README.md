# docs/logic

시스템 동작 로직 그림. 2026-11-19 코드 기준으로 그렸다. `.mmd` 는 편집용 Mermaid 원본, `.png` 는 보기용이다.

| No | 그림 | 내용 | 주요 코드 |
|---|---|---|---|
| 01 | 전체 요청 경로 | 사용자·문서·질의가 지나는 AWS 구성 | `hanaeum-terraform/` |
| 02 | 문서 접수·자동 분석 | 업로드 → 14단계 검사 → 검토 대기 또는 차단 | `agents/src/pipeline/orchestrator.ts` |
| 03 | 파이프라인 엔진 규칙 | AgentCore 오케스트레이터: 락, 단계 호출, PENDING 재호출, 429 재시도 | `agents/src/pipeline/` |
| 04 | 사람 검토·승인 | 질문 페이지 → 수정·그대로 사용 → 게시 요청 → 결재, 승인 바인딩 | `apps/api/src/app.ts`, `submit.ts` |
| 05 | 게시·삭제 | promote → KB → 그래프 → finalize, 삭제 정리 | `orchestrator.ts`, `services/legal-etl`, `mcp/graph-server` |
| 06 | 최신 상태 유지 | 규정 개정·삭제, 매일 점검, 재검증, 검색 시 재확인 | `apps/api/src/steps/freshness.ts`, `lambdas.ts` |
| 07 | 가이드 Agent | 질문 → Runtime → Gateway 도구 → Sonnet 초안 → 출처 검증 | `agents/src/guide.ts` |
| 08 | 검색 | 마스킹 → 질의 다듬기 → KB HYBRID·Rerank → DB 재검증 | `mcp/search-server/src/search.ts` |
| 09 | 문서 상태 | lifecycle·freshness 전이 | `apps/api/src/contracts.ts` |
| 10 | 외부 MCP·인증 | Gateway Interceptor 토큰·도구 허용 규칙 | `mcp/gateway-interceptor/` |

다시 그리기: `npx -y @mermaid-js/mermaid-cli@11.4.2 -i {파일}.mmd -o {파일}.png -b white -s 2`
