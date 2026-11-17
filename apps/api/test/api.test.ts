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
    resume: async (d, decision) => { tasks.push({ token: d.doc_id, decision }); return true; },
    search: async () => [],
    guide: async (q, tok) => ({ q, tok }),
    webOrigins: ['http://localhost:3000'],
    workflowSteps: async () => [{ step: 'MalwareCheck', status: 'OK', ended_at: 't' }, { step: 'FileStructureCheck', status: 'OK', ended_at: 't' }],
    workflowFailure: async (wf) => (wf === 'wf_FAILED' ? { step: 'ParallelPreprocess', error: 'InvalidPDFException' } : undefined),
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
  await t.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', trust_gate_result: 'PASS', content_hash: 'sha256:h1', document_type: 'KNOWHOW' });
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

test('업로드 URL: 로그인한 누구나(규칙 1, 사용자 결정 11/17), 허용 확장자만, SigV4 리전 엔드포인트', async () => {
  const t = setup();
  assert.equal((await t.call('user', 'POST', '/v1/documents/upload-url', upload)).status, 201);
  assert.equal((await t.call(undefined, 'POST', '/v1/documents/upload-url', upload)).status, 401);
  assert.equal((await t.call('author', 'POST', '/v1/documents/upload-url', { ...upload, filename: 'a.pptx' })).status, 422);
  assert.equal((await t.call('author', 'POST', '/v1/documents/upload-url', { ...upload, size: 999_999_999 })).status, 422);
  const r = await t.call('author', 'POST', '/v1/documents/upload-url', upload);
  assert.equal(r.status, 201);
  const j = (await r.json()) as { doc_id: string; url: string };
  assert.match(j.doc_id, /^doc_[0-9A-Z]{26}$/);
  assert.match(j.url, /s3\.us-east-1\.amazonaws\.com.*AWS4-HMAC-SHA256/);
});

test('정상 승인: 다른 사람이 승인하면 APPROVED, AgentCore resume 호출', async () => {
  const t = setup();
  const { doc_id, approval_id } = await submitted(t);
  const r = await t.call('approver', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'APPROVE', reason: '근거 확인' });
  assert.equal(r.status, 200);
  assert.deepEqual(t.tasks, [{ token: doc_id, decision: 'APPROVE' }]);
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
  assert.deepEqual(t.tasks, [{ token: doc_id, decision: 'REJECT' }]); // 반려도 AgentCore resume
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
  const app2 = createApp({ ...t.deps, resume: async () => { throw Object.assign(new Error('x'), { name: 'TaskTimedOut' }); } });
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

test('출처 불일치(F-003류): 게시 요청 차단, 검토 큐에 노출, 승인자 반려 시 BLOCKED + 워크플로 종료', async () => {
  const t = setup();
  const r = await t.call('author', 'POST', '/v1/documents/upload-url', upload);
  const { doc_id } = (await r.json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  const mismatch = { finding_id: 'fnd_x', step: 'TRUST_GATE', severity: 'HIGH' as const, code: 'REGISTRY_MISMATCH', message: '공식 원본과 내용 불일치 · 위조 확정 아님', evidence_ref: 'SYN-LOAN-001@2026-11-01' };
  await t.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', trust_gate_result: 'REVIEW_REQUIRED', s3_version_id: 'v1', content_hash: 'sha256:x', findings: [mismatch] });

  const s = await t.call('author', 'POST', `/v1/documents/${doc_id}/submit`);
  assert.equal(s.status, 409);
  assert.match(((await s.json()) as { error: { message: string } }).error.message, /출처 확인 전/);

  assert.equal((await t.call('user', 'GET', '/v1/review-queue')).status, 403);
  const q = (await (await t.call('approver', 'GET', '/v1/review-queue')).json()) as { items: { doc_id: string }[] };
  assert.deepEqual(q.items.map((i) => i.doc_id), [doc_id]);

  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/source-review`, { decision: 'REJECT', reason: 'x' })).status, 403);
  const rv = await t.call('approver', 'POST', `/v1/documents/${doc_id}/source-review`, { decision: 'REJECT', reason: '공식 원본과 승인 기준 금액 불일치' });
  assert.equal(rv.status, 200);
  const e = (await t.store.getDoc(doc_id))!;
  assert.deepEqual([e.lifecycle, e.authority_status], ['BLOCKED', 'REJECTED']);
  assert.deepEqual(t.tasks.at(-1), { token: doc_id, decision: 'REJECT' });
  assert.equal((await t.call('approver', 'POST', `/v1/documents/${doc_id}/source-review`, { decision: 'REJECT', reason: 'again' })).status, 409);
  assert.equal(((await (await t.call('approver', 'GET', '/v1/review-queue')).json()) as { items: unknown[] }).items.length, 0);
});

test('파이프라인 실패: QUARANTINED 문서 조회 시 실패 단계·오류 이름 노출', async () => {
  const t = setup();
  const r = await t.call('author', 'POST', '/v1/documents/upload-url', upload);
  const { doc_id } = (await r.json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, workflow_id: 'wf_FAILED' });
  const g = (await (await t.call('author', 'GET', `/v1/documents/${doc_id}`)).json()) as Record<string, unknown>;
  assert.deepEqual(g.workflow_failure, { step: 'ParallelPreprocess', error: 'InvalidPDFException' });
});

test('업로드 진행: 작성자·승인자만, 완료 단계 수와 진행 중 단계', async () => {
  const t = setup();
  const r = await t.call('author', 'POST', '/v1/documents/upload-url', upload);
  const { doc_id } = (await r.json()) as { doc_id: string };
  const p = (await (await t.call('author', 'GET', `/v1/documents/${doc_id}/progress`)).json()) as { done: number; total: number; steps: { key: string; state: string }[] };
  assert.equal(p.done, 2);
  assert.equal(p.steps.find((s) => s.state === 'running')?.key, 'ConvertToPdf'); // 파일 구조 검사 다음은 문서 변환 (요청기록/20261117-2010)
  assert.equal((await t.call('author2', 'GET', `/v1/documents/${doc_id}/progress`)).status, 404);
  assert.equal((await t.call('approver', 'GET', `/v1/documents/${doc_id}/progress`)).status, 200);
});

test('가이드 스트리밍: Accept text/event-stream이면 Runtime SSE를 그대로 중계, 아니면 JSON', async () => {
  const t = setup();
  const sse = 'event: progress\ndata: {"text":"검색 중"}\n\nevent: result\ndata: {"status":"OK"}\n\n';
  t.deps.guideStream = async () => new Response(sse).body!;
  const app = (await import('../src/app.ts')).createApp(t.deps);
  const r = await app.request('/v1/guides', { method: 'POST', headers: { authorization: 'Bearer user', 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ question: '담보 승인' }) });
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  assert.equal(await r.text(), sse);
  const j = await t.call('user', 'POST', '/v1/guides', { question: '담보 승인' });
  assert.equal(j.headers.get('content-type')?.startsWith('application/json'), true);
});

test('업로드 진행: 건너뛴 단계(그림 분석 꺼짐)는 진행 중으로 남지 않음', async () => {
  const { progress } = await import('../src/progress.ts');
  const p = progress('QUARANTINED', ['MalwareCheck', 'FileStructureCheck', 'TextLayerExtract', 'PageRender', 'OcrIfNeeded', 'SegmentBuild', 'PiiScan', 'InjectionScan'].map((step) => ({ step, status: 'OK' })));
  assert.equal(p.steps.find((s) => s.key === 'ImageDescribe')?.state, 'skipped');
  assert.equal(p.steps.find((s) => s.state === 'running')?.key, 'PageSummarize'); // 꺼져 있으면 Classify 기록 시 skipped
  assert.equal(p.total, 13);
  assert.equal(progress('IN_REVIEW', []).done, progress('IN_REVIEW', []).total);
});

test('검색: search_wiki에 사용자 신원·필터를 넘기고 화면 항목으로 변환', async () => {
  const { searchVia } = await import('../src/search.ts');
  let seen: { args: Record<string, unknown>; actor: unknown } | undefined;
  const s = searchVia(async (args, actor) => { seen = { args, actor }; return { items: [
    { doc_id: 'd1', title: '규정', snippet: '5억원', provision: '기업여신 심사규정 제12조제1항', effective_from: '2026-11-01', authority_status: 'VERIFIED', freshness: 'CURRENT', search_status: 'FOUND', document_type: 'REGULATION' },
    { doc_id: 'd2', title: '팁', snippet: 's', effective_from: '', authority_status: 'VERIFIED', freshness: 'REVIEW_REQUIRED', search_status: 'FOUND', document_type: 'KNOWHOW' },
  ] }; });
  const items = await s('담보', { sub: 'u', groups: ['USER'], dept: 'loan' }, { tags: ['체크리스트'], business: '여신' });
  assert.deepEqual(seen!.args, { query: '담보', top_k: 10, tags: ['체크리스트'], business: '여신' });
  assert.deepEqual(seen!.actor, { sub: 'u', groups: ['USER'], dept: 'loan' });
  assert.equal(items[0]!.basis, '기업여신 심사규정 제12조제1항');
  assert.match(items[1]!.reason, /재검토/);
  assert.equal(items[1]!.effective_from, undefined);
});

test('분류 전 문서는 게시 요청 409, 승인 뒤 게시가 멈추면 결재함에 실패 단계 표시', async () => {
  const t = setup();
  const r = await t.call('author', 'POST', '/v1/documents/upload-url', upload);
  const { doc_id } = (await r.json()) as { doc_id: string };
  t.objects.set(`${doc_id}/original.pdf`, { s3_version_id: 'v1', content_hash: 'h1' });
  await t.call('author', 'POST', `/v1/documents/${doc_id}/analyze`);
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', trust_gate_result: 'PASS', content_hash: 'sha256:h1' });
  const s = await t.call('author', 'POST', `/v1/documents/${doc_id}/submit`);
  assert.equal(s.status, 409);
  assert.match(((await s.json()) as { error: { message: string } }).error.message, /unclassified/);

  const ok = await submitted(t);
  await t.store.putDoc({ ...(await t.store.getDoc(ok.doc_id))!, workflow_id: 'wf_FAILED' });
  assert.equal((await t.call('approver', 'POST', `/v1/approvals/${ok.approval_id}/decision`, { decision: 'APPROVE', reason: '확인' })).status, 200);
  const list = (await (await t.call('approver', 'GET', '/v1/approvals?status=APPROVED')).json()) as { items: { title: string; workflow_failure?: { step: string } }[] };
  assert.equal(list.items[0]!.title, upload.title);
  assert.equal(list.items[0]!.workflow_failure?.step, 'ParallelPreprocess');
});

test('차단 사유: 코드별 사용자 문장, 원문 없음', async () => {
  const { blockedReasons } = await import('../src/progress.ts');
  assert.deepEqual(blockedReasons([{ severity: 'HIGH', code: 'PDF_EMBEDDED_FILE', step: 'FILE_STRUCTURE' }, { severity: 'MEDIUM', code: 'X', step: 'PII_SCAN' }]),
    ['첨부 파일이 포함된 PDF는 보안상 등록할 수 없습니다. 첨부를 뺀 PDF로 다시 올려 주세요.']);
  assert.match(blockedReasons([{ severity: 'HIGH', code: 'OVERRIDE_KO', step: 'INJECTION_SCAN' }])[0]!, /지시하는 문구/);
});

test('사유 목록: 단계 Finding(쪽·안내) + 게시 실패 문장(사유/조치 분리), 작성자·관리자만, 쪽 이미지', async () => {
  const t = setup();
  t.deps.pageImage = async (_d, n) => (n === 1 ? new Uint8Array([137, 80, 78, 71]) : undefined);
  t.deps.pageImageList = async () => [1];
  t.deps.explanation = async () => ({ summary: '첨부 파일 때문에 차단', items: [] });
  t.deps.workflowFailure = async () => ({ step: 'Promote', error: 'RegistryNotFound', message: '공식 원본 목록에서 이 규정을 찾지 못해 게시할 수 없습니다 (조치: 분류를 노하우로 바꿔 다시 요청해 주세요.)' });
  const app = (await import('../src/app.ts')).createApp(t.deps);
  const call = (who: string, path: string) => app.request(path, { headers: { authorization: `Bearer ${who}` } });
  const r = await t.call('author', 'POST', '/v1/documents/upload-url', upload);
  const { doc_id } = (await r.json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'PENDING_APPROVAL', findings: [{ finding_id: 'f1', step: 'PII_SCAN', severity: 'MEDIUM', code: 'PII_UNCERTAIN_ACCOUNT', message: 'm', evidence_ref: 'page:1', location: { page: 2, excerpt: '참조 [계좌번호]' }, user_message: '2쪽에서 계좌번호 1건', fix_hint: '확인' }] });
  const j = (await (await call('author', `/v1/documents/${doc_id}/issues`)).json()) as { items: { step_label: string; user_message: string; fix_hint?: string; location?: { page: number } }[]; page_images: number[] };
  assert.equal(j.items[0]!.step_label, '게시');
  assert.match(j.items[0]!.user_message, /찾지 못해 게시할 수 없습니다$/);
  assert.match(j.items[0]!.fix_hint!, /^분류를 노하우로/);
  assert.equal(j.items[1]!.location?.page, 2);
  assert.deepEqual(j.page_images, [2]);
  assert.equal((j as unknown as { explanation: { summary: string } }).explanation.summary, '첨부 파일 때문에 차단');
  assert.equal((await call('author2', `/v1/documents/${doc_id}/issues`)).status, 404);
  assert.equal((await call('approver', `/v1/documents/${doc_id}/issues`)).status, 200);
  const img = await call('author', `/v1/documents/${doc_id}/pages/2/image`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await call('author', `/v1/documents/${doc_id}/pages/1/image`)).status, 404);
  assert.equal((await call('author2', `/v1/documents/${doc_id}/pages/2/image`)).status, 404);
});

test('검색 종류 필터: type이면 해당 색인만 찾고 결과도 그 종류만, 잘못된 type은 422', async () => {
  const t = setup();
  let seen: unknown;
  t.deps.search = async (_q, _a, o) => { seen = o; return [{ doc_id: 'a', document_type: 'MANUAL' }, { doc_id: 'b', document_type: 'KNOWHOW' }]; };
  const app = (await import('../src/app.ts')).createApp(t.deps);
  const r = await app.request('/v1/search?q=x&type=MANUAL', { headers: { authorization: 'Bearer user' } });
  assert.deepEqual(((await r.json()) as { items: { doc_id: string }[] }).items.map((i) => i.doc_id), ['a']);
  assert.deepEqual((seen as { index_groups: string[] }).index_groups, ['wiki-knowledge', 'official-manuals']);
  assert.equal((await app.request('/v1/search?q=x&type=BAD', { headers: { authorization: 'Bearer user' } })).status, 422); // VALIDATION
});

test('검색: 의미 검색에 없는 게시 문서도 제목·요약에 검색어가 있으면 뒤에 더한다 (미게시·권한 밖 제외)', async () => {
  const t = setup();
  t.deps.search = async () => [{ doc_id: 'doc_R', document_type: 'REGULATION', title: '개인정보 보호규정' }];
  const base = { version: 1, owner: 'u-other', dept: 'd', ext: 'pdf', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, findings: [], created_at: '', updated_at: '' };
  await t.store.putDoc({ ...base, doc_id: 'doc_R', title: '개인정보 보호규정', acl_groups: ['ALL'], lifecycle: 'PUBLISHED', document_type: 'REGULATION' });
  await t.store.putDoc({ ...base, doc_id: 'doc_M', title: '테스트문서', summary: '개인정보 수집·이용 업무 가이드', acl_groups: ['ALL'], lifecycle: 'PUBLISHED', document_type: 'MANUAL' });
  await t.store.putDoc({ ...base, doc_id: 'doc_D', title: '개인정보 초안', acl_groups: ['ALL'], lifecycle: 'IN_REVIEW' });
  await t.store.putDoc({ ...base, doc_id: 'doc_S', title: '개인정보 인사 비공개', acl_groups: ['DEPT#hr'], lifecycle: 'PUBLISHED' });
  const app = (await import('../src/app.ts')).createApp(t.deps);
  const r = (await (await app.request('/v1/search?q=' + encodeURIComponent('개인정보'), { headers: { authorization: 'Bearer user' } })).json()) as { items: { doc_id: string; reason?: string }[] };
  assert.deepEqual(r.items.map((i) => i.doc_id), ['doc_R', 'doc_M']);
  assert.match(r.items[1]!.reason!, /제목·요약/);
});

test('검색 질의 재구성: rewritten을 그대로 내려주고, 핵심어로 키워드 보완, raw=1이면 rewrite:false 전달', async () => {
  const { searchVia } = await import('../src/search.ts');
  const calls: Record<string, unknown>[] = [];
  const s = searchVia(async (args) => { calls.push(args); return { items: [], rewritten: args.rewrite === false ? undefined : { core: '개인정보', alternates: ['개인정보 처리', '개인정보 보호규정', '초과'] } }; });
  const r = await s('개인정보 관련된 문서들을 찾아줘', { sub: 'u', groups: ['USER'] } as never, { tags: [] });
  assert.deepEqual(r.rewritten, { core: '개인정보', alternates: ['개인정보 처리', '개인정보 보호규정'] });
  assert.equal('rewrite' in calls[0]!, false);
  const raw = await s('개인정보 관련된 문서들을 찾아줘', { sub: 'u', groups: ['USER'] } as never, { tags: [], rewrite: false });
  assert.equal(calls[1]!.rewrite, false);
  assert.equal(raw.rewritten, undefined);
});

test('ulidTime: workflow_id 앞 10자에서 생성 시각', async () => {
  const { ulidTime } = await import('../src/app.ts');
  const t = Date.parse(ulidTime('wf_01M7KZPWCGEBKSA27FAC9MWV9A')!);
  assert.ok(t <= Date.parse('2026-11-17T05:30:24.957Z') && t > Date.parse('2026-11-17T05:20:00Z'), new Date(t).toISOString());
  assert.equal(ulidTime('bad'), undefined);
});

test('운영 도구: 실행 기록은 결재자만, 시작·소요·실패 단계 / 변경 영향은 규정 결재자 토큰으로 trace_impact', async () => {
  const t = setup();
  t.deps.workflowRuns = async () => [
    { workflow_id: 'wf_01M7KZPWCGEBKSA27FAC9MWV9A', doc_id: 'doc_x', status: 'SUCCEEDED', ended_at: '2026-11-17T05:30:24.957Z', kind: 'ingest', steps: [{ step: 'Classify', status: 'OK', ended_at: '2026-11-17T05:29:53.688Z' }] },
    { workflow_id: 'wf_01M7MEH5136HE3JJ68AD8M0WWS', steps: [{ step: 'PiiScan', status: 'FAILED', ended_at: '2026-11-17T09:48:00.000Z', error: 'Timeout' }] },
  ];
  assert.equal((await t.call('user', 'GET', '/v1/admin/runs')).status, 403);
  const r = (await (await t.call('approver', 'GET', '/v1/admin/runs')).json()) as { items: { workflow_id: string; status: string; duration_s?: number; failed_step?: string; title?: string }[]; trace_url: string };
  assert.equal(r.items[0]!.workflow_id, 'wf_01M7MEH5136HE3JJ68AD8M0WWS'); // 최근 먼저
  assert.equal(r.items[0]!.status, 'FAILED'); assert.equal(r.items[0]!.failed_step, 'PiiScan');
  assert.ok((r.items[1]!.duration_s ?? -1) >= 0); assert.equal(r.items[1]!.title, '(삭제된 문서)');
  assert.match(r.trace_url, /gen-ai-observability/);
  assert.equal((await t.call('approver', 'GET', '/v1/admin/runs/bad')).status, 422);

  const seen: unknown[] = [];
  t.deps.traceImpact = async (a, tok) => { seen.push([a, tok]); return { changes: [], impacted: [] }; };
  assert.equal((await t.call('author', 'GET', '/v1/admin/impact?law=x')).status, 403);
  assert.equal((await t.call('approver', 'GET', '/v1/admin/impact?law=하나은행 기업여신 심사규정')).status, 200);
  assert.deepEqual(seen[0], [{ law: '하나은행 기업여신 심사규정' }, 'approver']);
  t.deps.traceImpact = async () => { throw Object.assign(new Error('x'), { name: 'ToolError' }); };
  assert.equal((await t.call('approver', 'GET', '/v1/admin/impact?law=없는규정')).status, 404);
});

test('검색 질의 재구성: 핵심어가 원문과 같아도 다른 표현은 칩으로 남긴다', async () => {
  const { searchVia } = await import('../src/search.ts');
  const s = searchVia(async () => ({ items: [], rewritten: { core: '개인정보 처리방법', alternates: ['개인정보 처리방법', '개인정보 처리 절차'] } }));
  assert.deepEqual((await s('개인정보 처리방법', { sub: 'u', groups: ['USER'] } as never, { tags: [] })).rewritten, { core: '개인정보 처리방법', alternates: ['개인정보 처리 절차'] });
  const none = searchVia(async () => ({ items: [], rewritten: { core: '개인정보', alternates: [] } }));
  assert.equal((await none('개인정보', { sub: 'u', groups: ['USER'] } as never, { tags: [] })).rewritten, undefined);
});

test('업무 분류: 트리 수는 볼 수 있는 게시 문서(하위 포함), 보관함 필터는 하위 칸 포함, 이름 수정·병합은 결재자만', async () => {
  const t = setup();
  const base = { version: 1, owner: 'u-other', dept: 'd', ext: 'pdf', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, findings: [], created_at: '', updated_at: '' };
  await t.store.putDoc({ ...base, doc_id: 'doc_A', title: '기업여신 심사', acl_groups: ['ALL'], lifecycle: 'PUBLISHED' });
  await t.store.putDoc({ ...base, doc_id: 'doc_B', title: '담보 평가', acl_groups: ['ALL'], lifecycle: 'PUBLISHED' });
  await t.store.putDoc({ ...base, doc_id: 'doc_H', title: '인사 비공개', acl_groups: ['DEPT#hr'], lifecycle: 'PUBLISHED' });
  const cat = (category_id: string, parent_id: string | null, path: string) => ({ category_id, parent_id, name: path.split('/').at(-1)!, path, level: path.split('/').length, description: '', doc_count: 0 });
  const calls: unknown[] = [];
  t.deps.categories = {
    list: async () => [cat('cat_loan', null, '여신'), cat('cat_corp', 'cat_loan', '여신/기업여신'), cat('cat_hr', null, '인사·교육')],
    docMap: async () => new Map([['doc_A', 'cat_corp'], ['doc_B', 'cat_loan'], ['doc_H', 'cat_hr']]),
    rename: async (...a) => { calls.push(['rename', ...a]); return { ok: true }; },
    merge: async (from) => { if (from === 'cat_loan') throw new Error('HasChildren'); return { moved: 1 }; },
  };
  const tree = (await (await t.call('user', 'GET', '/v1/categories')).json()) as { items: { category_id: string; doc_count: number }[] };
  assert.deepEqual(tree.items.map((x) => [x.category_id, x.doc_count]), [['cat_loan', 2], ['cat_corp', 1], ['cat_hr', 0]]); // 인사 문서는 user 권한 밖
  const lib = (await (await t.call('user', 'GET', '/v1/library?category=cat_loan')).json()) as { items: { doc_id: string; category_path: string }[] };
  assert.deepEqual(lib.items.map((x) => x.doc_id).sort(), ['doc_A', 'doc_B']);
  assert.equal(lib.items.find((x) => x.doc_id === 'doc_A')!.category_path, '여신/기업여신');
  assert.equal((await t.call('user', 'PATCH', '/v1/categories/cat_corp', { name: '기업 대출' })).status, 403);
  assert.equal((await t.call('approver', 'PATCH', '/v1/categories/cat_corp', { name: '기업/대출' })).status, 422);
  assert.equal((await t.call('approver', 'PATCH', '/v1/categories/cat_corp', { name: '기업 대출' })).status, 200);
  assert.deepEqual(calls[0], ['rename', 'cat_corp', '기업 대출', 'u-approver']);
  assert.equal((await t.call('approver', 'POST', '/v1/categories/cat_loan/merge', { into: 'cat_hr' })).status, 409);
});

test('주장: 상세에 문서 주장 + 같은 조문 게시 주장의 지지·충돌 수, 지식 부채는 결재자만', async () => {
  const t = setup();
  const base = { version: 1, owner: 'u-other', dept: 'd', ext: 'pdf', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, findings: [], created_at: '', updated_at: '' };
  await t.store.putDoc({ ...base, doc_id: 'doc_K', title: '노하우', acl_groups: ['ALL'], lifecycle: 'PUBLISHED', document_type: 'KNOWHOW' });
  t.deps.claims = {
    list: async () => [{ claim_id: 'doc_K#1', seq: 1, statement: '감정평가서는 6개월 이내', page: 1, provision_id: 'P1', relation: 'SUPPORTS', reason: 'r', quote: 'q', verified: true, status: 'CURRENT', status_reason: null }],
    counts: async () => new Map([['P1', { SUPPORTS: 2, SUPPLEMENTS: 1, CONFLICTS: 1 }]]),
    debt: async () => ({ conflicts: 1, review_required: 0, unverified: 2, healthy: 3, docs_needing_attention: 1 }),
  };
  const d = (await (await t.call('user', 'GET', '/v1/library/doc_K')).json()) as { claims: { on_provision: unknown }[] };
  assert.deepEqual(d.claims[0]!.on_provision, { supports: 3, conflicts: 1, unclear: 0 });
  assert.equal((await t.call('user', 'GET', '/v1/admin/knowledge-debt')).status, 403);
  assert.equal(((await (await t.call('approver', 'GET', '/v1/admin/knowledge-debt')).json()) as { healthy: number }).healthy, 3);
});

test('위키 수정: 게시 노하우 → 새 버전(WIKI_EDIT·previous·original.md), 규정 불가, 내 검토 중 문서는 그 자리 재분석, 고칠 것 남으면 게시 요청 잠금', async () => {
  const t = setup();
  const put: string[] = [];
  t.deps.putOriginal = async (k) => { put.push(k); };
  const base = { version: 1, owner: 'u-other', dept: 'd', ext: 'pdf', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, findings: [], created_at: '', updated_at: '' };
  await t.store.putDoc({ ...base, doc_id: 'doc_K', title: '시재 마감 노하우', acl_groups: ['ALL'], lifecycle: 'PUBLISHED', document_type: 'KNOWHOW' });
  await t.store.putDoc({ ...base, doc_id: 'doc_R', title: '규정', acl_groups: ['ALL'], lifecycle: 'PUBLISHED', document_type: 'REGULATION' });
  assert.equal((await t.call('user', 'POST', '/v1/documents/doc_R/edit', { markdown: '# 규정' })).status, 409);
  const r = await t.call('user', 'POST', '/v1/documents/doc_K/edit', { markdown: '## 시재 마감\n1. 마감 30분 전 시재표 출력' });
  assert.equal(r.status, 201);
  const { doc_id, new_version } = (await r.json()) as { doc_id: string; new_version: boolean };
  const nd = (await t.store.getDoc(doc_id))!;
  assert.ok(new_version && nd.owner === 'u-user' && nd.source === 'WIKI_EDIT' && nd.previous_doc_id === 'doc_K' && nd.ext === 'md' && nd.lifecycle === 'QUARANTINED');
  assert.deepEqual(put, [`${doc_id}/original.md`]);
  // 분석이 끝나 고칠 것이 남은 상태 → 게시 요청 잠김 → 그 자리에서 고쳐 다시 분석
  await t.store.putDoc({ ...nd, lifecycle: 'IN_REVIEW', trust_gate_result: 'REVIEW_REQUIRED', s3_version_id: 'v1', content_hash: 'sha256:x',
    findings: [{ finding_id: 'f1', step: 'TRUST_GATE', severity: 'HIGH', code: 'KNOWHOW_CONFLICT', message: 'm', evidence_ref: 'e' }] });
  const s = await t.call('user', 'POST', `/v1/documents/${doc_id}/submit`);
  assert.equal(s.status, 409);
  assert.match(JSON.stringify(await s.json()), /고칠 것 1건/);
  const again = (await (await t.call('user', 'POST', `/v1/documents/${doc_id}/edit`, { markdown: '## 고친 본문' })).json()) as { doc_id: string; new_version: boolean };
  assert.equal(again.doc_id, doc_id); assert.equal(again.new_version, false);
  assert.equal((await t.store.getDoc(doc_id))!.findings.length, 0);
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/edit`, { markdown: 'x' })).status, 404); // 남의 검토 중 문서
});
