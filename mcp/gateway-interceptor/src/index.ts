// AgentCore Gateway REQUEST interceptor (MCP target).
// Gateway는 Tool Lambda에 사용자 신원을 넘기지 않는다(M0 실험). 그래서 여기서 JWT를 재검증하고
// tools/call 인자에 `__actor`를 서버가 주입한다. 클라이언트·모델이 보낸 `__actor`는 덮어쓴다.
import { CognitoJwtVerifier } from 'aws-jwt-verify';

export const ACTOR_KEY = '__actor';
const ROLES = ['USER', 'AUTHOR', 'REG_APPROVER', 'SECURITY_REVIEWER', 'PLATFORM_OPERATOR'];

type Json = Record<string, unknown>;
interface InterceptorEvent {
  mcp: { gatewayRequest: { headers?: Record<string, string>; body: Json } };
}

export type Verify = (token: string) => Promise<Json>;

/** 외부 MCP(사용자 결정 11/18, 사용자 직접 확인: '공개 문서 읽기만'): 사람 없는 client_credentials 토큰.
 *  scope hanaeum-mcp/read 가 있어야 하고, 읽기 도구만, __actor groups [] → ACL ALL 공개 게시 문서만 (interfaces 11장) */
export const EXTERNAL_SCOPE = 'hanaeum-wiki-mcp/read'; // 이름 확정 11/18: hanaeum-wiki-mcp
export const EXTERNAL_TOOLS = new Set(['search_wiki', 'retrieve_evidence', 'search_legal_clause', 'get_clause', 'get_official_policy', 'verify_version', 'resolve_reference', 'compare_versions', 'trace_impact', 'get_dependencies', 'get_wiki_document']);
/** 사람 토큰은 username 이 있다. 없으면 기계(client_credentials) 토큰으로 본다 — 기본 권한(USER)을 주지 않는다 */
const isMachine = (c: Json) => typeof c.username !== 'string' && typeof c['cognito:username'] !== 'string';

export function makeHandler(verify: Verify) {
  return async (event: InterceptorEvent) => {
    const req = event.mcp.gatewayRequest;
    const body = req.body;
    if (body.method !== 'tools/call') return pass(body);

    const h = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const token = /^Bearer\s+(\S+)$/i.exec(h.authorization ?? '')?.[1];
    let claims: Json;
    try {
      if (!token) throw new Error('no token');
      claims = await verify(token);
    } catch {
      return deny(body, 'unauthenticated');
    }
    const params = (body.params ?? {}) as Json;
    if (isMachine(claims)) {
      const scopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/) : [];
      const tool = String(params.name ?? '').split('___').pop() ?? '';
      const client = String(claims.client_id ?? claims.sub ?? '');
      if (!scopes.includes(EXTERNAL_SCOPE)) return deny(body, 'forbidden: scope');
      if (!EXTERNAL_TOOLS.has(tool)) { console.log(JSON.stringify({ audit: 'MCP_EXTERNAL', client_id: client, tool, result: 'DENIED' })); return deny(body, 'forbidden: tool not allowed for external clients'); }
      const a0 = (params.arguments ?? {}) as Json;
      // 감사: 요청 쪽에서 아는 것만(클라이언트·도구·인자의 doc_id). 검색어 원문은 남기지 않는다
      const doc_ids = ['doc_id', 'doc_ids'].flatMap((k) => (Array.isArray(a0[k]) ? a0[k] as unknown[] : a0[k] ? [a0[k]] : [])).map(String).slice(0, 20);
      console.log(JSON.stringify({ audit: 'MCP_EXTERNAL', client_id: client, tool, result: 'ALLOWED', ...(doc_ids.length ? { doc_ids } : {}) }));
      return pass({ ...body, params: { ...params, arguments: { ...a0, [ACTOR_KEY]: { sub: `client:${client}`, groups: [] } } } });
    }
    const groups = (Array.isArray(claims['cognito:groups']) ? claims['cognito:groups'] : []).filter((g): g is string => ROLES.includes(g as string));
    const dept = typeof claims.dept === 'string' ? claims.dept : undefined; // Pre Token V2 트리거가 access token에 추가 (yoyo0704)
    const args = { ...((params.arguments ?? {}) as Json), [ACTOR_KEY]: { sub: claims.sub, groups: groups.length ? groups : ['USER'], ...(dept ? { dept } : {}) } };
    return pass({ ...body, params: { ...params, arguments: args } });
  };
}

const pass = (body: Json) => ({ interceptorOutputVersion: '1.0', mcp: { transformedGatewayRequest: { body } } });
const deny = (body: Json, message: string) => ({
  interceptorOutputVersion: '1.0',
  mcp: { transformedGatewayResponse: { statusCode: 200, body: { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32001, message } } } },
});

// Lambda 진입점. 환경변수가 없으면(테스트) verifier를 만들지 않는다.
const pool = process.env.COGNITO_USER_POOL_ID;
const verifier = pool
  ? CognitoJwtVerifier.create({ userPoolId: pool, tokenUse: 'access', clientId: process.env.COGNITO_CLIENT_ID!.split(',') })
  : undefined;
export const handler = verifier && makeHandler((t) => verifier.verify(t) as Promise<Json>);
