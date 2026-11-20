import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDenial, parseRequest } from '../src/gateway-denials.ts';

// 인프라 공유 형식(11/20 사용자 Gateway vended logs). 값은 합성
const deny = JSON.stringify({ event_timestamp: 1795159995496, trace_id: '6afff7bb3dc8d92453dd90a672b3624c', body: { log: 'Policy evaluation denied request', policy: { decision: 'DENY', reason: 'Policy evaluation denied due to hanaeum_mvp_deny_publish_probe-lgof7yte8a' } } });
const req = JSON.stringify({ trace_id: '6afff7bb3dc8d92453dd90a672b3624c', body: { log: 'Started processing request', requestBody: '{id=1, jsonrpc=2.0, method=tools/call, params={name=probe___publish_wiki_probe, arguments={doc_id=doc_X, query=고객 900101-1234568, __actor={sub=11111111-2222-3333-4444-555555555555, groups=[USER, AUTHOR], dept=여신}}}}' } });

test('Gateway Policy 거부 로그 → denials 항목: 도구·역할·사유·trace_id 만, 인자·sub 는 버림', () => {
  const d = parseDenial(deny)!;
  assert.deepEqual(d, { at: new Date(1795159995496).toISOString(), reason: 'Policy evaluation denied due to hanaeum_mvp_deny_publish_probe', trace_id: '6afff7bb3dc8d92453dd90a672b3624c' });
  const r = parseRequest(req);
  assert.deepEqual(r, { tool: 'probe___publish_wiki_probe', role: 'USER,AUTHOR' });
  assert.ok(!JSON.stringify({ ...d, ...r }).match(/1234568|11111111|doc_X/), '인자·sub 미노출');
  assert.equal(parseDenial(JSON.stringify({ trace_id: 'x', body: { policy: { decision: 'ALLOW' } } })), undefined);
  assert.equal(parseDenial('not json'), undefined);
});

test('리더: 빈 페이지+nextToken 을 따라가 최신 거부까지, 요청 조회는 거부 시각 ±5초 (인프라 리뷰 #131)', async () => {
  const { gatewayDenialsReader } = await import('../src/gateway-denials.ts');
  const ev = (ts: number, id: string) => JSON.stringify({ event_timestamp: ts, trace_id: id, body: { policy: { decision: 'DENY', reason: 'r' } } });
  const calls: { filterPattern?: string; startTime?: number; endTime?: number }[] = [];
  const pages = [{ events: [{ message: ev(1000, 'aa') }], nextToken: 'p2' }, { events: [], nextToken: 'p3' }, { events: [{ message: ev(9000, 'bb') }] }];
  const client = { send: async (c: { input: { filterPattern?: string; startTime?: number; endTime?: number; nextToken?: string } }) => {
    calls.push(c.input);
    if (c.input.filterPattern?.startsWith('"Policy')) return pages[c.input.nextToken === 'p2' ? 1 : c.input.nextToken === 'p3' ? 2 : 0];
    return { events: [{ message: req }] };
  } };
  const r = await gatewayDenialsReader('g', client as never)(new Date(0).toISOString());
  assert.deepEqual(r.map((x) => x.trace_id), ['bb', 'aa'], '최신 먼저, 빈 페이지 뒤 것도 포함');
  const look = calls.find((c) => c.filterPattern?.includes('"bb"'))!;
  assert.deepEqual([look.startTime, look.endTime], [4000, 14000]);
});
