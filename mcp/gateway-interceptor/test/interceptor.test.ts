import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler, ACTOR_KEY } from '../src/index.ts';

// 테스트에서 출력 구조를 자유롭게 탐색하기 위한 느슨한 타입
type Out = { mcp: { transformedGatewayRequest?: { body: { params: { arguments: unknown } } }; transformedGatewayResponse?: { body: { error: { message: string } } } } };

const h = makeHandler(async (t) => {
  if (t === 'ext') return { sub: 'cli-9', client_id: 'cli-9', token_use: 'access', scope: 'hanaeum-wiki-mcp/read' }; // client_credentials (사람 없음)
  if (t === 'ext-noscope') return { sub: 'cli-9', client_id: 'cli-9', token_use: 'access', scope: 'other/read' };
  if (t !== 'good') throw new Error('bad');
  return { sub: 'u-1', username: 'u1', 'cognito:groups': ['AUTHOR', 'ADMIN_FAKE'], dept: '여신' };
});
const ev = (body: Record<string, unknown>, auth?: string) => ({ mcp: { gatewayRequest: { headers: (auth ? { Authorization: `Bearer ${auth}` } : {}) as Record<string, string>, body } } });

test('tools/call: 서버가 __actor 주입, 클라이언트가 보낸 신원은 덮어씀, 미정의 그룹 제거', async () => {
  const r = (await h(ev({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: { q: 'x', [ACTOR_KEY]: { sub: 'spoof', groups: ['REG_APPROVER'] } } } }, 'good'))) as Out;
  assert.deepEqual(r.mcp.transformedGatewayRequest!.body.params.arguments, { q: 'x', [ACTOR_KEY]: { sub: 'u-1', groups: ['AUTHOR'], dept: '여신' } });
});

test('tools/call: 토큰 없음·검증 실패는 Tool 호출 전에 오류 응답', async () => {
  for (const auth of [undefined, 'bad']) {
    const r = (await h(ev({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 't', arguments: {} } }, auth))) as Out;
    assert.equal(r.mcp.transformedGatewayResponse!.body.error.message, 'unauthenticated');
    assert.equal(r.mcp.transformedGatewayRequest, undefined);
  }
});

test('tools/list 등은 그대로 통과', async () => {
  const body = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  assert.deepEqual(((await h(ev(body))) as Out).mcp.transformedGatewayRequest!.body, body);
});

test('외부 MCP(11/18): client_credentials 토큰은 공개 문서만(groups []), 읽기 도구만, scope 필수, 기본 USER 권한을 주지 않음', async () => {
  const call = (auth: string, name: string) => h(ev({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: { query: 'x', [ACTOR_KEY]: { sub: 'spoof', groups: ['USER'] } } } }, auth)) as Promise<Out>;
  const ok = await call('ext', 'search___search_wiki');
  assert.deepEqual(ok.mcp.transformedGatewayRequest!.body.params.arguments, { query: 'x', [ACTOR_KEY]: { sub: 'client:cli-9', groups: [] } });
  for (const tool of ['search___create_review_request', 'search___draft_change', 'search___detect_sensitive_data', 'search___masking_preview', 'search___get_status'])
    assert.match((await call('ext', tool)).mcp.transformedGatewayResponse!.body.error.message, /not allowed/);
  assert.match((await call('ext-noscope', 'search___search_wiki')).mcp.transformedGatewayResponse!.body.error.message, /scope/);
});
