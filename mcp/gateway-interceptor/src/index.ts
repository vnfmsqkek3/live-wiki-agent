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
    const groups = (Array.isArray(claims['cognito:groups']) ? claims['cognito:groups'] : []).filter((g): g is string => ROLES.includes(g as string));
    const params = (body.params ?? {}) as Json;
    const args = { ...((params.arguments ?? {}) as Json), [ACTOR_KEY]: { sub: claims.sub, groups: groups.length ? groups : ['USER'] } };
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
