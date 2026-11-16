# 공유 dev 예고: 사용자 Gateway·가이드 Runtime, 오케스트레이터 이미지 32e5f81, Guardrail

| 항목 | 내용 |
|---|---|
| 상태 | 진행중 (약 25분) |
| 신규 | 사용자 Gateway `hanaeum-mvp-gw-user-dev`(Cognito JWT, interceptor, Target search·regulation·graph·privacy·approval, Policy ENFORCE), 가이드 Runtime `hanaeum_mvp_rt_guide_dev`, Lambda interceptor·mcp-privacy·mcp-approval (dhxorb96 `e812aac`) |
| 변경 | 파이프라인 오케스트레이터 이미지 `d0eeeae` → `32e5f81` (CodeBuild 빌드, ImageDescribe 노드 포함), API `AGENT_RUNTIME_ARN` |
| 반영됨 | Guardrail `hanaeum-mvp-guardrail-pii-dev` (SSM `GUARDRAIL_ID`·`GUARDRAIL_VERSION`) → measure-pii 재측정 가능 |
| 요청 | 끝날 때까지 파이프라인 실행 피하기 |
