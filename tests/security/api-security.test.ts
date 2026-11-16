// 보안 테스트 (Owner dhxorb96, docs/02 4장 · TODO 11/21). 실행 중인 API에 데모 계정으로 직접 요청하는 블랙박스 테스트.
// 실행: set -a; . ./.env.local; set +a; eval "$(apps/api/scripts/ssm-env.sh dev)"; API=http://localhost:8080 node --test tests/security/*.test.ts
// 의존성 없음: AWS 호출은 aws CLI로 한다. 문서는 공유 dev 실제 파이프라인으로 IN_REVIEW까지 만든다.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API = process.env.API ?? 'http://localhost:8080';
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k} (ssm-env.sh 먼저)`); return v; };
const aws = (...args: string[]) => execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8' });

type Who = 'demo-user' | 'demo-author' | 'demo-approver' | 'demo-security' | 'demo-operator';
const tokens = {} as Record<Who, string>;
const subOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()).sub as string;

async function call(who: Who | null, method: string, path: string, body?: unknown, token?: string) {
  const init = {
    method,
    headers: { 'content-type': 'application/json', ...(who || token ? { authorization: `Bearer ${token ?? tokens[who!]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  // 테스트가 aws CLI로 수십 초 동기 대기하는 동안 서버가 keep-alive 소켓(5초)을 닫는다 → 재사용 소켓 ECONNRESET 1회 재시도
  const r = await fetch(API + path, init).catch((e: { cause?: { code?: string } }) => {
    if (e.cause?.code !== 'ECONNRESET') throw e;
    return fetch(API + path, init);
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** 업로드 → (S3 이벤트 → type-detection → SFN: Malware·FileStructure·TextLayer·Segment·…·TrustGate·WaitForApproval) → IN_REVIEW.
 *  공유 dev 실제 파이프라인을 그대로 탄다 (yoyo0704 단계 Lambda 연결 11/16 20:10). presigned URL도 돌려줘 "검사 후 변경"에 쓴다 */
// 텍스트 레이어가 있는 합성 PDF (let522mj fixture). 가짜 PDF는 TextLayerExtract가 InvalidPDFException으로 정상 차단한다
const SAMPLE_PDF = new URL('../fixtures/documents/pdf/K-001.pdf', import.meta.url);

async function reviewedDoc() {
  const body = new Uint8Array(readFileSync(SAMPLE_PDF));
  const r = await call('demo-author', 'POST', '/v1/documents/upload-url', { filename: 'sec.pdf', size: body.length, title: '[SYNTHETIC] 보안 테스트', dept: '여신', acl_groups: ['ALL'] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const { doc_id, url } = r.json as { doc_id: string; url: string };
  const put = await fetch(url, { method: 'PUT', body });
  assert.equal(put.status, 200);
  for (let i = 0; i < 80; i++) { // GuardDuty 스캔 포함 최대 약 4분
    const d = await call('demo-author', 'GET', `/v1/documents/${doc_id}`);
    if (d.json.lifecycle === 'IN_REVIEW' && d.json.trust_gate_result) return { doc_id, url, body };
    if (d.json.lifecycle === 'BLOCKED') throw new Error(`pipeline BLOCKED ${doc_id}`);
    if (d.json.workflow_failure) throw new Error(`pipeline FAILED ${doc_id} ${JSON.stringify(d.json.workflow_failure)}`);
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`IN_REVIEW 도달 실패 ${doc_id}`);
}

async function submitted() {
  const d = await reviewedDoc();
  const s = await call('demo-author', 'POST', `/v1/documents/${d.doc_id}/submit`);
  assert.equal(s.status, 201);
  return { ...d, approval_id: s.json.approval_id as string };
}

function deniedCount(sub: string, since: string) {
  const day = since.slice(0, 10);
  const r = JSON.parse(aws('dynamodb', 'query', '--table-name', env('TABLE_AUDIT_EVENTS'), '--key-condition-expression', 'pk = :p AND sk >= :s',
    '--filter-expression', 'actor = :a AND #r = :d', '--expression-attribute-names', '{"#r":"result"}',
    '--expression-attribute-values', JSON.stringify({ ':p': { S: `AUDIT#${day}` }, ':s': { S: since }, ':a': { S: sub }, ':d': { S: 'DENIED' } }), '--select', 'COUNT'));
  return r.Count as number;
}

before(() => {
  const secret = JSON.parse(JSON.parse(aws('secretsmanager', 'get-secret-value', '--secret-id', 'hanaeum-mvp/demo-users-dev', '--query', 'SecretString')));
  for (const who of ['demo-user', 'demo-author', 'demo-approver', 'demo-security', 'demo-operator'] as Who[]) {
    const v = secret[who];
    const pw = typeof v === 'string' ? v : v.password;
    tokens[who] = JSON.parse(aws('cognito-idp', 'initiate-auth', '--client-id', env('COGNITO_CLIENT_ID'), '--auth-flow', 'USER_PASSWORD_AUTH',
      '--auth-parameters', `USERNAME=${who},PASSWORD=${pw}`, '--query', 'AuthenticationResult.AccessToken'));
  }
});

test('인증: 토큰 없음·위조 서명·다른 풀 토큰은 401', async () => {
  assert.equal((await call(null, 'GET', '/v1/approvals')).status, 401);
  const [h, p] = tokens['demo-approver'].split('.');
  assert.equal((await call(null, 'GET', '/v1/approvals', undefined, `${h}.${p}.AAAA`)).status, 401);
  const forged = Buffer.from(JSON.stringify({ sub: 'x', 'cognito:groups': ['REG_APPROVER'] })).toString('base64url');
  assert.equal((await call(null, 'GET', '/v1/approvals', undefined, `${h}.${forged}.AAAA`)).status, 401);
});

test('비인가 게시 5건: 승인자가 아닌 역할의 결정 요청은 모두 403 + 감사 DENIED (데모 06 Backend 경로)', async () => {
  const { approval_id } = await submitted();
  const since = new Date().toISOString();
  const attempts: Who[] = ['demo-user', 'demo-author', 'demo-security', 'demo-operator', 'demo-user'];
  for (const who of attempts) assert.equal((await call(who, 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'APPROVE', reason: 'x' })).status, 403, who);
  await new Promise((r) => setTimeout(r, 1000));
  const total = (['demo-user', 'demo-author', 'demo-security', 'demo-operator'] as Who[]).reduce((n, w) => n + deniedCount(subOf(tokens[w]), since), 0);
  assert.equal(total, 5);
  const list = await call('demo-approver', 'GET', '/v1/approvals?status=PENDING');
  assert.ok((list.json.items as { approval_id: string }[]).some((a) => a.approval_id === approval_id), '거부 후에도 PENDING 유지');
});

test('승인 재사용·중복 결정: 두 번째 결정은 409', async () => {
  const { approval_id } = await submitted();
  const ok = await call('demo-approver', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'APPROVE', reason: '근거 확인' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.workflow_resumed, true, '실제 SFN 재개');
  assert.equal((await call('demo-approver', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'APPROVE', reason: 'again' })).status, 409);
  assert.equal((await call('demo-approver', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'REJECT', reason: 'flip' })).status, 409);
});

test('검사 후 변경: 남은 presigned URL로 파일을 바꾸면 승인 거부(409), 반려는 가능', async () => {
  const d = await submitted();
  // presigned URL은 Content-Length에 서명되므로 공격자는 같은 바이트 길이로 내용만 바꾼다
  const tampered = d.body.slice();
  tampered[tampered.length - 2] ^= 0x01; // 끝부분 1바이트만 변경 (길이 동일)
  const put = await fetch(d.url, { method: 'PUT', body: tampered });
  assert.equal(put.status, 200, '같은 URL 재업로드 (URL 유효시간 300초 내)');
  assert.equal((await call('demo-approver', 'POST', `/v1/approvals/${d.approval_id}/decision`, { decision: 'APPROVE', reason: 'x' })).status, 409);
  assert.equal((await call('demo-approver', 'POST', `/v1/approvals/${d.approval_id}/decision`, { decision: 'REJECT', reason: '검사 후 변경' })).status, 200);
});

test('ACL: 미게시 문서는 작성자·검토자 외 모든 조회 경로에서 숨김', async () => {
  const { doc_id } = await reviewedDoc();
  assert.equal((await call('demo-user', 'GET', `/v1/documents/${doc_id}`)).status, 404);
  assert.equal((await call('demo-user', 'GET', `/v1/documents/${doc_id}/review`)).status, 403);
  assert.equal((await call('demo-user', 'POST', '/v1/feedback', { doc_id, useful: true })).status, 404);
  assert.equal((await call('demo-user', 'GET', '/v1/approvals?status=PENDING')).status, 403);
  assert.equal((await call('demo-operator', 'GET', `/v1/documents/${doc_id}`)).status, 404, '운영 관리자도 원문 열람 불가');
  assert.equal((await call('demo-author', 'GET', `/v1/documents/${doc_id}`)).status, 200);
  const g = await call('demo-author', 'GET', `/v1/documents/${doc_id}`);
  assert.equal(g.json.task_token, undefined, 'task token 비노출');
});

test('IDOR: 바디의 사용자 식별값은 무시 (작성자 본인 확인은 토큰 기준)', async () => {
  const { doc_id } = await reviewedDoc();
  const r = await call('demo-approver', 'POST', `/v1/documents/${doc_id}/submit`, { owner: subOf(tokens['demo-author']), author_sub: subOf(tokens['demo-author']) });
  assert.equal(r.status, 403);
});

test('질의 PII: 가이드 질문의 개인정보는 가려서 처리하고 감사 기록에 남기지 않음', async () => {
  const since = new Date().toISOString();
  const r = await call('demo-user', 'POST', '/v1/guides', { question: '고객 900101-1234568 연락처 010-2222-3333 담보 승인 기준' });
  assert.equal(r.status, 200);
  assert.equal(r.json.query_masked, true);
  assert.ok(!JSON.stringify(r.json).includes('2222-3333'));
  const day = since.slice(0, 10);
  const items = aws('dynamodb', 'query', '--table-name', env('TABLE_AUDIT_EVENTS'), '--key-condition-expression', 'pk = :p AND sk >= :s',
    '--expression-attribute-values', JSON.stringify({ ':p': { S: `AUDIT#${day}` }, ':s': { S: since } }));
  assert.ok(!items.includes('2222-3333') && !items.includes('900101'), '감사 기록에 원문 PII');
});
