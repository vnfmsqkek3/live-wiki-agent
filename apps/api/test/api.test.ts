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
  authorAdmin: { sub: 'u-author', groups: ['AUTHOR', 'REG_APPROVER', 'PLATFORM_OPERATOR'] }, // 관리자 본인 문서 (11/18 허용)
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
  assert.equal(r.status, 403); // 일반 결재자(REG_APPROVER)는 본인 문서 승인 금지 유지
});

test('관리자(PLATFORM_OPERATOR)는 본인 문서 승인 가능 — self_approved, 감사 SELF_APPROVAL, 결재함 own 표시 (사용자 결정 11/18)', async () => {
  const t = setup();
  const { approval_id } = await submitted(t);
  const list = (await (await t.call('authorAdmin', 'GET', '/v1/approvals?status=PENDING')).json()) as { items: { approval_id: string; own: boolean }[] };
  assert.equal(list.items.find((i) => i.approval_id === approval_id)?.own, true);
  // 그대로 사용한 규정 충돌은 결재 카드에 (승인자 판단, 사용자 결정 11/18)
  const { doc_id } = (await t.store.getApproval(approval_id))!;
  const dd = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...dd, findings: [{ finding_id: 'k', step: 'TRUST_GATE', severity: 'HIGH', code: 'KNOWHOW_CONFLICT', message: 'm', evidence_ref: 'e', location: { excerpt: '재무제표 보관 기간 5년' }, acknowledged: { by: 'u', at: 't', reason: '영업점 기준' } }] });
  const l2 = (await (await t.call('authorAdmin', 'GET', '/v1/approvals?status=PENDING')).json()) as { items: { approval_id: string; kept: unknown }[] };
  assert.deepEqual(l2.items.find((i) => i.approval_id === approval_id)?.kept, [{ text: '재무제표 보관 기간 5년', reason: '영업점 기준', system: false }]);
  const r = await t.call('authorAdmin', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'APPROVE', reason: 'x' });
  assert.equal(r.status, 200);
  assert.equal((await t.store.getApproval(approval_id))?.self_approved, true);
  assert.ok((t.store as unknown as { audits: { action: string }[] }).audits.some((a) => a.action === 'SELF_APPROVAL'));
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
  assert.equal(p.total, 14); // 참조 확인(ReferenceCheck) 단계 추가 11/18
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

test('재검토 이유 보충·시행 예정 개정판 (프론트 8차 11/23): 수정 제안 없는 재검토는 주장 provision_revised 로 changes 1건(상세만), 같은 묶음의 시행일 > 오늘 게시본은 upcoming', async () => {
  const t = setup();
  const base = { version: 1, owner: 'u-other', dept: 'd', ext: 'pdf', authority_status: 'VERIFIED' as const, findings: [], created_at: '', updated_at: '', acl_groups: ['ALL'], lifecycle: 'PUBLISHED' as const };
  const fr = { law_id: 'SYN-LOAN-001', law_name: '기업여신 심사규정', cited_revision: '', current_revision: '', effective_from: '', provisions: [], at: '' };
  await t.store.putDoc({ ...base, doc_id: 'doc_R', title: '노하우', document_type: 'KNOWHOW', freshness: 'REVIEW_REQUIRED', freshness_reason: fr });
  const OLD = 'SYN-LOAN-001@2026-11-01/ARTICLE:5/PARAGRAPH:1', NEW = 'SYN-LOAN-001@2099-01-01/ARTICLE:5/PARAGRAPH:1';
  t.deps.claims = {
    list: async () => [{ claim_id: 'doc_R#1', seq: 1, statement: '한도는 3억원', page: 1, provision_id: OLD, relation: 'SUPPORTS', reason: '', quote: '한도는 3억원까지 영업점장 전결', verified: true, status: 'REVIEW_REQUIRED', status_reason: `provision_revised:${NEW}` }],
    counts: async () => new Map(), debt: async () => ({ conflicts: 0, review_required: 1, unverified: 0, healthy: 0, docs_needing_attention: 1 }),
  };
  const cl: Record<string, { text: string; effective_from: string }> = { [OLD]: { text: '한도는 3억원 이하', effective_from: '2026-11-01' }, [NEW]: { text: '한도는 2억원 이하', effective_from: '2099-01-01' } };
  t.deps.clause = async (id) => cl[id] && { provision_id: id, label: '하나은행 기업여신 심사규정 제5조제1항', status: 'ACTIVE', ...cl[id] };
  const d = (await (await t.call('user', 'GET', '/v1/library/doc_R')).json()) as { freshness_reason: { effective_from: string; open_change_requests: number; changes: unknown[] } };
  assert.deepEqual(d.freshness_reason.changes, [{ provision_id: NEW, label: '제5조제1항', kind: 'MODIFIED', old_text: '한도는 3억원 이하', new_text: '한도는 2억원 이하', cited_text: '한도는 3억원까지 영업점장 전결' }]);
  assert.deepEqual([d.freshness_reason.effective_from, d.freshness_reason.open_change_requests], ['2099-01-01', 0]);

  // 규정 v1(시행 중)·v2(2099 시행 예정) 같은 law_id 묶음 → v1 카드에 upcoming = v2
  const reg = { ...base, document_type: 'REGULATION' as const, law_id: 'SYN-REV-001', freshness: 'CURRENT' as const };
  await t.store.putDoc({ ...reg, doc_id: 'doc_V1', title: '규정 v1', effective_from: '2026-11-01', revision_id: '2026-11-01' });
  await t.store.putDoc({ ...reg, doc_id: 'doc_V2', title: '규정 v2', effective_from: '2099-01-01', revision_id: '2099-01-01' });
  const v1 = (await (await t.call('user', 'GET', '/v1/library/doc_V1')).json()) as { upcoming: unknown };
  assert.deepEqual(v1.upcoming, { doc_id: 'doc_V2', version_no: 2, effective_from: '2099-01-01' });
  assert.equal(((await (await t.call('user', 'GET', '/v1/library/doc_V2')).json()) as { upcoming: unknown }).upcoming, null);
});

test('위키 수정: 게시 노하우 → 새 버전(WIKI_EDIT·previous·original.md), 규정 불가, 내 검토 중 문서는 그 자리 재분석, 고칠 것 남으면 게시 요청 잠금', async () => {
  const t = setup();
  const put: string[] = [];
  t.deps.putOriginal = async (k) => { put.push(k); };
  const base = { version: 1, owner: 'u-other', dept: 'd', ext: 'pdf', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, findings: [], created_at: '', updated_at: '' };
  await t.store.putDoc({ ...base, doc_id: 'doc_K', title: '시재 마감 노하우', acl_groups: ['ALL'], lifecycle: 'PUBLISHED', document_type: 'KNOWHOW' });
  await t.store.putDoc({ ...base, doc_id: 'doc_R', title: '규정', acl_groups: ['ALL'], lifecycle: 'PUBLISHED', document_type: 'REGULATION' });
  assert.equal((await t.call('user', 'POST', '/v1/documents/doc_R/edit', { markdown: '# 규정' })).status, 409);
  await t.store.putDoc({ ...base, doc_id: 'doc_OLD', title: '옛 판', acl_groups: ['ALL'], lifecycle: 'PUBLISHED', document_type: 'KNOWHOW', freshness: 'SUPERSEDED' });
  assert.equal((await t.call('user', 'POST', '/v1/documents/doc_OLD/edit', { markdown: '# 옛 판' })).status, 409); // 대체된 판은 최신에서 고친다
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
  assert.match(JSON.stringify(await s.json()), /고칠 것·확인할 것 1건/);
  const again = (await (await t.call('user', 'POST', `/v1/documents/${doc_id}/edit`, { markdown: '## 고친 본문' })).json()) as { doc_id: string; new_version: boolean };
  assert.equal(again.doc_id, doc_id); assert.equal(again.new_version, false);
  assert.equal((await t.store.getDoc(doc_id))!.findings.length, 0);
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/edit`, { markdown: 'x' })).status, 404); // 남의 검토 중 문서
});

test('보관함 쪽 이미지: 문서를 볼 수 있으면 누구나(가린 이미지), 볼 수 없으면 404, 상세에 그림 있는 쪽 목록', async () => {
  const t = setup();
  const base = { version: 1, owner: 'u-other', dept: 'd', ext: 'pdf', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, findings: [], created_at: '', updated_at: '' };
  await t.store.putDoc({ ...base, doc_id: 'doc_M', title: '복합기 매뉴얼', acl_groups: ['ALL'], lifecycle: 'PUBLISHED', document_type: 'MANUAL' });
  await t.store.putDoc({ ...base, doc_id: 'doc_H', title: '인사', acl_groups: ['DEPT#hr'], lifecycle: 'PUBLISHED', document_type: 'MANUAL' });
  t.deps.pageImage = async (_id, i) => (i === 2 ? new Uint8Array([137, 80, 78, 71]) : undefined);
  t.deps.pageImageList = async () => [2];
  assert.equal((await t.call('user', 'GET', '/v1/library/doc_M/pages/3/image')).status, 200);
  assert.equal((await t.call('user', 'GET', '/v1/library/doc_M/pages/1/image')).status, 404);
  assert.equal((await t.call('user', 'GET', '/v1/library/doc_H/pages/3/image')).status, 404);
  assert.deepEqual(((await (await t.call('user', 'GET', '/v1/library/doc_M')).json()) as { image_pages: number[] }).image_pages, [2]);
});

test('원본 보기: 모든 쪽 가린 이미지 presigned 목록(볼 수 있는 사람), 권한 밖 404', async () => {
  const t = setup();
  const base = { version: 1, owner: 'u-other', dept: 'd', ext: 'pdf', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, findings: [], created_at: '', updated_at: '' };
  await t.store.putDoc({ ...base, doc_id: 'doc_M', title: '매뉴얼', acl_groups: ['ALL'], lifecycle: 'PUBLISHED', document_type: 'MANUAL' });
  await t.store.putDoc({ ...base, doc_id: 'doc_H', title: '인사', acl_groups: ['DEPT#hr'], lifecycle: 'PUBLISHED', document_type: 'MANUAL' });
  t.deps.viewPageList = async () => [0, 1];
  t.deps.presignView = async (k) => `https://s3.example/${k}?sig`;
  const r = (await (await t.call('user', 'GET', '/v1/library/doc_M/pages')).json()) as { items: { page: number; url: string }[] };
  assert.deepEqual(r.items.map((x) => x.page), [1, 2]);
  assert.match(r.items[0]!.url, /doc_M\/masked\/view\/0000\.png/);
  assert.equal((await t.call('user', 'GET', '/v1/library/doc_H/pages')).status, 404);
  assert.ok(t.store.audits.every((a) => !JSON.stringify(a).includes('s3.example'))); // URL 은 감사에 남기지 않음
});

test('확인 필요 답 넣기(11/18): 담당자 이름 판단은 모델(이름만이면 ok=false), 모델이 없으면 담당자 답은 넣지 않음, 개인정보는 코드가 막음, 항목 하나만 바뀜', async () => {
  const t = setup();
  // 모델 흉내: f1 은 넣고, f2(이름뿐)는 거절
  t.deps.composeClarify = async () => ({ edits: [{ n: 0, ok: true, after: '서류는 여신심사부 심사역이 승인한다.' }, { n: 1, ok: false, after: '', reason: '부서·직책으로 적어 주세요' }] });
  const r = await t.call('author', 'POST', '/v1/documents/upload-url', upload);
  const { doc_id } = (await r.json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  const F = (id: string, item: string, before: string) => ({ finding_id: id, step: 'REFERENCE_CHECK', severity: 'MEDIUM', code: 'CLARIFY_NEEDED', message: 'x', evidence_ref: 'm',
    details: { kind: 'VAGUE_ACTOR', item, before, question: '어느 부서인가요?', suggestions: [], status: 'OPEN' } });
  await t.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', findings: [F('f1', '담당자', '서류는 담당자가 승인한다.'), F('f2', '관련 부서', '문의는 관련 부서로 한다.')] as never });
  const res = await t.call('author', 'POST', `/v1/documents/${doc_id}/clarify/compose`, { answers: [{ finding_id: 'f1', answer: '여신심사부 심사역' }, { finding_id: 'f2', answer: '홍길동 대리' }] });
  assert.equal(res.status, 200);
  const { edits } = (await res.json()) as { edits: { finding_id: string; after: string; ok: boolean }[] };
  assert.deepEqual(edits.map((e) => [e.finding_id, e.ok]), [['f1', true], ['f2', false]]);
  assert.equal(edits[0]!.after, '서류는 여신심사부 심사역이 승인한다.');
  // 모델이 없으면 담당자 답은 그대로 넣지 않는다
  t.deps.composeClarify = undefined;
  const nm = (await (await t.call('author', 'POST', `/v1/documents/${doc_id}/clarify/compose`, { answers: [{ finding_id: 'f1', answer: '여신심사부 심사역' }] })).json()) as { edits: { ok: boolean }[] };
  assert.equal(nm.edits[0]!.ok, false);
  // 문서 상태·다른 항목은 바뀌지 않는다 (저장은 위키 편집기에서 사람이)
  const after = (await t.store.getDoc(doc_id))!;
  assert.equal(after.lifecycle, 'IN_REVIEW');
  assert.equal(after.findings.filter((f) => (f.details as { status?: string })?.status === 'OPEN').length, 2);
});

test('항목별 확인(Fable 권고 11/18): 하나만 확인하면 그 하나만, 남으면 게시 409·모두 확인하면 201, 사유 필수, 남의 문서 403, 잠금 아닌 코드 섞이면 404·아무것도 안 씀, OCR·LOW 는 잠그지 않음', async () => {
  const t = setup();
  const r = await t.call('author', 'POST', '/v1/documents/upload-url', upload);
  const { doc_id } = (await r.json()) as { doc_id: string };
  t.objects.set(`${doc_id}/original.pdf`, { s3_version_id: 'v1', content_hash: 'h1' });
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/analyze`)).status, 202);
  const d = (await t.store.getDoc(doc_id))!;
  const F = (id: string, code: string, severity = 'MEDIUM') => ({ finding_id: id, step: 'PII_SCAN', severity, code, message: 'x', evidence_ref: 'page:3' });
  await t.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', trust_gate_result: 'REVIEW_REQUIRED', content_hash: 'sha256:h1', document_type: 'MANUAL',
    findings: [F('p1', 'PII_IMAGE_REVIEW'), F('p2', 'PII_IMAGE_REVIEW'), F('p3', 'SECRET_MASKED'), F('o1', 'OCR_LOW_CONFIDENCE'), F('l1', 'PII_IMAGE_REVIEW', 'LOW')] as never });
  const ack = (who: string, ids: string[], reason = '그림에 개인정보 없음') => t.call(who, 'POST', `/v1/documents/${doc_id}/findings/ack`, { finding_ids: ids, reason });
  assert.equal((await ack('author', ['p1'], '')).status, 422);
  assert.equal((await ack('author2', ['p1'])).status, 404); // 남의 미게시 문서는 있는지도 숨김
  assert.equal((await ack('author', ['p1', 'o1'])).status, 404);
  assert.equal((await t.store.getDoc(doc_id))!.findings.filter((f) => f.acknowledged).length, 0); // 아무것도 안 씀
  assert.equal((await ack('author', ['p1'])).status, 200);
  const one = (await t.store.getDoc(doc_id))!.findings;
  assert.deepEqual(one.filter((f) => f.acknowledged).map((f) => f.finding_id), ['p1']); // 하나만
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/submit`)).status, 409);
  assert.equal((await ack('author', ['p2', 'p3'])).status, 200);
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/submit`)).status, 201); // OCR·LOW 는 잠그지 않음
});

test('확인 필요 답 넣기 회귀(let522mj 전달 11/18): span 이 있으면 문장 끝 괄호가 아니라 그 구절 자리에, 모델이 나머지를 바꾸면 버림', async () => {
  const { fallbackAfter, keepsRest } = await import('../src/steps/clarify.ts');
  const before = '문서 관리:내용 변경 시 관련 부서 협의 후 개정 이력을 관리하며, 시행 시점과 내부 승인 절차를 확인한다.';
  assert.equal(fallbackAfter(before, '담당 부서', '관련 부서', 'IT인프라팀'), '문서 관리:내용 변경 시 IT인프라팀 협의 후 개정 이력을 관리하며, 시행 시점과 내부 승인 절차를 확인한다.');
  assert.equal(keepsRest(before, '관련 부서', '문서 관리:내용 변경 시 IT인프라팀과 협의 후 개정 이력을 관리하며, 시행 시점과 내부 승인 절차를 확인한다.'), true);
  assert.equal(keepsRest(before, '관련 부서', '내용이 바뀌면 IT인프라팀과 협의한다.'), false);
});

test('규정 충돌 그대로 사용(사용자 결정 11/18): 사유 없으면 422, 사유 있으면 잠금 해제·사유가 fixes 에 보임', async () => {
  const t = setup();
  const { doc_id } = (await (await t.call('author', 'POST', '/v1/documents/upload-url', upload)).json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', findings: [{ finding_id: 'k1', step: 'TRUST_GATE', severity: 'HIGH', code: 'KNOWHOW_CONFLICT', message: 'm', evidence_ref: 'p', location: { excerpt: '문장' } }] as never });
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/findings/k1/ack`, {})).status, 422);
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/findings/k1/ack`, { reason: '내부 예외 승인 건' })).status, 200);
  const rv = (await (await t.call('author', 'GET', `/v1/documents/${doc_id}/review`)).json()) as { fixes: { acknowledged: boolean; ack_reason: string }[] };
  assert.deepEqual([rv.fixes[0]!.acknowledged, rv.fixes[0]!.ack_reason], [true, '내부 예외 승인 건']);
});

test('위키 수정 요청(사용자 결정 11/18): 읽는 사람 요청 → AI 판단·초안 → 관리자 반영(새 버전) 또는 반려(사유 필수), 문서에 없는 구간은 422', async () => {
  const t = setup();
  const { doc_id } = (await (await t.call('author', 'POST', '/v1/documents/upload-url', upload)).json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'PUBLISHED', document_type: 'KNOWHOW', acl_groups: ['ALL'] } as never);
  t.deps.pages = async () => [{ page: 0, text: '1. 서류는 IT인프라팀이 관리한다.\n2. 기한은 30일이다.' }] as never;
  t.deps.putOriginal = async () => {};
  t.deps.judgeChange = async () => ({ verdict: 'APPROPRIATE', after: '1. 서류는 디지털운영팀이 관리한다.', reason: '부서명 변경' });
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/change-requests`, { before: '없는 문장', request: 'x' })).status, 422);
  const r = (await (await t.call('author', 'POST', `/v1/documents/${doc_id}/change-requests`, { before: '1. 서류는 IT인프라팀이 관리한다.', request: '부서가 디지털운영팀으로 바뀜' })).json()) as { id: string; verdict: string };
  assert.equal(r.verdict, 'APPROPRIATE');
  const list = (await (await t.call('approver', 'GET', '/v1/admin/change-requests')).json()) as { items: { id: string; after: string }[] };
  assert.equal(list.items[0]!.after, '1. 서류는 디지털운영팀이 관리한다.');
  assert.equal((await t.call('approver', 'POST', `/v1/admin/change-requests/${doc_id}/${r.id}`, { decision: 'REJECT' })).status, 422);
  const ap = (await (await t.call('approver', 'POST', `/v1/admin/change-requests/${doc_id}/${r.id}`, { decision: 'APPLY' })).json()) as { new_doc_id: string };
  const nv = (await t.store.getDoc(ap.new_doc_id))!;
  assert.equal(nv.previous_doc_id, doc_id); assert.equal(nv.lifecycle, 'QUARANTINED'); assert.ok(nv.review_carry, '새 버전도 이전 결정을 잇는다');
  assert.equal(((await (await t.call('approver', 'GET', '/v1/admin/change-requests')).json()) as { items: unknown[] }).items.length, 0);
});

test('위키 수정·검토 중 다시 분석은 이전 검사 결과를 저장소에서도 지운다 (11/18 dev 시험 D2: 고친 뒤에도 옛 고칠 것이 남음)', async () => {
  const t = setup();
  const { doc_id } = (await (await t.call('author', 'POST', '/v1/documents/upload-url', upload)).json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', document_type: 'KNOWHOW', findings: [{ finding_id: 'k1', step: 'KNOWHOW_VALIDATION', severity: 'HIGH', code: 'KNOWHOW_CONFLICT', message: 'm', evidence_ref: 'p' }] } as never);
  const cleared: string[] = [];
  t.store.clearFindings = async (id: string) => { cleared.push(id); };
  t.deps.putOriginal = async () => {};
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/edit`, { markdown: '고친 글' })).status, 201);
  assert.deepEqual(cleared, [doc_id]);
  t.objects.set(`${doc_id}/original.md`, { s3_version_id: 'v2', content_hash: 'h2' });
  await t.store.putDoc({ ...(await t.store.getDoc(doc_id))!, lifecycle: 'IN_REVIEW' });
  const wf0 = (await t.store.getDoc(doc_id))!.workflow_id;
  assert.equal((await t.call('author', 'POST', `/v1/documents/${doc_id}/analyze`)).status, 202);
  assert.deepEqual(cleared, [doc_id, doc_id]);
  const after = (await t.store.getDoc(doc_id))!;
  assert.notEqual(after.workflow_id, wf0, '검토 중 재분석은 새 실행 id (같은 id 는 다시 돌지 않음, prod 결함 ⑤)');
  assert.equal(after.lifecycle, 'QUARANTINED');
});

test('검토 중 문서 종류를 바꾸면 다시 검사 (11/18 prod 시험: 매뉴얼→노하우로 바꿔도 규정 비교 없이 게시 요청 가능)', async () => {
  const t = setup();
  const { doc_id } = (await (await t.call('author', 'POST', '/v1/documents/upload-url', upload)).json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', document_type: 'MANUAL', classification: { document_type: 'MANUAL', business_path: [], tags: [], confidence: 0.8, rationale: '', source: 'MODEL' } } as never);
  const r = (await (await t.call('author', 'POST', `/v1/documents/${doc_id}/classification`, { document_type: 'KNOWHOW', reason: '실무 체크리스트' })).json()) as { reanalyzed: boolean };
  assert.equal(r.reanalyzed, true);
  const n = (await t.store.getDoc(doc_id))!;
  assert.deepEqual([n.lifecycle, n.classification?.source, n.document_type], ['QUARANTINED', 'HUMAN', 'KNOWHOW']);
});

test('고칠 곳 해당 없음: 올린 사람·결재자만, 사유 필수, 상세에서 참고(LOW)로 내림 (11/19)', async () => {
  const t = setup();
  const base = { version: 1, owner: 'u-author', dept: 'd', ext: 'pdf', authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, findings: [], created_at: '', updated_at: '' };
  await t.store.putDoc({ ...base, doc_id: 'doc_K', title: '노하우', acl_groups: ['ALL'], lifecycle: 'PUBLISHED', document_type: 'KNOWHOW' });
  t.deps.pages = async () => [{ page: 1, text: '담보 서류는 기한 내 제출받는다.' }];
  t.deps.marks = async () => [{ page: 0, start: 0, end: 5, severity: 'MEDIUM', kind: 'INSUFFICIENT', reason: '조문 없음', original: '담보 서류는 기한 내 제출받는다.' } as never];
  const get = async () => ((await (await t.call('user', 'GET', '/v1/library/doc_K')).json()) as { pages: { marks: { key: string; severity: string; reason: string }[] }[] }).pages[0]!.marks[0]!;
  const key = (await get()).key;
  assert.equal(key, 'INSUFFICIENT|담보 서류는 기한 내 제출받는다.');
  assert.equal((await t.call('user', 'POST', '/v1/library/doc_K/marks/dismiss', { key, reason: '영업점 기준' })).status, 403);
  assert.equal((await t.call('author', 'POST', '/v1/library/doc_K/marks/dismiss', { key, reason: ' ' })).status, 422);
  assert.equal((await t.call('approver', 'POST', '/v1/library/doc_K/marks/dismiss', { key, reason: '영업점 기준' })).status, 200);
  const m = await get();
  assert.deepEqual([m.severity, m.reason], ['LOW', '해당 없음으로 둠: 영업점 기준']);
  assert.equal(t.store.audits.at(-1)!.action, 'MARK_DISMISSED');
});

test('관리 평가: 결재자만, 마지막 평가 실행 + 7일 거부 기록(역할·사유, sub 없음)', async () => {
  const t = setup();
  assert.equal((await t.call('user', 'GET', '/v1/admin/evaluations')).status, 403); // 이 거부도 기록된다
  const empty = (await (await t.call('approver', 'GET', '/v1/admin/evaluations')).json()) as { run_at: string | null; items: unknown[]; denials: { role: string; tool: string; reason: string }[] };
  assert.equal(empty.run_at, null);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.denials.length, 1);
  assert.deepEqual([empty.denials[0]!.role, empty.denials[0]!.tool], ['USER', 'GET /v1/admin/evaluations']);
  assert.ok(empty.denials[0]!.reason);
  assert.ok(!JSON.stringify(empty).includes('u-user'), '사용자 식별값을 내보내지 않음');
  const at = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
  await t.store.audit({ at: at(2), actor: 'system:evaluations', action: 'EVALUATION_RUN', resource: 'evaluations', result: 'OK', trace_id: 'old', detail: { items: [] } });
  const newest = at(1);
  await t.store.audit({ at: newest, actor: 'system:evaluations', action: 'EVALUATION_RUN', resource: 'evaluations', result: 'OK', trace_id: 'new',
    detail: { items: [{ key: 'forged_block_5', label: '위조 규정 차단', target: '5/5', passed: 5, total: 5, pass: true, extra: 'x' }], failures: [{ key: 'knowhow_conflict_5', case_id: 'G-KC-06', reason: '충돌 미탐지' }] } });
  await t.store.audit({ at: at(9), actor: 'u-x', action: 'POST /v1/approvals/:id/decision', resource: '/v1/approvals/a', result: 'DENIED', trace_id: 'stale' });
  const r = (await (await t.call('approver', 'GET', '/v1/admin/evaluations')).json()) as { run_at: string; items: Record<string, unknown>[]; failures: unknown[]; denials: { trace_id: string }[] };
  assert.equal(r.run_at, newest);
  assert.deepEqual(r.items, [{ key: 'forged_block_5', label: '위조 규정 차단', target: '5/5', passed: 5, total: 5, pass: true }]);
  assert.deepEqual(r.failures, [{ key: 'knowhow_conflict_5', case_id: 'G-KC-06', reason: '충돌 미탐지' }]);
  assert.ok(!r.denials.some((d) => d.trace_id === 'stale'), '7일 지난 거부는 제외');
});

test('변경 영향 수정 초안(데모 04, AI팀 계약 11/20): 서버가 영향 재확인 → 위키 수정 요청 OPEN·재검토 표시 → 반영해도 새 버전은 승인 전 미게시', async () => {
  const t = setup();
  const { doc_id } = (await (await t.call('author', 'POST', '/v1/documents/upload-url', upload)).json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'PUBLISHED', document_type: 'KNOWHOW', acl_groups: ['ALL'] } as never);
  t.deps.pages = async () => [{ page: 0, text: '1. 여신 한도는 5억 원 이하로 심사한다.\n2. 서류는 30일 보관한다.' }] as never;
  t.deps.putOriginal = async () => {};
  const ev = (span: string, kind = 'MODIFIED') => ({ cited_provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:12', evidence_span: span, change: { path: 'ARTICLE:12', kind, old_text: '한도는 5억 원', new_text: '한도는 3억 원' } });
  const tokens: string[] = [];
  t.deps.traceImpact = async (a, tok) => { tokens.push(tok); return { law_id: 'SYN-LOAN-001', old_revision: '2026-11-01', new_revision: '2027-01-01', impacted: [{ doc_id, evidence: [ev('1. 여신 한도는 5억 원 이하로 심사한다.'), ev('본문에 없는 문장입니다')] }] }; };
  await t.store.putDoc({ ...d, doc_id: 'doc_01M7MEH5136HE3JJ68AD8M0REG', law_id: 'SYN-LOAN-001', law_name: '하나은행 기업여신 심사규정', document_type: 'REGULATION', lifecycle: 'PUBLISHED' } as never);
  const seen: { old_clause: string; new_clause: string; law_name?: string }[] = [];
  t.deps.draftImpact = async (i) => { seen.push(i); return { verdict: 'APPROPRIATE', after: '1. 여신 한도는 3억 원 이하로 심사한다.', reason: '조문 한도 변경' }; };
  const body = { law: '기업여신 심사규정', doc_id };

  assert.equal((await t.call('author', 'POST', '/v1/admin/impact/draft', body)).status, 403);
  assert.equal((await t.call('approver', 'POST', '/v1/admin/impact/draft', { ...body, doc_id: 'doc_01M7MEH5136HE3JJ68AD8M0WWS' })).status, 404); // 영향 목록에 없는 문서
  const res = await t.call('approver', 'POST', '/v1/admin/impact/draft', body);
  assert.equal(res.status, 201);
  const r = (await res.json()) as { items: { id: string; before: string; after: string | null; verdict: string; ai_reason: string }[] };
  assert.equal(r.items.length, 2);
  assert.deepEqual([r.items[0]!.verdict, r.items[0]!.after], ['APPROPRIATE', '1. 여신 한도는 3억 원 이하로 심사한다.']);
  assert.deepEqual([r.items[1]!.verdict, r.items[1]!.after, r.items[1]!.ai_reason], ['UNKNOWN', null, '본문에서 근거 문장을 찾지 못했습니다']);
  assert.equal(seen.length, 1, '찾지 못한 근거는 모델을 부르지 않음');
  assert.deepEqual([seen[0]!.old_clause, seen[0]!.new_clause, seen[0]!.law_name], ['한도는 5억 원', '한도는 3억 원', '하나은행 기업여신 심사규정'], '초안 인용에 붙일 규정 이름');
  assert.equal(tokens[0], 'approver', '사용자 토큰으로 trace_impact');

  // 문서는 그대로(게시 유지) + 재검토 표시. 다시 눌러도 새로 만들지 않음
  const after1 = (await t.store.getDoc(doc_id))!;
  assert.deepEqual([after1.lifecycle, after1.freshness], ['PUBLISHED', 'REVIEW_REQUIRED']);
  // 재검토 이유 (프론트 8차): 개정 내용·인용 문장·열린 수정 제안 수. Registry 표기가 없으면 경로·개정 ID 날짜
  const fr = ((await (await t.call('user', 'GET', `/v1/library/${doc_id}`)).json()) as { freshness_reason: { effective_from: string; open_change_requests: number; changes: Record<string, string>[] } }).freshness_reason;
  assert.deepEqual([fr.effective_from, fr.open_change_requests, fr.changes.length], ['2027-01-01', 2, 2]);
  assert.deepEqual(fr.changes[0], { provision_id: 'SYN-LOAN-001@2027-01-01/ARTICLE:12', label: '제12조', kind: 'MODIFIED', old_text: '한도는 5억 원', new_text: '한도는 3억 원', cited_text: '1. 여신 한도는 5억 원 이하로 심사한다.' });
  const again = await t.call('approver', 'POST', '/v1/admin/impact/draft', body);
  assert.equal(again.status, 200);
  assert.deepEqual(((await again.json()) as { items: { id: string }[] }).items.map((x) => x.id), r.items.map((x) => x.id));

  // 결재함에 올라감 → 반영 → 새 버전은 검사 대기(QUARANTINED), 승인 전이라 일반 사용자 보관함에 없음
  const list = (await (await t.call('approver', 'GET', '/v1/admin/change-requests')).json()) as { items: { id: string; source?: string; revision?: Record<string, string> }[] };
  assert.equal(list.items.filter((x) => x.source === 'IMPACT').length, 2);
  assert.deepEqual(list.items[0]!.revision, { provision_id: 'SYN-LOAN-001@2027-01-01/ARTICLE:12', law_name: '하나은행 기업여신 심사규정', label: '제12조', kind: 'MODIFIED',
    old_text: '한도는 5억 원', new_text: '한도는 3억 원', effective_from: '2027-01-01', current_effective_from: '2026-11-01' });
  const ap = (await (await t.call('approver', 'POST', `/v1/admin/change-requests/${doc_id}/${r.items[0]!.id}`, { decision: 'APPLY' })).json()) as { new_doc_id: string };
  const nv = (await t.store.getDoc(ap.new_doc_id))!;
  assert.equal(nv.lifecycle, 'QUARANTINED');
  assert.equal((await t.store.getDoc(doc_id))!.lifecycle, 'PUBLISHED', '이전 버전은 승인 전까지 그대로');
  const lib = JSON.stringify(await (await t.call('user', 'GET', '/v1/library')).json());
  assert.ok(!lib.includes(ap.new_doc_id), '승인 전 새 버전은 일반 사용자에게 안 보임');
});

test('변경 영향 수정 초안: 모델 없음·모델이 바꾸지 않은 초안·PII 초안은 after 없이 UNKNOWN', async () => {
  const t = setup();
  const { doc_id } = (await (await t.call('author', 'POST', '/v1/documents/upload-url', upload)).json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'PUBLISHED', document_type: 'KNOWHOW', acl_groups: ['ALL'] } as never);
  t.deps.pages = async () => [{ page: 0, text: '가. 한도는 5억 원이다.\n나. 문의는 담당자에게 한다.' }] as never;
  const ev = (span: string) => ({ cited_provision_id: 'L@1/ARTICLE:1', evidence_span: span, change: { path: 'ARTICLE:1', kind: 'MODIFIED', old_text: 'a', new_text: 'b' } });
  t.deps.traceImpact = async () => ({ impacted: [{ doc_id, evidence: [ev('가. 한도는 5억 원이다.'), ev('나. 문의는 담당자에게 한다.')] }] });
  t.deps.draftImpact = async (i) => ({ verdict: 'APPROPRIATE', after: i.before.startsWith('가') ? i.before : '나. 문의는 900101-1234568 로 한다.', reason: 'x' });
  const r = (await (await t.call('approver', 'POST', '/v1/admin/impact/draft', { law: 'L', doc_id })).json()) as { items: { verdict: string; after: string | null }[] };
  assert.deepEqual(r.items.map((x) => [x.verdict, x.after]), [['UNKNOWN', null], ['UNKNOWN', null]]);
});

test('재검토 문서 변경 없이 유효(재승인 흐름): 결재자만·사유 필수·본인 문서 금지 → CURRENT, 열린 영향 초안 닫힘, 본문 그대로', async () => {
  const t = setup();
  const { doc_id } = (await (await t.call('author', 'POST', '/v1/documents/upload-url', upload)).json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'PUBLISHED', document_type: 'KNOWHOW', freshness: 'REVIEW_REQUIRED', version: 3,
    freshness_reason: { law_id: 'SYN-LOAN-001', law_name: '기업여신 심사규정', cited_revision: '2026-11-01', current_revision: '2026-12-01', effective_from: '2026-12-01', provisions: [], at: '' },
    change_requests: [{ id: 'cr_1', by: 'system:impact', at: '', before: 'b', request: 'r', verdict: 'UNKNOWN', status: 'OPEN', source: 'IMPACT' }] } as never);
  const url = `/v1/documents/${doc_id}/freshness/confirm`;
  assert.equal((await t.call('user', 'POST', url, { reason: 'x' })).status, 403);
  assert.equal((await t.call('approver', 'POST', url, {})).status, 422);
  assert.equal((await t.call('authorApprover', 'POST', url, { reason: '내 문서' })).status, 403);
  const r = await t.call('approver', 'POST', url, { reason: '제12조 개정은 이 문서의 절차와 무관' });
  assert.equal(r.status, 200);
  const after = (await t.store.getDoc(doc_id))!;
  assert.deepEqual([after.freshness, after.freshness_reason, after.version, after.lifecycle], ['CURRENT', undefined, 3, 'PUBLISHED']);
  assert.deepEqual([after.freshness_confirmed![0]!.law_id, after.freshness_confirmed![0]!.revision], ['SYN-LOAN-001', '2026-12-01']);
  assert.equal(after.change_requests![0]!.status, 'REJECTED');
  assert.equal((await t.call('approver', 'POST', url, { reason: '두 번' })).status, 409);
  assert.ok(t.store.audits.some((e) => e.action === 'FRESHNESS_CONFIRMED' && e.resource === doc_id));
});

test('외부 법령 참고(총괄 지시 11/20): 법령당 1건, 인용 조문 전부(조·항 단위, 호는 sub), 첫 조문 clause·result 하위 호환', async () => {
  const t = setup();
  const { doc_id } = (await (await t.call('author', 'POST', '/v1/documents/upload-url', upload)).json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'PUBLISHED', document_type: 'MANUAL', acl_groups: ['ALL'] } as never);
  t.deps.pages = async () => [{ page: 0, text: '본문' }] as never;
  const L = '외국환거래규정';
  // M-002·M-003 (tests/fixtures/documents, 데이터팀 PR #75) 본문 인용을 externalLawRefs(조문마다 1건) + 모델 보조가 낸 모양
  let refs = [{ law_name: L, clause: '제9-5조제1항' }, { law_name: L, clause: '제9-5조제2항' }, { law_name: L, clause: '제9-5조제3항' }, { law_name: L, clause: '제9-5조제1항' }, { law_name: L }];
  t.deps.externalLaws = async () => refs;
  const calls: string[] = [];
  t.deps.officialLaw = async (a) => { calls.push(`${a.law_name}|${a.clause ?? ''}`); if (a.clause === '제9-5조제3항') throw Object.assign(new Error('x'), { name: 'PageNotReady' }); return { text: a.clause }; };
  type R = { items: { law_name: string; clause?: string; result: unknown; clauses: { clause: string; sub?: string[]; result: unknown; error?: string }[] }[] };
  const m2 = (await (await t.call('user', 'GET', `/v1/library/${doc_id}/external-laws`)).json()) as R;
  assert.equal(m2.items.length, 1);
  assert.deepEqual(m2.items[0]!.clauses.map((x) => x.clause), ['제9-5조제1항', '제9-5조제2항', '제9-5조제3항']);
  assert.deepEqual([m2.items[0]!.clause, m2.items[0]!.result], ['제9-5조제1항', { text: '제9-5조제1항' }]);
  assert.equal(m2.items[0]!.clauses[2]!.error, 'PageNotReady');
  assert.equal(calls.length, 3, '조·항마다 1번');

  refs = [{ law_name: L, clause: '제9-9조제1항' }, { law_name: L, clause: '제9-4조제1항' }, { law_name: L, clause: '제9-9조제1항제8호·제9호' }];
  const m3 = (await (await t.call('user', 'GET', `/v1/library/${doc_id}/external-laws`)).json()) as R;
  assert.deepEqual(m3.items[0]!.clauses.map((x) => [x.clause, x.sub]), [['제9-9조제1항', ['제8호', '제9호']], ['제9-4조제1항', undefined]]);

  refs = [{ law_name: '전자금융거래법' }];
  const none = (await (await t.call('user', 'GET', `/v1/library/${doc_id}/external-laws`)).json()) as R;
  assert.deepEqual([none.items[0]!.clause, none.items[0]!.clauses], [undefined, []]);
  assert.ok(none.items[0]!.result, '조문 없는 법령도 법령 단위로 조회');
});

test('확인 필요(checks): 외부 법령·근거 조문과 다름은 잠그지 않고, 작성자 검토·승인자 결재함 모두에 보인다 (MX-002 11/20)', async () => {
  const t = setup();
  const { doc_id, approval_id } = await submitted(t);
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, findings: [{ finding_id: 'x1', step: 'KNOWHOW_VALIDATION', severity: 'MEDIUM', code: 'KNOWHOW_EXTERNAL_MISMATCH', message: 'm', user_message: '외부 법령과 다름', evidence_ref: 'ext', fix_hint: '30일 이내로 고치세요', location: { excerpt: '60일 이내 신고' } }] as never });
  const rv = (await (await t.call('author', 'GET', `/v1/documents/${doc_id}/review`)).json()) as { fixes: unknown[]; checks: { code: string; excerpt: string; fix_hint: string }[] };
  assert.deepEqual(rv.fixes, []);
  assert.deepEqual(rv.checks.map((c) => [c.code, c.excerpt, c.fix_hint]), [['KNOWHOW_EXTERNAL_MISMATCH', '60일 이내 신고', '30일 이내로 고치세요']]);
  const ap = (await (await t.call('approver', 'GET', '/v1/approvals')).json()) as { items: { approval_id: string; checks_count: number; checks: { text: string }[] }[] };
  const card = ap.items.find((i) => i.approval_id === approval_id)!;
  assert.equal(card.checks_count, 1);
  assert.equal(card.checks[0]!.text, '60일 이내 신고');
});

test('검증 정보: 매뉴얼도 외부 법령 대조 결과가 있으면 그 사실·다른 문장을 보인다 (MX-002 11/20)', async () => {
  const { verification } = await import('../src/library.ts');
  const v = verification({ document_type: 'MANUAL', findings: [{ finding_id: 'x', step: 'KNOWHOW_VALIDATION', severity: 'MEDIUM', code: 'KNOWHOW_EXTERNAL_MISMATCH', message: 'm', user_message: '제9-5조 원문과 다릅니다', evidence_ref: 'EXT:x', location: { excerpt: '60일 이내 신고' } }] } as never);
  assert.match(v.method, /외부 법령/);
  assert.deepEqual(v.basis.map((b) => [b.result, b.statement]), [['외부 법령과 다름(확인 필요)', '60일 이내 신고']]);
  assert.match(verification({ document_type: 'MANUAL', findings: [] } as never).method, /규정 대조 대상이 아닌/);
});

test('문서보관함 상세(승인자): 작성자가 그대로 사용한 사유가 review.findings 에 ack_reason 으로 (엔드유저 11/20)', async () => {
  const t = setup();
  const { doc_id } = await submitted(t);
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, findings: [{ finding_id: 'k1', step: 'KNOWHOW_VALIDATION', severity: 'HIGH', code: 'KNOWHOW_CONFLICT', message: 'm', evidence_ref: 'p', acknowledged: { by: 'author', at: 't', reason: '본부 예외 승인' } }] as never });
  const r = (await (await t.call('approver', 'GET', `/v1/library/${doc_id}`)).json()) as { review: { findings: { ack_reason?: string }[] } };
  assert.equal(r.review.findings[0]!.ack_reason, '본부 예외 승인');
});

test('평점(인기): 목록·상세에 rating{avg,count}·useful_count·내 별점, 별점 없으면 rating 생략 (P1 11/20)', async () => {
  const t = setup();
  const { doc_id } = (await (await t.call('author', 'POST', '/v1/documents/upload-url', upload)).json()) as { doc_id: string };
  const d = (await t.store.getDoc(doc_id))!;
  await t.store.putDoc({ ...d, lifecycle: 'PUBLISHED', document_type: 'KNOWHOW', acl_groups: ['ALL'] } as never);
  assert.equal(((await (await t.call('user', 'GET', '/v1/library')).json()) as { items: { rating?: unknown }[] }).items[0]!.rating, undefined);
  assert.equal((await t.call('user', 'POST', '/v1/feedback', { doc_id, stars: 5, useful: true })).status, 200);
  assert.equal((await t.call('author', 'POST', '/v1/feedback', { doc_id, stars: 4, useful: false })).status, 200);
  const it = ((await (await t.call('user', 'GET', '/v1/library')).json()) as { items: { rating: { avg: number; count: number }; useful_count: number }[] }).items[0]!;
  assert.deepEqual([it.rating, it.useful_count], [{ avg: 4.5, count: 2 }, 1]);
  const det = (await (await t.call('user', 'GET', `/v1/library/${doc_id}`)).json()) as { my_stars: number; rating: { count: number } };
  assert.deepEqual([det.my_stars, det.rating.count], [5, 2]);
});

test('평가 화면 denials: Gateway Policy 거부도 API 거부와 함께 시간순, 로그 읽기 실패해도 API 거부는 보임 (P1 11/20)', async () => {
  const t = setup();
  assert.equal((await t.call('user', 'GET', '/v1/admin/evaluations')).status, 403);
  t.deps.gatewayDenials = async () => [{ at: '2099-01-01T00:00:00.000Z', role: 'USER', tool: 'probe___publish_wiki_probe', reason: 'Policy evaluation denied', trace_id: 'tr-1' }];
  const app = (await import('../src/app.ts')).createApp(t.deps);
  const get = async () => (await (await app.request('/v1/admin/evaluations', { headers: { authorization: 'Bearer approver' } })).json()) as { denials: { tool: string; source: string }[] };
  const r = await get();
  assert.deepEqual(r.denials.map((d) => [d.source, d.tool]), [['GATEWAY', 'probe___publish_wiki_probe'], ['API', 'GET /v1/admin/evaluations']]);
  t.deps.gatewayDenials = async () => { throw new Error('AccessDenied'); };
  assert.deepEqual((await get()).denials.map((d) => d.source), ['API']);
});

test('반려 사유: 작성자 review·문서보관함 상세에 rejection_reason(개인정보 가림), 결재함 검토 대기에 source_mismatch (엔드유저·프론트 11/20)', async () => {
  const t = setup();
  const { doc_id, approval_id } = await submitted(t);
  assert.equal((await t.call('approver', 'POST', `/v1/approvals/${approval_id}/decision`, { decision: 'REJECT', reason: '근거 조문 확인 필요 900101-1234568' })).status, 200);
  const rv = (await (await t.call('author', 'GET', `/v1/documents/${doc_id}/review`)).json()) as { rejection_reason: string };
  assert.match(rv.rejection_reason, /^근거 조문 확인 필요/);
  assert.ok(!rv.rejection_reason.includes('1234568'), '개인정보 가림');
  const lib = (await (await t.call('author', 'GET', `/v1/library/${doc_id}`)).json()) as { rejection_reason: string };
  assert.equal(lib.rejection_reason, rv.rejection_reason);
  const { doc_id: d2 } = (await (await t.call('author', 'POST', '/v1/documents/upload-url', upload)).json()) as { doc_id: string };
  const x = (await t.store.getDoc(d2))!;
  await t.store.putDoc({ ...x, lifecycle: 'IN_REVIEW', findings: [{ finding_id: 'r1', step: 'TRUST_GATE', severity: 'HIGH', code: 'REGISTRY_MISMATCH', message: 'm', evidence_ref: 'e' }] } as never);
  const ir = (await (await t.call('approver', 'GET', '/v1/admin/in-review')).json()) as { items: { doc_id: string; source_mismatch: boolean }[] };
  assert.equal(ir.items.find((i) => i.doc_id === d2)!.source_mismatch, true);
});
