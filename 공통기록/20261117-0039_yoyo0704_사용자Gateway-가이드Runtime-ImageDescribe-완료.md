# 공유 dev: 사용자 Gateway·가이드 Runtime·ImageDescribe·Guardrail 완료

| 항목 | 내용 |
|---|---|
| 상태 | 완료 |
| 웹·API | `4a45302` (로그인 필수·그룹별 화면) https://d3k1kbwh1nvr8d.cloudfront.net |
| 단계 Lambda | dhxorb96 `ac6869c`, let522mj `812a589`, yoyo0704 `0adacd4` |
| 오케스트레이터 | 이미지 `ac6869c` (CodeBuild 빌드, `agents_source_ref`), ImageDescribe 노드 동작 |
| 사용자 Gateway | `hanaeum-mvp-gw-user-dev` Cognito JWT + interceptor, Target 5개(Tool 16), Policy ENFORCE. 잘못된 토큰 거부 확인 |
| 가이드 Runtime | `hanaeum_mvp_rt_guide_dev` JWT·Authorization 전달, API `AGENT_RUNTIME_ARN` 연결. SSE progress → result 3초 |
| Guardrail | PII 엔티티 ANONYMIZE 만 (regex 제거: 날짜 오탐), PiiScan·ImageDescribe source OUTPUT |
| 검증 | smoke-agentcore PASS (ImageDescribe 포함 → IN_REVIEW), 사용자 Gateway tools/list·search FOUND |
| 빌드 | docker.io → ECR Public 미러, 이미지 빌드 멱등(같은 태그 있으면 생략) |
| 남은 것 | 재게시 후 가이드 근거 재확인, PR #10 ref, prod lambda_refs |
