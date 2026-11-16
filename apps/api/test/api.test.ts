import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type Deps } from '../src/app.ts';
import { memoryStore } from '../src/store.ts';
import { ApiError } from '../src/errors.ts';
import type { Actor } from '../src/contracts.ts';

const USERS: Record<string, Actor> = {
  author: { sub: 'u-author', groups: ['AUTHOR'], dept: 'loan' },
  author2: { sub: 'u-author2', groups: ['AUTHOR'], dept: 'loan' },
  approver: { sub: 'u-approver', groups: ['REG_APPROVER'], dept: 'compliance' },
  authorApprover: { sub: 'u-author', groups: ['AUTHOR', 'REG_APPROVER'] }, // 같은 sub로 자기 승인 시도
  user: { sub: 'u-user', groups: ['USER'], dept: 'loan' },
};

function setup() {
  const store = memoryStore();
  const objects = new Map<string, { s3_version_id: string; content_hash: string }>();
  const tasks: { token: string; decision: string }[] = [];
  const deps: Deps = {
    verify: async (t) => { const u = USERS[t]; if (!u) throw new ApiError('UNAUTHORIZED', 'invalid token'); return u; },
    store,
    presignPut: async (key) => `https://hanaeum-mvp-s3-quarantine.s3.us-east-1.amazonaws.com/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256`,
    headObject: async (key) => objects.get(key),
    startWorkflow: async () => {},
    sendDecision: async (token, decision) => { tasks.push({ token, decision }); },
    search: async () => [],
    guide: async (q, tok) => ({ q, tok }),
    webOrigins: ['http://localhost:3000'],
  };
  const app = createApp(deps);
  const call = (who: string | undefined, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, store, objects, tasks, call, deps };
}

const upload = { filename: 'F-001.pdf', size: 1000, title: '기업여신 심사규정 v1 (SYNTHETIC)', dept: 'loan', acl_groups: ['ALL'] };

/** 업로드 → 분석 → (Trust Gate 결과를 워크플로가 기록했다고 가정) → 게시 요청 */
async function submitted(t: ReturnType<typeof setup>) {
  const r = await t.call('author', 'POST', '/v1/documents/upload-url', upload);
  const { doc_id } = (await r.json()) as { doc_id: string };
  t.objects.set(`${doc_id}/original.pdf`, { s3_version_id: 'v1', content_hash: 'h1' });
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/analyze`)).status, 202);
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', trust_gate_result: 'PASS', task_token: 'tok-1', content_hash: 'sha256:h1' });
  const s = await t.call('author', 'POST', `/v1/documents/${doc_id}/submit`);
  assert.equal(s.status, 201);
  const { approval_id } = (await s.json()) as { approval_id: string };
  return { doc_id, approval_id };
}

test('토큰 없으면 401, 공통 오류 형식', async () => {
  const t = setup();
  const r = await t.call(undefined, 'GET', '/v1/approvals');
  assert.equal(r.status, 401);
  const j = (await r.json()) as { error: { code: string; trace_id: string } };
  assert.equal(j.error.code, 'UNAUTHORIZED');
  assert.ok(j.error.trace_id);
});

test('업로드 URL: AUTHOR만, 허용 확장자만, SigV4 리전 엔드포인트', async () => {
  const t = setup();
  assert.equal((await t.call('user', 'POST', '/v1/documents/upload-url', upload)).status, 403);
  assert.equal((await t.call('author', 'POST', '/v1/documents/upload-url', { ...upload, filename: 'a.pptx' })).status, 422);
  assert.equal((await t.call('author', 'POST', '/v1/documents/upload-url', { ...upload, size: 999_999_999 })).status, 422);
  const r = await t.call('author', 'POST', '/v1/documents/upload-url', upload);
  assert.equal(r.status, 201);
  const j = (await r.json()) as { doc_id: string; url: string };
  assert.match(j.doc_id, /^doc_[0-9A-Z]{26}$/);
  assert.match(j.url, /s3\.us-east-1\.amazonaws\.com.*AWS4-HMAC-SHA256/);
});

test('정상 승인: 다른 사람이 승인하면 APPROVED, task token 성공 전송', async () => {
  const t = setup();
  const { approval_id } = await submitted(t);
  const r = await t.call('approver', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'APPROVE', reason: '근거 확인' });
  assert.equal(r.status, 200);
  assert.deepEqual(t.tasks, [{ token: 'tok-1', decision: 'APPROVE' }]);
});

test('보안: 일반 사용자 승인 시도 403 + 감사 기록 (데모 06 Backend 경로)', async () => {
  const t = setup();
  const { approval_id } = await submitted(t);
  for (let i = 0; i < 5; i++) {
    const r = await t.call('user', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'APPROVE', reason: 'x' });
    assert.equal(r.status, 403);
  }
  assert.equal(t.store.audits.filter((a) => a.result === 'DENIED').length, 5);
  assert.equal(t.tasks.length, 0);
});

test('보안: 자기 승인 거부', async () => {
  const t = setup();
  const { approval_id } = await submitted(t);
  const r = await t.call('authorApprover', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'APPROVE', reason: 'x' });
  assert.equal(r.status, 403);
});

test('보안: 검사 후 파일 변경 시 승인 거부 (409)', async () => {
  const t = setup();
  const { doc_id, approval_id } = await submitted(t);
  t.objects.set(`${doc_id}/original.pdf`, { s3_version_id: 'v2', content_hash: 'h2' });
  const r = await t.call('approver', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'APPROVE', reason: 'x' });
  assert.equal(r.status, 409);
  // 반려는 가능
  const r2 = await t.call('approver', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'REJECT', reason: '변경됨' });
  assert.equal(r2.status, 200);
  assert.deepEqual(t.tasks, [{ token: 'tok-1', decision: 'REJECT' }]); // 반려도 SendTaskSuccess로 재개
});

test('보안: 승인 재사용·중복 결정 거부, USED 전환 1회만', async () => {
  const t = setup();
  const { approval_id } = await submitted(t);
  assert.equal((await t.call('approver', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'APPROVE', reason: 'x' })).status, 200);
  assert.equal((await t.call('approver', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'APPROVE', reason: 'x' })).status, 409);
  await t.store.consumeApproval(approval_id);
  await assert.rejects(t.store.consumeApproval(approval_id), /not usable/);
});

test('ACL: 미게시 문서는 작성자·승인자 외 404', async () => {
  const t = setup();
  const { doc_id } = await submitted(t);
  assert.equal((await t.call('user', 'GET', `/v1/documents/${doc_id}`)).status, 404);
  assert.equal((await t.call('author2', 'GET', `/v1/documents/${doc_id}/review`)).status, 404);
  assert.equal((await t.call('author', 'GET', `/v1/documents/${doc_id}`)).status, 200);
  const j = (await (await t.call('author', 'GET', `/v1/documents/${doc_id}`)).json()) as Record<string, unknown>;
  assert.equal(j.task_token, undefined);
});

test('QUARANTINED 문서는 게시 요청 불가', async () => {
  const t = setup();
  const r = await t.call('author', 'POST', '/v1/documents/upload-url', upload);
  const { doc_id } = (await r.json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', trust_gate_result: 'QUARANTINED', s3_version_id: 'v', content_hash: 'h' });
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/submit`)).status, 409);
});

test('가이드: 사용자 토큰을 Agent에 그대로 전달, 질문 길이 검증, 감사에 질의 원문 미기록', async () => {
  const t = setup();
  const r = await t.call('user', 'POST', '/v1/guides', { question: '담보 승인 기준 010-1111-2222' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { q: '담보 승인 기준 010-1111-2222', tok: 'user' });
  assert.ok(t.store.audits.every((a) => !JSON.stringify(a).includes('010-1111')));
  assert.equal((await t.call('user', 'POST', '/v1/guides', { question: ' ' })).status, 422);
});

test('분류 수정: 작성자 본인·IN_REVIEW만, 사람 수정 이력 저장', async () => {
  const t = setup();
  const { doc_id } = await submitted(t); // PENDING_APPROVAL 상태
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/classification`, { document_type: 'KNOWHOW', reason: 'x' })).status, 409);
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', classification: { document_type: 'MANUAL', business_path: ['여신'], tags: [], confidence: 0.6, rationale: 'r', source: 'MODEL' } });
  assert.equal((await t.call('author2', 'POST', `/v1/documents/${doc_id}/classification`, { document_type: 'KNOWHOW', reason: 'x' })).status, 404);
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/classification`, { document_type: 'KNOWHOW', reason: '실무 노하우 문서' })).status, 200);
  const e = (await t.store.getDoc(doc_id))!;
  assert.deepEqual([e.classification?.document_type, e.classification?.source, e.classification?.business_path], ['KNOWHOW', 'HUMAN', ['여신']]);
  assert.deepEqual(e.classification_history?.map((h) => [h.from, h.to, h.by]), [['MANUAL', 'KNOWHOW', 'u-author']]);
});

test('CORS: 허용 출처만 응답 헤더, 그 외 출처는 없음', async () => {
  const t = setup();
  const pre = (origin: string) => t.app.request('/v1/search?q=x', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });
  assert.equal((await pre('http://localhost:3000')).headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal((await pre('https://evil.example')).headers.get('access-control-allow-origin'), null);
});

test('승인 후 워크플로 재개가 실패해도 결정은 유지하고 workflow_resumed=false로 알림', async () => {
  const t = setup();
  const { approval_id } = await submitted(t);
  const app2 = createApp({ ...t.deps, sendDecision: async () => { throw Object.assign(new Error('x'), { name: 'TaskTimedOut' }); } });
  const r = await app2.request(`/v1/approvals/${approval_id}/decision`, { method: 'POST', headers: { authorization: 'Bearer approver', 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'APPROVE', reason: 'r' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { approval_id, status: 'APPROVED', workflow_resumed: false });
  assert.ok(t.store.audits.some((a) => a.action === 'WORKFLOW_RESUME_FAILED'));
});

test('ACL 키: DEPT#{부서}만 부서 일치로 인정', async () => {
  const { canRead } = await import('../src/auth.ts');
  assert.ok(canRead({ sub: 's', groups: ['USER'], dept: '여신' }, ['DEPT#여신']));
  assert.ok(!canRead({ sub: 's', groups: ['USER'], dept: '여신' }, ['dept:여신']));
  assert.ok(!canRead({ sub: 's', groups: ['USER'] }, ['DEPT#undefined']));
});
