import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler, ACTOR_KEY } from '../src/index.ts';

const h = makeHandler(async (t) => {
  if (t !== 'good') throw new Error('bad');
  return { sub: 'u-1', 'cognito:groups': ['AUTHOR', 'ADMIN_FAKE'] };
});
const ev = (body: Record<string, unknown>, auth?: string) => ({ mcp: { gatewayRequest: { headers: (auth ? { Authorization: `Bearer ${auth}` } : {}) as Record<string, string>, body } } });

test('tools/call: 서버가 __actor 주입, 클라이언트가 보낸 신원은 덮어씀, 미정의 그룹 제거', async () => {
  const r = (await h(ev({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: { q: 'x', [ACTOR_KEY]: { sub: 'spoof', groups: ['REG_APPROVER'] } } } }, 'good'))) as any;
  assert.deepEqual(r.mcp.transformedGatewayRequest.body.params.arguments, { q: 'x', [ACTOR_KEY]: { sub: 'u-1', groups: ['AUTHOR'] } });
});

test('tools/call: 토큰 없음·검증 실패는 Tool 호출 전에 오류 응답', async () => {
  for (const auth of [undefined, 'bad']) {
    const r = (await h(ev({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 't', arguments: {} } }, auth))) as any;
    assert.equal(r.mcp.transformedGatewayResponse.body.error.message, 'unauthenticated');
    assert.equal(r.mcp.transformedGatewayRequest, undefined);
  }
});

test('tools/list 등은 그대로 통과', async () => {
  const body = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  assert.deepEqual(((await h(ev(body))) as any).mcp.transformedGatewayRequest.body, body);
});
