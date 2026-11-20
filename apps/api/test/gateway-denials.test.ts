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
