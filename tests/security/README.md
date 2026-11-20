보안 테스트 문서. prod 실환경 블랙박스 (사용자 결정 11/20: prod 단일 환경).

| 파일 | 대상 | 실행 |
|---|---|---|
| `api-security.test.ts` | Backend API: 인증·비인가 게시 5건·승인 재사용·검사 후 변경·ACL·IDOR·질의 PII | 상단 주석 (로컬 API + prod 리소스) |
| `mcp-external.test.ts` | 외부 MCP `hanaeum-wiki-mcp`: 인증·읽기 도구만·쓰기/민감 도구 6종 거부·공개 게시 문서만(위조 `__actor` 무시)·응답 PII | 상단 주석 (prod 사용자 Gateway) |
