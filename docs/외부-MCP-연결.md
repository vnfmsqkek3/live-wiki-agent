# 외부 MCP 연결 안내 — hanaeum-wiki-mcp (하나이음 위키)

MCP 서버 이름은 `hanaeum-wiki-mcp` 로 통일합니다(다른 위키 MCP 와 헷갈리지 않게, 사용자 결정 11/18). 클라이언트 설정의 서버 키·scope 모두 이 이름을 씁니다.

다른 챗봇·문서 생성 앱이 위키의 검색·근거·규정·정리본을 MCP 도구로 쓰는 방법입니다. 계약은 `docs/interfaces.md` 11장.

## 1. 접속 정보 (prod — 사용자 결정 11/20: prod 단일 환경)
| 항목 | 값을 얻는 곳 |
|---|---|
| MCP 엔드포인트 | SSM `/hanaeum-mvp/prod/USER_GATEWAY_URL` |
| 클라이언트 ID·시크릿·토큰 주소·scope | Secrets Manager `hanaeum-mvp/mcp-external-client` (관리자에게 요청) |

## 2. 토큰 받기
```bash
curl -s -X POST "$TOKEN_ENDPOINT" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=client_credentials&scope=hanaeum-wiki-mcp/read"
# → {"access_token": "...", "expires_in": 3600}
```

## 3. MCP 클라이언트 설정 예시 (Streamable HTTP)
```json
{
  "mcpServers": {
    "hanaeum-wiki-mcp": {
      "url": "<USER_GATEWAY_URL>",
      "headers": { "Authorization": "Bearer <access_token>" }
    }
  }
}
```

## 4. 쓸 수 있는 도구 (읽기 전용)
search_wiki, retrieve_evidence, search_legal_clause, get_clause, get_official_policy, verify_version, resolve_reference, compare_versions, trace_impact, get_dependencies, get_wiki_document

## 5. 지켜야 할 것
- 공개(acl ALL) 게시 문서만 보입니다. 결재·수정 도구는 쓸 수 없습니다.
- 받은 글은 개인정보가 가려진 정리본입니다. 근거 인용은 `quotable=true` 인 조각만 쓰세요.
- 호출은 감사 기록에 남습니다.

> 변경 11/20 backend: dev → prod 접속 정보. 보안 테스트 `tests/security/mcp-external.test.ts`.
