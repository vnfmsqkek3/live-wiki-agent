import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { ulid } from 'ulid';
import type { z } from 'zod';
import { canRead, hasRole, type VerifyToken } from './auth.ts';
import {
  ALLOWED_EXT, ClassificationBody, DecisionBody, FeedbackBody, GuideBody, UploadUrlBody, newId,
  type Actor, type ApprovalRecord, type DocumentRecord, type Role,
} from './contracts.ts';
import { ApiError } from './errors.ts';
import type { Store } from './store.ts';
import { submitForApproval } from './submit.ts';

export interface Deps {
  /** 브라우저 허용 출처 (CORS). 와일드카드 금지 (운영 교훈 #3) */
  webOrigins?: string[];
  verify: VerifyToken;
  store: Store;
  /** quarantine/{doc_id}/original.{ext} PUT presigned URL (SigV4, 리전 엔드포인트) */
  presignPut(key: string, contentLength: number): Promise<string>;
  /** 현재 S3 객체의 버전·해시 (승인 바인딩 검증용) */
  headObject(key: string): Promise<{ s3_version_id: string; content_hash: string } | undefined>;
  /** 실행 이름=workflow_id, 입력은 문서로만 결정 → 업로드 이벤트(type-detection)와 analyze가 같은 실행으로 수렴 (멱등) */
  startWorkflow(doc: DocumentRecord): Promise<void>;
  /** WaitForApproval 재개: 결정과 무관하게 SendTaskSuccess({decision}) (interfaces.md 6장). APPROVE만 Promote로 진행 */
  sendDecision(taskToken: string, decision: 'APPROVE' | 'REJECT' | 'REVALIDATE'): Promise<void>;
  /** let522mj search Tool과 같은 계약. ACL 필터는 서버가 actor로 만든다 */
  search(q: string, actor: Actor, opts: { tags: string[]; as_of?: string }): Promise<unknown[]>;
  /** 검색·가이드 Agent 호출. 사용자 access token을 그대로 전달 (interfaces.md 9장) */
  guide(question: string, accessToken: string): Promise<unknown>;
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
    const doc = { ...d, s3_version_id: head.s3_version_id, content_hash: head.content_hash, updated_at: new Date().toISOString() };
    await store.putDoc(doc);
    await deps.startWorkflow(doc);
    await audit(c, 'ANALYZE', d.doc_id);
    return c.json({ workflow_id: d.workflow_id }, 202);
  });

  app.get('/v1/documents/:id', async (c) => {
    const d = await loadDoc(c, c.req.param('id'));
    return c.json({ ...d, task_token: undefined, findings: undefined }); // JSON에서 빠짐
  });

  app.get('/v1/documents/:id/review', async (c) => {
    const a = need(c, ['AUTHOR', ...APPROVERS]);
    const d = await loadDoc(c, c.req.param('id'));
    if (hasRole(a, ['AUTHOR']) && !hasRole(a, APPROVERS) && d.owner !== a.sub) throw new ApiError('NOT_FOUND', 'document not found');
    return c.json({ doc_id: d.doc_id, lifecycle: d.lifecycle, trust_gate_result: d.trust_gate_result, authority_status: d.authority_status, classification: d.classification, findings: d.findings });
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
      classification_history: [...(d.classification_history ?? []), { at, by: a.sub, from: prev?.document_type, to: b.document_type, reason: b.reason }],
      updated_at: at,
    });
    await audit(c, 'CLASSIFY_EDIT', d.doc_id);
    return c.json({ document_type: b.document_type });
  });

  // ---- 승인 (사람만) ----
  app.get('/v1/approvals', async (c) => {
    need(c, APPROVERS);
    const status = (c.req.query('status') ?? 'PENDING') as ApprovalRecord['status'];
    const items = (await store.listApprovals(status)).map((r) => ({ ...r, task_token: undefined }));
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
    const bind = status === 'APPROVED' ? head : { s3_version_id: apr.s3_version_id, content_hash: apr.content_hash };
    const decided = await store.decideApproval(apr.approval_id, { status, approver_sub: a.sub, reason: b.reason, ...bind });
    const now = new Date().toISOString();
    if (b.decision === 'REVALIDATE') await store.putDoc({ ...d, lifecycle: 'IN_REVIEW', freshness: 'REVIEW_REQUIRED', updated_at: now });
    else if (status === 'REJECTED') await store.putDoc({ ...d, lifecycle: 'BLOCKED', authority_status: 'REJECTED', updated_at: now });
    if (apr.task_token)
      await deps.sendDecision(apr.task_token, b.decision);
    await audit(c, `DECISION_${b.decision}`, apr.approval_id);
    return c.json({ approval_id: decided.approval_id, status: decided.status });
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
