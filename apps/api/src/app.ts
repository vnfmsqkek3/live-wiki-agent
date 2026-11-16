import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { ulid } from 'ulid';
import type { z } from 'zod';
import { canRead, hasRole, type VerifyToken } from './auth.ts';
import { card, matches, type Mark, type Page } from './library.ts';
import { progress } from './progress.ts';
import {
  ALLOWED_EXT, ClassificationBody, DecisionBody, FeedbackBody, GuideBody, SourceReviewBody, UploadUrlBody, newId,
  type Actor, type ApprovalRecord, type DocumentRecord, type Role,
} from './contracts.ts';
import { ApiError } from './errors.ts';
import type { Store } from './store.ts';
import { hasSourceMismatch, submitForApproval } from './submit.ts';

export interface Deps {
  /** 브라우저 허용 출처 (CORS). 와일드카드 금지 (운영 교훈 #3) */
  webOrigins?: string[];
  verify: VerifyToken;
  store: Store;
  /** quarantine/{doc_id}/original.{ext} PUT presigned URL (SigV4, 리전 엔드포인트) */
  presignPut(key: string, contentLength: number): Promise<string>;
  /** 현재 S3 객체의 버전·해시 (승인 바인딩 검증용) */
  headObject(key: string): Promise<{ s3_version_id: string } | undefined>;
  /** 실행 이름=workflow_id, 입력은 문서로만 결정 → 업로드 이벤트(type-detection)와 analyze가 같은 실행으로 수렴 (멱등) */
  startWorkflow(doc: DocumentRecord): Promise<void>;
  /** 사람 결정 후 워크플로 재개 (AgentCore 오케스트레이터 resume). 재개했으면 true. APPROVE만 게시 단계로 진행 */
  resume(doc: DocumentRecord, decision: 'APPROVE' | 'REJECT' | 'REVALIDATE'): Promise<boolean>;
  /** let522mj search Tool과 같은 계약. ACL 필터는 서버가 actor로 만든다 */
  search(q: string, actor: Actor, opts: { tags: string[]; as_of?: string }): Promise<unknown[]>;
  /** 검색·가이드 Agent 호출. 사용자 access token을 그대로 전달 (interfaces.md 9장) */
  guide(question: string, accessToken: string): Promise<unknown>;
  /** 가이드 SSE (progress·result·error 이벤트). 없으면 JSON 응답만 */
  guideStream?(question: string, accessToken: string): Promise<ReadableStream<Uint8Array>>;
  /** 워크플로 실패 기록 (yoyo0704 WORKFLOWS `WF#{id}`: EXECUTION·STEP#*). 실패 시 문서가 QUARANTINED로 멈춘 것처럼 보이지 않게 노출 */
  workflowFailure?(workflow_id: string): Promise<{ step: string; error: string } | undefined>;
  /** 업로드 진행바: WORKFLOWS 단계 기록 */
  workflowSteps?(workflow_id: string): Promise<{ step: string; status: string; ended_at: string; error?: string }[]>;
  /** 문서보관함: 마스킹본 페이지 (`{doc_id}/masked/segments/`). 원본은 읽지 않는다 */
  pages?(doc_id: string): Promise<Page[]>;
  /** let522mj buildMarks: 판정·Finding → 밑줄 (page = pages 배열 인덱스, 못 찾으면 null) */
  marks?(pages: Page[], doc: DocumentRecord): Promise<Mark[]>;
}

type Env = { Variables: { actor: Actor; trace_id: string; token: string } };

const APPROVERS: Role[] = ['REG_APPROVER', 'SECURITY_REVIEWER'];
const quarantineKey = (d: Pick<DocumentRecord, 'doc_id' | 'ext'>) => `${d.doc_id}/original.${d.ext}`;

export function createApp(deps: Deps) {
  const app = new Hono<Env>();
  const { store } = deps;

  app.onError(async (err, c) => {
    const trace_id = c.get('trace_id') ?? ulid();
    const e = err instanceof ApiError ? err : new ApiError('INTERNAL', 'internal error');
    if (!(err instanceof ApiError)) console.error(JSON.stringify({ trace_id, err: String(err?.name) })); // 메시지에 원문이 섞일 수 있어 이름만
    if (e.status === 403 && c.get('actor'))
      await store.audit({ at: new Date().toISOString(), actor: c.get('actor').sub, action: `${c.req.method} ${c.req.routePath}`, resource: c.req.path, result: 'DENIED', trace_id });
    return c.json({ error: { code: e.code, message: e.message, trace_id } }, e.status);
  });

  if (deps.webOrigins?.length)
    app.use('/v1/*', cors({ origin: deps.webOrigins, allowHeaders: ['authorization', 'content-type'], allowMethods: ['GET', 'POST'], maxAge: 600 }));

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.use('/v1/*', async (c, next) => {
    c.set('trace_id', ulid());
    const h = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(\S+)$/.exec(h);
    if (!m) throw new ApiError('UNAUTHORIZED', 'missing bearer token');
    c.set('actor', await deps.verify(m[1]!));
    c.set('token', m[1]!);
    await next();
  });

  const need = (c: Context<Env>, roles: readonly Role[]) => {
    if (!hasRole(c.get('actor'), roles)) throw new ApiError('FORBIDDEN', 'role not allowed');
    return c.get('actor');
  };
  const body = async <T extends z.ZodType>(c: Context<Env>, schema: T): Promise<z.infer<T>> => {
    const r = schema.safeParse(await c.req.json().catch(() => undefined));
    if (!r.success) throw new ApiError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return r.data;
  };
  const audit = (c: Context<Env>, action: string, resource: string) =>
    store.audit({ at: new Date().toISOString(), actor: c.get('actor').sub, action, resource, result: 'OK', trace_id: c.get('trace_id') });
  const loadDoc = async (c: Context<Env>, id: string) => {
    const d = await store.getDoc(id);
    // 존재 여부 노출 방지: 권한 없음도 404
    const a = c.get('actor');
    if (!d || !(d.owner === a.sub || hasRole(a, APPROVERS) || (d.lifecycle === 'PUBLISHED' && canRead(a, d.acl_groups))))
      throw new ApiError('NOT_FOUND', 'document not found');
    return d;
  };

  // ---- 문서 ----
  app.post('/v1/documents/upload-url', async (c) => {
    const a = need(c, ['AUTHOR']);
    const b = await body(c, UploadUrlBody);
    const ext = b.filename.split('.').pop()!.toLowerCase();
    if (!b.filename.includes('.') || !(ALLOWED_EXT as readonly string[]).includes(ext))
      throw new ApiError('VALIDATION', `허용 형식: ${ALLOWED_EXT.join(', ')}`);
    const now = new Date().toISOString();
    const doc: DocumentRecord = {
      doc_id: newId.doc(), version: 1, owner: a.sub, title: b.title, dept: b.dept, acl_groups: b.acl_groups,
      ext: ext === 'jpeg' ? 'jpg' : ext, lifecycle: 'QUARANTINED', authority_status: 'UNVERIFIED', freshness: 'CURRENT',
      workflow_id: newId.wf(), findings: [], created_at: now, updated_at: now,
    };
    await store.putDoc(doc);
    const url = await deps.presignPut(quarantineKey(doc), b.size);
    await audit(c, 'UPLOAD_URL', doc.doc_id);
    return c.json({ doc_id: doc.doc_id, url }, 201);
  });

  app.post('/v1/documents/:id/analyze', async (c) => {
    const a = need(c, ['AUTHOR']);
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub) throw new ApiError('FORBIDDEN', 'not the owner');
    const head = await deps.headObject(quarantineKey(d));
    if (!head) throw new ApiError('CONFLICT', 'file not uploaded');
    // 이미 고정된 검사 버전이 있으면 바꾸지 않는다 (type-detection이 검사한 버전과 다른 버전이 끼어드는 것 방지)
    const doc = { ...d, s3_version_id: d.s3_version_id ?? head.s3_version_id, updated_at: new Date().toISOString() };
    await store.putDoc(doc);
    await deps.startWorkflow(doc);
    await audit(c, 'ANALYZE', d.doc_id);
    return c.json({ workflow_id: d.workflow_id }, 202);
  });

  app.get('/v1/documents/:id', async (c) => {
    const d = await loadDoc(c, c.req.param('id'));
    const failure = d.workflow_id && d.lifecycle === 'QUARANTINED' && deps.workflowFailure ? await deps.workflowFailure(d.workflow_id) : undefined;
    return c.json({ ...d, task_token: undefined, findings: undefined, workflow_failure: failure }); // 이전 SFN 문서에 남은 task_token은 숨김
  });

  app.get('/v1/documents/:id/review', async (c) => {
    const a = need(c, ['AUTHOR', ...APPROVERS]);
    const d = await loadDoc(c, c.req.param('id'));
    if (hasRole(a, ['AUTHOR']) && !hasRole(a, APPROVERS) && d.owner !== a.sub) throw new ApiError('NOT_FOUND', 'document not found');
    const workflow_failure = d.workflow_id && d.lifecycle === 'QUARANTINED' && deps.workflowFailure ? await deps.workflowFailure(d.workflow_id) : undefined;
    return c.json({ workflow_failure, doc_id: d.doc_id, title: d.title, lifecycle: d.lifecycle, trust_gate_result: d.trust_gate_result, authority_status: d.authority_status, freshness: d.freshness, classification: d.classification, findings: d.findings, knowhow_validation: d.knowhow_validation });
  });

  app.get('/v1/documents/:id/progress', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub && !hasRole(a, APPROVERS)) throw new ApiError('NOT_FOUND', 'document not found');
    const rec = d.workflow_id && deps.workflowSteps ? await deps.workflowSteps(d.workflow_id) : [];
    return c.json(progress(d.lifecycle, rec));
  });

  app.post('/v1/documents/:id/submit', async (c) => {
    const a = need(c, ['AUTHOR']);
    const d = await loadDoc(c, c.req.param('id'));
    const apr = await submitForApproval(store, d, a.sub);
    await audit(c, 'SUBMIT', d.doc_id);
    return c.json({ approval_id: apr.approval_id }, 201);
  });

  app.post('/v1/documents/:id/classification', async (c) => {
    const a = need(c, ['AUTHOR']);
    const b = await body(c, ClassificationBody);
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub) throw new ApiError('FORBIDDEN', 'not the owner');
    if (d.lifecycle !== 'IN_REVIEW') throw new ApiError('CONFLICT', `cannot edit in ${d.lifecycle}`);
    const at = new Date().toISOString();
    const prev = d.classification;
    await store.putDoc({
      ...d,
      classification: { business_path: [], tags: [], rationale: '', ...prev, document_type: b.document_type, confidence: 1, source: 'HUMAN' },
      document_type: b.document_type, // Promote가 읽는 최상위 필드도 함께
      classification_history: [...(d.classification_history ?? []), { at, by: a.sub, from: prev?.document_type, to: b.document_type, reason: b.reason }],
      updated_at: at,
    });
    await audit(c, 'CLASSIFY_EDIT', d.doc_id);
    return c.json({ document_type: b.document_type });
  });

  // ---- 출처 불일치 (위조 의심) 처리: 승인 대상이 아니므로 별도 큐 ----
  app.get('/v1/review-queue', async (c) => {
    need(c, APPROVERS);
    const items = (await store.listDocs())
      .filter((d) => d.lifecycle === 'IN_REVIEW' && hasSourceMismatch(d) && !d.source_review)
      .map((d) => ({ doc_id: d.doc_id, title: d.title, dept: d.dept, kind: 'SOURCE_MISMATCH', findings: d.findings.filter((f) => f.code === 'REGISTRY_MISMATCH') }));
    return c.json({ items });
  });

  app.post('/v1/documents/:id/source-review', async (c) => {
    const a = need(c, APPROVERS);
    const b = await body(c, SourceReviewBody);
    const d = await loadDoc(c, c.req.param('id'));
    if (!hasSourceMismatch(d) || d.source_review) throw new ApiError('CONFLICT', 'no pending source mismatch');
    const at = new Date().toISOString();
    await store.putDoc({ ...d, lifecycle: 'BLOCKED', authority_status: 'REJECTED', source_review: { decision: b.decision, by: a.sub, reason: b.reason, at }, updated_at: at });
    await audit(c, 'SOURCE_REVIEW_REJECT', d.doc_id);
    let workflow_resumed = false;
    try { workflow_resumed = await deps.resume(d, 'REJECT'); } catch { await audit(c, 'WORKFLOW_RESUME_FAILED', d.doc_id); }
    return c.json({ doc_id: d.doc_id, lifecycle: 'BLOCKED', workflow_resumed });
  });

  // ---- 승인 (사람만) ----
  app.get('/v1/approvals', async (c) => {
    need(c, APPROVERS);
    const status = (c.req.query('status') ?? 'PENDING') as ApprovalRecord['status'];
    const items = (await store.listApprovals(status)).map((r) => ({ ...r, task_token: undefined })); // 이전 레코드에 남은 값 숨김
    return c.json({ items });
  });

  app.post('/v1/approvals/:id/decision', async (c) => {
    const a = need(c, ['REG_APPROVER']);
    const b = await body(c, DecisionBody);
    const apr = await store.getApproval(c.req.param('id'));
    if (!apr) throw new ApiError('NOT_FOUND', 'approval not found');
    const d = await store.getDoc(apr.doc_id);
    if (!d) throw new ApiError('NOT_FOUND', 'document not found');
    // 승인 시점의 실제 객체를 다시 읽어 바인딩 검증 (검사 후 변경 차단)
    const head = await deps.headObject(quarantineKey(d));
    if (!head) throw new ApiError('CONFLICT', 'object missing');
    const status = b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    // 반려·재검증은 변경된 객체에도 가능해야 하므로 바인딩 검증은 APPROVE에만 적용
    // 버전 ID는 불변 → 현재 객체 버전이 게시 요청 때와 같아야 승인. 해시는 Promote가 바이트로 재검증한다
    const bind = { s3_version_id: status === 'APPROVED' ? head.s3_version_id : apr.s3_version_id, content_hash: apr.content_hash };
    const decided = await store.decideApproval(apr.approval_id, { status, approver_sub: a.sub, reason: b.reason, ...bind });
    const now = new Date().toISOString();
    if (b.decision === 'REVALIDATE') await store.putDoc({ ...d, lifecycle: 'IN_REVIEW', freshness: 'REVIEW_REQUIRED', updated_at: now });
    else if (status === 'REJECTED') await store.putDoc({ ...d, lifecycle: 'BLOCKED', authority_status: 'REJECTED', updated_at: now });
    await audit(c, `DECISION_${b.decision}`, apr.approval_id);
    // 결정은 위 조건부 쓰기로 이미 확정. 워크플로 재개 실패가 결정을 되돌리지 않도록 분리해 알린다
    let workflow_resumed = false;
    try { workflow_resumed = await deps.resume(d, b.decision); }
    catch (e) {
      console.error(JSON.stringify({ trace_id: c.get('trace_id'), err: String((e as Error)?.name) }));
      await audit(c, 'WORKFLOW_RESUME_FAILED', apr.approval_id); // ponytail: 재시도 API 없음, 운영자가 재호출
    }
    return c.json({ approval_id: decided.approval_id, status: decided.status, workflow_resumed });
  });

  // ---- 문서보관함 (권한 내 PUBLISHED + 본인 문서) ----
  const visibleDocs = async (a: Actor) => (await store.listDocs()).filter((d) => d.owner === a.sub || (d.lifecycle === 'PUBLISHED' && canRead(a, d.acl_groups)));
  app.get('/v1/library', async (c) => {
    const vis = await visibleDocs(c.get('actor'));
    const f = { type: c.req.query('type'), business: c.req.query('business'), tag: c.req.query('tag'), q: c.req.query('q')?.slice(0, 200) };
    const items = vis.filter((d) => d.lifecycle !== 'BLOCKED' && matches(d, f)).sort((x, y) => y.updated_at.localeCompare(x.updated_at)).map((d) => card(d, vis));
    return c.json({ items });
  });
  app.get('/v1/library/:id', async (c) => {
    const a = c.get('actor');
    const vis = await visibleDocs(a);
    const d = vis.find((x) => x.doc_id === c.req.param('id'));
    if (!d) throw new ApiError('NOT_FOUND', 'document not found'); // 권한 없음도 404
    const pages = deps.pages ? (await deps.pages(d.doc_id).catch(() => [])).sort((x, y) => x.page - y.page) : [];
    const marks = deps.marks && pages.length ? await deps.marks(pages, d) : [];
    const sum = new Map((d.page_summaries ?? []).map((p) => [p.page, p.summary]));
    return c.json({
      ...card(d, vis),
      doc_marks: marks.filter((m) => m.page === null), // 위치를 못 찾은 항목 (예: 공식 원본에서 빠진 조문) → 상단에 모아 표시
      pages: pages.map((p, i) => ({ page: p.page, text: p.text, summary: sum.get(p.page) ?? null, marks: marks.filter((m) => m.page === i) })),
    });
  });

  // ---- 검색·피드백 ----
  app.get('/v1/search', async (c) => {
    const a = c.get('actor');
    const q = (c.req.query('q') ?? '').trim();
    if (!q || q.length > 500) throw new ApiError('VALIDATION', 'q: 1~500자');
    const tags = (c.req.query('tags') ?? '').split(',').filter(Boolean);
    const as_of = c.req.query('as_of');
    if (as_of && !/^\d{4}-\d{2}-\d{2}$/.test(as_of)) throw new ApiError('VALIDATION', 'as_of: YYYY-MM-DD');
    return c.json({ items: await deps.search(q, a, { tags, as_of }) });
  });

  app.post('/v1/guides', async (c) => {
    const b = await body(c, GuideBody);
    if (deps.guideStream && (c.req.header('accept') ?? '').includes('text/event-stream')) {
      const stream = await deps.guideStream(b.question, c.get('token'));
      await audit(c, 'GUIDE', 'agent');
      // x-accel-buffering: 중간 프록시 버퍼링 방지 (CloudFront·ALB 통과는 yoyo0704)
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } });
    }
    const r = await deps.guide(b.question, c.get('token'));
    await audit(c, 'GUIDE', 'agent'); // 질의 원문은 감사 기록에 남기지 않는다
    return c.json(r);
  });

  app.post('/v1/feedback', async (c) => {
    const a = c.get('actor');
    const b = await body(c, FeedbackBody);
    await loadDoc(c, b.doc_id);
    await store.putFeedback({ ...b, user_sub: a.sub, updated_at: new Date().toISOString() });
    return c.json({ ok: true });
  });

  return app;
}
