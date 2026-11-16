# MCP privacy·approval 서버 (11/19 일부 선행)

| 항목 | 내용 |
|---|---|
| 상태 | 완료. 공유 Gateway 등록은 yoyo0704 (11/19 Gateway 모듈) |
| privacy | `detect_sensitive_data`(유형·위치·개수만, 원문 미반환), `masking_preview`. 허용 AUTHOR·SECURITY_REVIEWER |
| approval | `create_review_request`(작성자 본인 문서만, 게시 요청만 만들고 승인 안 함), `get_status`(미게시 문서는 작성자·검토자만), `draft_change`(게시 문서만, 근거 필수, PII 가림, DRAFT로 저장, 자동 게시 없음) |
| 데모 06 근거 | 승인·게시 Tool 미제공. Gateway 목록에 없어 `Unknown tool`로 거부, Lambda를 직접 부르면 FORBIDDEN + 감사 DENIED |
| 검증 | 단위 테스트 7건, 개인 dev Gateway 경유 `tools/list`·`tools/call` 확인 |
| 등록 자료 | `mcp/{privacy,approval}-server/tools.json`(Tool 스키마), `npm run build` → `dist/index.mjs`, handler `index.handler`. approval은 Documents·Approvals·Audit 테이블 env 필요 |
| 초안 저장 키 | Documents 테이블 `pk=DOC#{doc_id}`, `sk=DRAFT#{draft_id}` |
| 코드 | 브랜치 `dhxorb96`, PR #2 |
