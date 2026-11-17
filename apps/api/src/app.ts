import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { ulid } from 'ulid';
import type { z } from 'zod';
import { canRead, hasRole, type VerifyToken } from './auth.ts';
import { diffDocuments, previousVersionCandidates, similarity } from '@hanaeum/legal-parser';
import { card, detailFilter, docDatesOf, groupSeries, orderVersions, representative, seriesKey, keywordItem, matches, similar, verification, type Mark, type Page, clauseGroups } from './library.ts';
import { blockedReasons, issues, plainMessage, progress } from './progress.ts';
import { groupByDoc } from './search.ts';
import {
  ALLOWED_EXT, CategoryMergeBody, CategoryRenameBody, ClassificationBody, EditBody, DecisionBody, DeleteBody, FeedbackBody, PreviousBody, TitleBody, GuideBody, SourceReviewBody, UploadUrlBody, newId,
  type Actor, type ApprovalRecord, type DocumentRecord, type Finding, type Role,
} from './contracts.ts';
import { ApiError } from './errors.ts';
import type { Store } from './store.ts';
import { FIX_CODES, hasSourceMismatch, submitForApproval } from './submit.ts';

export interface Deps {
  /** 브라우저 허용 출처 (CORS). 와일드카드 금지 (운영 교훈 #3) */
  webOrigins?: string[];
  verify: VerifyToken;
  store: Store;
  /** quarantine/{doc_id}/original.{ext} PUT presigned URL (SigV4, 리전 엔드포인트) */
  presignPut(key: string, contentLength: number): Promise<string>;
  /** 위키 수정본 원문 저장 ({doc_id}/original.md). S3 이벤트로 형식 검사·분석이 시작된다 (업로드와 같은 길) */
  putOriginal?(key: string, body: Uint8Array): Promise<void>;
  /** 현재 S3 객체의 버전·해시 (승인 바인딩 검증용) */
  headObject(key: string): Promise<{ s3_version_id: string } | undefined>;
  /** 실행 이름=workflow_id, 입력은 문서로만 결정 → 업로드 이벤트(type-detection)와 analyze가 같은 실행으로 수렴 (멱등) */
  startWorkflow(doc: DocumentRecord): Promise<void>;
  /** 사람 결정 후 워크플로 재개 (AgentCore 오케스트레이터 resume). 재개했으면 true. APPROVE만 게시 단계로 진행 */
  resume(doc: DocumentRecord, decision: 'APPROVE' | 'REJECT' | 'REVALIDATE'): Promise<boolean>;
  /** 원본 내려받기 presigned GET (quarantine original, 승인된 s3 버전) */
  presignGet?(key: string, versionId: string | undefined, filename: string): Promise<string>;
  /** 사용자 삭제 정리 실행 (오케스트레이터 action=delete). 없으면 DELETED 표시만 */
  deleteWorkflow?(doc: DocumentRecord): Promise<void>;
  /** let522mj search Tool과 같은 계약. ACL 필터는 서버가 actor로 만든다 */
  search(q: string, actor: Actor, opts: { tags: string[]; as_of?: string; index_groups?: string[]; rewrite?: boolean } & import('./library.ts').DetailFilter): Promise<unknown[] & { rewritten?: import('./search.ts').Rewritten }>;
  /** 검색·가이드 Agent 호출. 사용자 access token을 그대로 전달 (interfaces.md 9장) */
  guide(question: string, accessToken: string): Promise<unknown>;
  /** 가이드 SSE (progress·result·error 이벤트). 없으면 JSON 응답만 */
  guideStream?(question: string, accessToken: string): Promise<ReadableStream<Uint8Array>>;
  /** 워크플로 실패 기록 (yoyo0704 WORKFLOWS `WF#{id}`: EXECUTION·STEP#*). 실패 시 문서가 QUARANTINED로 멈춘 것처럼 보이지 않게 노출 */
  workflowFailure?(workflow_id: string): Promise<{ step: string; error: string; message?: string } | undefined>;
  /** 주장 단위 지식 (interfaces.md 10.2, PostgreSQL). 없으면 생략 */
  claims?: {
    list(doc_id: string): Promise<import('./claims.ts').ClaimRow[]>;
    counts(provision_ids: string[]): Promise<Map<string, Record<string, number>>>;
    debt(): Promise<Record<string, number>>;
  };
  /** 업무 분류 (interfaces.md 10.1, PostgreSQL). 없으면 분류 기능 생략 */
  categories?: {
    list(): Promise<import('./categories.ts').Category[]>;
    docMap(): Promise<Map<string, string>>;
    rename(id: string, name: string, actor: string): Promise<unknown>;
    merge(from: string, into: string, actor: string): Promise<{ moved: number }>;
  };
  /** 관리 > Agent 실행 기록: 실행 단위로 묶은 WORKFLOWS (EXECUTION·STEP#·LOCK#) */
  workflowRuns?(): Promise<{ workflow_id: string; doc_id?: string; status?: string; ended_at?: string; kind?: string; steps: { step: string; status: string; ended_at: string; error?: string }[] }[]>;
  /** 관리 > 규정 변경 영향: 사용자 Gateway graph___trace_impact (관리자 토큰) */
  traceImpact?(a: { law: string }, accessToken: string): Promise<unknown>;
  /** 업로드 진행바: WORKFLOWS 단계 기록 */
  workflowSteps?(workflow_id: string): Promise<{ step: string; status: string; ended_at: string; error?: string }[]>;
  /** 마스킹된 쪽 이미지 (masked/pages/{nnnn}.png). 없으면 undefined */
  pageImage?(doc_id: string, page_index: number): Promise<Uint8Array | undefined>;
  /** explain_findings(yoyo0704) 결과 masked/explanation.json. 없으면 undefined */
  explanation?(doc_id: string): Promise<unknown>;
  /** 마스킹된 쪽 이미지가 있는 page_index 목록 */
  pageImageList?(doc_id: string): Promise<number[]>;
  /** 본문이 인용한 외부 법령(「…법」, 내부 규정 저장소에 없는 것). let522mj externalLaws */
  externalLaws?(text: string): Promise<{ law_name: string; clause?: string }[]>;
  /** 외부 법령 최신 공식본 (사용자 Gateway regulation___fetch_official_law, AgentCore Browser). 사용자 토큰으로 호출 */
  officialLaw?(a: { law_name: string; clause?: string }, accessToken: string): Promise<unknown>;
  /** 문서보관함: 마스킹본 페이지 (`{doc_id}/masked/segments/`). 원본은 읽지 않는다 */
  pages?(doc_id: string): Promise<Page[]>;
  /** let522mj buildMarks: 판정·Finding → 밑줄 (page = pages 배열 인덱스, 못 찾으면 null) */
  marks?(pages: Page[], doc: DocumentRecord): Promise<Mark[]>;
  /** PageSummarize(yoyo0704) 결과 masked/summary.json. 없으면 undefined */
  pageSummary?(doc_id: string): Promise<{ pages?: PageMeta[] } | undefined>;
  /** AI로 다시 배치한 쪽 본문 (page_index → markdown). 원문 대조를 통과한 쪽만 있다 */
  structuredPages?(doc_id: string): Promise<Map<number, string>>;
}

/** 쪽별 요약·메타데이터 (docs/interfaces.md 6장 PageSummarize). page_index는 0부터 */
export interface PageMeta { page_index: number; summary: string; keywords: string[]; clause_refs: string[]; page_type: string }
const pageMetas = async (deps: Deps, doc_id: string) =>
  new Map(((deps.pageSummary ? await deps.pageSummary(doc_id).catch(() => undefined) : undefined)?.pages ?? [])
    .map((p) => [p.page_index, { summary: p.summary, keywords: p.keywords ?? [], clause_refs: p.clause_refs ?? [], page_type: p.page_type }] as const));

/** ULID 앞 10자(Crockford base32) = 생성 ms. 'wf_' 같은 접두사는 뗀다 */
export const ulidTime = (id: string) => {
  const u = id.replace(/^[a-z]+_/, '').slice(0, 10).toUpperCase();
  if (u.length < 10) return undefined;
  let ms = 0;
  for (const ch of u) { const v = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(ch); if (v < 0) return undefined; ms = ms * 32 + v; }
  return new Date(ms).toISOString();
};

type Env = { Variables: { actor: Actor; trace_id: string; token: string } };

/** 화면으로 나가는 Finding: message를 사람이 읽는 문장으로 바꾼다 (원래 message는 감사·운영 기록에만) */
const plainFinding = <F extends Finding>(f: F): F => ({ ...f, message: plainMessage(f) });

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
    app.use('/v1/*', cors({ origin: deps.webOrigins, allowHeaders: ['authorization', 'content-type'], allowMethods: ['GET', 'POST', 'DELETE'], maxAge: 600 }));

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
    const a = c.get('actor'); // 규칙 1: 로그인한 사람 누구나 (사용자 결정 11/17)
    const b = await body(c, UploadUrlBody);
    const ext = b.filename.split('.').pop()!.toLowerCase();
    if (!b.filename.includes('.') || !(ALLOWED_EXT as readonly string[]).includes(ext))
      throw new ApiError('VALIDATION', `허용 형식: ${ALLOWED_EXT.join(', ')}`);
    const now = new Date().toISOString();
    const doc: DocumentRecord = {
      doc_id: newId.doc(), version: 1, owner: a.sub, dept: b.dept, acl_groups: b.acl_groups,
      // 제목을 비우면 파일 이름으로 두고 분석(Classify)이 문서 내용으로 바꾼다
      title: b.title || b.filename.replace(/\.[^.]+$/, '').slice(0, 200), title_source: b.title ? 'USER' : 'AUTO', filename: b.filename.split(/[\\/]/).pop()!.slice(0, 200),
      ext: ext === 'jpeg' ? 'jpg' : ext, lifecycle: 'QUARANTINED', authority_status: 'UNVERIFIED', freshness: 'CURRENT',
      workflow_id: newId.wf(), findings: [], created_at: now, updated_at: now,
    };
    await store.putDoc(doc);
    const url = await deps.presignPut(quarantineKey(doc), b.size);
    await audit(c, 'UPLOAD_URL', doc.doc_id);
    return c.json({ doc_id: doc.doc_id, url }, 201);
  });

  // 위키 수정 (사용자 결정 11/17 규칙 1·2, interfaces 6.2). 게시된 노하우·매뉴얼 → 새 버전, 내 검토 중 문서 → 그 자리에서 다시 분석.
  // 규정은 공식 원본 대조 대상이라 수정 불가(개정 원본 업로드만). 원본 파일은 이전 버전 근거로 남는다
  app.post('/v1/documents/:id/edit', async (c) => {
    const a = c.get('actor');
    if (!deps.putOriginal) throw new ApiError('NOT_FOUND', '위키 수정이 설정되지 않았습니다');
    const b = await body(c, EditBody);
    const t = await store.getDoc(c.req.param('id'));
    if (!t || t.lifecycle === 'DELETED' || (t.owner !== a.sub && !(t.lifecycle === 'PUBLISHED' && canRead(a, t.acl_groups)))) throw new ApiError('NOT_FOUND', 'document not found');
    const type = t.document_type ?? t.classification?.document_type;
    if (type === 'REGULATION') throw new ApiError('CONFLICT', '규정은 위키에서 고칠 수 없습니다. 개정된 원본 파일을 올려 주세요');
    const now = new Date().toISOString();
    const md = new TextEncoder().encode(b.markdown);
    const fresh = { lifecycle: 'QUARANTINED' as const, trust_gate_result: undefined, findings: [], workflow_id: newId.wf(), s3_version_id: undefined, content_hash: undefined,
      knowhow_validation: undefined, ext: 'md', source: 'WIKI_EDIT' as const, updated_at: now };
    let doc: DocumentRecord;
    if (t.owner === a.sub && t.lifecycle === 'IN_REVIEW') doc = { ...t, ...fresh }; // 내 검토 중 문서: '고칠 것'을 반영해 다시 분석
    else if (t.lifecycle === 'PUBLISHED') doc = {
      ...fresh, doc_id: newId.doc(), version: 1, owner: a.sub, dept: a.dept ?? t.dept, acl_groups: t.acl_groups, title: t.title, title_source: 'USER',
      filename: `${t.title.slice(0, 80)}.md`, authority_status: 'UNVERIFIED', freshness: 'CURRENT', previous_doc_id: t.doc_id, created_at: now,
      ...(type ? { classification: { ...(t.classification ?? { business_path: [], tags: [], confidence: 1, rationale: '' }), document_type: type, source: 'HUMAN' as const } } : {}),
    };
    else throw new ApiError('CONFLICT', '게시된 문서이거나, 검토 중인 내 문서만 고칠 수 있습니다');
    await store.putDoc(doc);
    await deps.putOriginal(quarantineKey(doc), md);
    await audit(c, 'WIKI_EDIT', doc.doc_id);
    return c.json({ doc_id: doc.doc_id, previous_doc_id: doc.previous_doc_id ?? null, new_version: doc.doc_id !== t.doc_id }, 201);
  });

  // '의도한 삭제' 확인: 수정에서 지운 중요 문장을 올린 사람이 일부러 지웠다고 확인 (게시 요청 잠금 해제, 승인자에게는 보임)
  app.post('/v1/documents/:id/findings/:fid/ack', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub) throw new ApiError('FORBIDDEN', 'not the owner');
    const f = d.findings.find((x) => x.finding_id === c.req.param('fid'));
    if (!f || f.code !== 'EDIT_REMOVED_KEY_SENTENCE') throw new ApiError('NOT_FOUND', '확인할 수 있는 항목이 아닙니다');
    const at = new Date().toISOString();
    await store.putDoc({ ...d, findings: d.findings.map((x) => (x === f ? { ...x, acknowledged: { by: a.sub, at } } : x)), updated_at: at });
    await audit(c, 'FINDING_ACK', d.doc_id);
    return c.json({ ok: true });
  });

  app.post('/v1/documents/:id/analyze', async (c) => {
    const a = c.get('actor'); // 규칙 1: 로그인한 사람 누구나 (사용자 결정 11/17)
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
    const failure = d.workflow_id && d.lifecycle !== 'PUBLISHED' && deps.workflowFailure ? await deps.workflowFailure(d.workflow_id) : undefined;
    return c.json({ ...d, task_token: undefined, findings: undefined, workflow_failure: failure }); // 이전 SFN 문서에 남은 task_token은 숨김
  });

  // 이 문서의 이전 버전 후보 (작성자 검토 화면). 같은 종류의 게시 문서 중 같은 규정·같은 제목·본문 유사
  app.get('/v1/documents/:id/version-candidates', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.previous_doc_id) {
      const prev = await store.getDoc(d.previous_doc_id);
      return c.json({ linked: prev ? { doc_id: prev.doc_id, title: prev.title, version_no: prev.version_no ?? 1 } : null, version_no: d.version_no, items: [] });
    }
    const pool = (await visibleDocs(a)).filter((x) => x.doc_id !== d.doc_id && x.lifecycle === 'PUBLISHED' && x.freshness !== 'SUPERSEDED' && (!typeOf(d) || typeOf(x) === typeOf(d)));
    // ponytail: 제목 유사도로 8건만 본문 비교 (쪽 읽기 비용). 문서가 많아지면 KB 유사 검색으로 후보를 줄인다
    const top = pool.map((x) => ({ x, s: (d.law_id && x.law_id === d.law_id) ? 2 : similarity(d.title, x.title) })).sort((p, q) => q.s - p.s).slice(0, 8).map((p) => p.x);
    const mine = (await texts(d.doc_id)).join('\n');
    const cands = await Promise.all(top.map(async (x) => ({ doc_id: x.doc_id, title: x.title, law_id: x.law_id, text: (await texts(x.doc_id)).join('\n') })));
    return c.json({ linked: null, items: previousVersionCandidates({ title: d.title, text: mine, law_id: d.law_id }, cands) });
  });

  // 이전 버전 연결·해제 (작성자, 게시 요청 전까지). 연결하면 같은 묶음(series)의 다음 번호
  app.post('/v1/documents/:id/previous', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub) throw new ApiError('FORBIDDEN', 'not the owner');
    if (!['QUARANTINED', 'IN_REVIEW'].includes(d.lifecycle)) throw new ApiError('CONFLICT', '게시 요청 뒤에는 버전 연결을 바꿀 수 없습니다');
    const b = await body(c, PreviousBody);
    const at = new Date().toISOString();
    if (!b.previous_doc_id) {
      await store.putDoc({ ...d, previous_doc_id: undefined, series_id: undefined, version_no: undefined, updated_at: at });
      await audit(c, 'VERSION_UNLINK', d.doc_id);
      return c.json({ linked: null });
    }
    const prev = (await visibleDocs(a)).find((x) => x.doc_id === b.previous_doc_id && x.lifecycle === 'PUBLISHED' && x.freshness !== 'SUPERSEDED');
    if (!prev) throw new ApiError('NOT_FOUND', '연결할 게시 문서를 찾을 수 없습니다 (이미 새 버전이 있거나 볼 권한 없음)');
    const series_id = prev.series_id ?? prev.doc_id;
    const version_no = (prev.version_no ?? 1) + 1;
    await store.putDoc({ ...d, previous_doc_id: prev.doc_id, series_id, version_no, updated_at: at });
    await audit(c, 'VERSION_LINK', d.doc_id);
    return c.json({ linked: { doc_id: prev.doc_id, title: prev.title, version_no: prev.version_no ?? 1 }, version_no });
  });

  // 제목 고치기: 작성자, 게시 요청 전까지. 이력 남김 (자동 제목을 사람이 바로잡는 경우)
  app.post('/v1/documents/:id/title', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub) throw new ApiError('FORBIDDEN', 'not the owner');
    if (!['QUARANTINED', 'IN_REVIEW'].includes(d.lifecycle)) throw new ApiError('CONFLICT', '게시 요청 뒤에는 제목을 바꿀 수 없습니다');
    const b = await body(c, TitleBody);
    const at = new Date().toISOString();
    await store.putDoc({ ...d, title: b.title, title_source: 'USER', title_history: [...(d.title_history ?? []), { from: d.title, to: b.title, by: a.sub, at }].slice(-20), updated_at: at });
    await audit(c, 'TITLE_EDIT', d.doc_id);
    return c.json({ title: b.title });
  });

  // 문서 삭제 (사용자 결정 11/17 B, interfaces 6.0): 작성자 본인 또는 관리자. DELETED 표시·감사 → KB·그래프·저장소 정리는 오케스트레이터.
  // 이미 DELETED면 정리만 다시 (재시도). Documents·Approvals·감사 기록은 남긴다
  app.delete('/v1/documents/:id', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub && !hasRole(a, APPROVERS)) throw new ApiError('FORBIDDEN', 'owner or approver only');
    const b = await body(c, DeleteBody);
    const at = new Date().toISOString();
    const next: DocumentRecord = {
      ...d, lifecycle: 'DELETED', deleted_reason: d.lifecycle === 'DELETED' ? d.deleted_reason ?? b.reason : b.reason,
      deleted_by: d.deleted_by ?? a.sub, delete_workflow_id: newId.wf(), updated_at: at,
      ...(d.purge ? { purge: { ...d.purge, deleted_at: undefined, review_required: undefined } } : {}),
    };
    await store.putDoc(next);
    await audit(c, 'DOCUMENT_DELETE', d.doc_id);
    let cleanup_started = false;
    try { if (deps.deleteWorkflow) { await deps.deleteWorkflow(next); cleanup_started = true; } } catch { await audit(c, 'DELETE_CLEANUP_START_FAILED', d.doc_id); }
    return c.json({ doc_id: d.doc_id, lifecycle: 'DELETED', cleanup_started }, 202);
  });

  app.get('/v1/documents/:id/review', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (!hasRole(a, APPROVERS) && d.owner !== a.sub) throw new ApiError('NOT_FOUND', 'document not found');
    // 규칙 2: 올린 사람이 고칠 것 (규정과 어긋난 문장은 AI 수정 제안과 함께, 지운 중요 문장은 '의도한 삭제' 확인)
    const sugg = new Map((d.knowhow_validation?.items ?? []).map((it) => [it.statement, it.suggestion]));
    const fixes = d.findings.filter((f) => FIX_CODES.has(f.code)).map((f) => {
      const ex = f.location?.excerpt ?? '';
      const st = [...sugg.keys()].find((s) => s.includes(ex.slice(0, 40)) || ex.includes(s.slice(0, 40)));
      return { finding_id: f.finding_id, code: f.code, message: f.user_message ?? f.message, excerpt: st ?? ex, suggestion: st ? sugg.get(st) ?? null : null, fix_hint: f.fix_hint ?? null, acknowledged: !!f.acknowledged };
    });
    const text = d.lifecycle === 'IN_REVIEW' && d.owner === a.sub ? (await texts(d.doc_id).catch(() => [])).join('\n\n') : undefined;
    const workflow_failure = d.workflow_id && d.lifecycle !== 'PUBLISHED' && deps.workflowFailure ? await deps.workflowFailure(d.workflow_id) : undefined;
    const page_summaries = [...(await pageMetas(deps, d.doc_id))].map(([page_index, m]) => ({ page_index, ...m })).sort((x, y) => x.page_index - y.page_index);
    return c.json({ fixes, ...(text !== undefined ? { text } : {}), source: d.source ?? 'UPLOAD', workflow_failure, page_summaries, doc_id: d.doc_id, title: d.title, title_source: d.title_source, doc_date: d.doc_date, doc_dates: d.doc_dates,
      can_edit: d.owner === a.sub && ['QUARANTINED', 'IN_REVIEW'].includes(d.lifecycle), previous_doc_id: d.previous_doc_id, version_no: d.version_no, lifecycle: d.lifecycle, trust_gate_result: d.trust_gate_result, authority_status: d.authority_status, freshness: d.freshness, classification: d.classification, findings: d.findings.map(plainFinding), knowhow_validation: d.knowhow_validation });
  });

  app.get('/v1/documents/:id/progress', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub && !hasRole(a, APPROVERS)) throw new ApiError('NOT_FOUND', 'document not found');
    const rec = d.workflow_id && deps.workflowSteps ? await deps.workflowSteps(d.workflow_id) : [];
    return c.json({ ...progress(d.lifecycle, rec), blocked_reasons: d.lifecycle === 'BLOCKED' ? blockedReasons(d.findings) : [] });
  });

  // 올린 사람(또는 관리자)용 사유 목록: 몇 쪽·무엇이·왜·어떻게 고치는지 (사용자 지시 11/17)
  app.get('/v1/documents/:id/issues', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub && !hasRole(a, APPROVERS)) throw new ApiError('NOT_FOUND', 'document not found');
    const failure = d.workflow_id && d.lifecycle !== 'PUBLISHED' && deps.workflowFailure ? await deps.workflowFailure(d.workflow_id) : undefined;
    const images = deps.pageImageList ? await deps.pageImageList(d.doc_id).catch(() => []) : [];
    const explanation = deps.explanation ? await deps.explanation(d.doc_id).catch(() => undefined) : undefined;
    return c.json({ doc_id: d.doc_id, lifecycle: d.lifecycle, items: issues(d.findings, failure), page_images: images.map((n) => n + 1), explanation: explanation ?? null });
  });

  // 마스킹된 쪽 이미지 (원본 아님). page는 1부터
  app.get('/v1/documents/:id/pages/:page/image', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub && !hasRole(a, APPROVERS)) throw new ApiError('NOT_FOUND', 'document not found');
    const n = Number(c.req.param('page'));
    if (!Number.isInteger(n) || n < 1 || n > 2000) throw new ApiError('VALIDATION', 'page: 1 이상 정수');
    const png = deps.pageImage ? await deps.pageImage(d.doc_id, n - 1).catch(() => undefined) : undefined;
    if (!png) throw new ApiError('NOT_FOUND', 'page image not found');
    return new Response(new Blob([new Uint8Array(png)]), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=300' } });
  });

  app.post('/v1/documents/:id/submit', async (c) => {
    const a = c.get('actor'); // 규칙 1: 로그인한 사람 누구나 (사용자 결정 11/17)
    const d = await loadDoc(c, c.req.param('id'));
    const apr = await submitForApproval(store, d, a.sub);
    await audit(c, 'SUBMIT', d.doc_id);
    return c.json({ approval_id: apr.approval_id }, 201);
  });

  app.post('/v1/documents/:id/classification', async (c) => {
    const a = c.get('actor'); // 규칙 1: 로그인한 사람 누구나 (사용자 결정 11/17)
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

  // ---- 주장 (얇은 버전, interfaces 10.2): 문서 주장 + 같은 조문을 근거로 한 게시 문서 주장의 지지·충돌 수 ----
  async function docClaimsView(d: DocumentRecord) {
    if (!deps.claims) return [];
    const rows = await deps.claims.list(d.doc_id).catch(() => []);
    const counts = await deps.claims.counts([...new Set(rows.map((r) => r.provision_id).filter((x): x is string => !!x))]).catch(() => new Map<string, Record<string, number>>());
    const labels = new Map((d.knowhow_validation?.items ?? []).map((it) => [it.provision_id, it.label]));
    return rows.map((r) => {
      const c = r.provision_id ? counts.get(r.provision_id) ?? {} : {};
      return { ...r, label: (r.provision_id && labels.get(r.provision_id)) || r.provision_id,
        on_provision: r.provision_id ? { supports: (c.SUPPORTS ?? 0) + (c.SUPPLEMENTS ?? 0), conflicts: c.CONFLICTS ?? 0, unclear: c.INSUFFICIENT ?? 0 } : null };
    });
  }
  // 관리자: 지식 부채 (게시 문서 주장 기준). knowledge_debt 뷰 그대로
  app.get('/v1/admin/knowledge-debt', async (c) => {
    need(c, APPROVERS);
    return c.json(deps.claims ? await deps.claims.debt() : { conflicts: 0, review_required: 0, unverified: 0, healthy: 0, docs_needing_attention: 0 });
  });

  // ---- 업무 분류 (사용자 결정 11/17 A: AI 가 배정·생성·병합, 관리자는 선택적 이름 수정·병합) ----
  async function categoryView() {
    const [list, docs] = deps.categories ? await Promise.all([deps.categories.list(), deps.categories.docMap()]).catch(() => [[], new Map<string, string>()] as const) : [[], new Map<string, string>()] as const;
    const byId = new Map(list.map((x) => [x.category_id, x]));
    return {
      list, docs, byId,
      pathOf: (doc_id: string) => byId.get(docs.get(doc_id) ?? '')?.path ?? null,
      /** 칸 id 가 want 칸이거나 그 하위 칸인가 */
      inside: (id: string | undefined, want: string) => { const p = byId.get(id ?? '')?.path, w = byId.get(want)?.path; return !!p && !!w && (p === w || p.startsWith(`${w}/`)); },
    };
  }
  // 보관함 트리: 칸 계층 + 이 사용자가 볼 수 있는 게시 문서 수(하위 포함). 문서가 없는 칸도 보인다
  app.get('/v1/categories', async (c) => {
    const vis = await visibleDocs(c.get('actor'));
    const cat = await categoryView();
    const reps = [...groupSeries(vis.filter((d) => d.lifecycle === 'PUBLISHED')).values()].map((g) => representative(g));
    const items = cat.list.map((x) => ({ category_id: x.category_id, parent_id: x.parent_id, name: x.name, path: x.path, level: x.level, description: x.description,
      doc_count: reps.filter((d) => cat.inside(cat.docs.get(d.doc_id), x.category_id)).length }));
    return c.json({ items });
  });
  app.patch('/v1/categories/:id', async (c) => {
    const a = need(c, APPROVERS);
    if (!deps.categories) throw new ApiError('NOT_FOUND', '업무 분류가 설정되지 않았습니다');
    const b = await body(c, CategoryRenameBody);
    try { const r = await deps.categories.rename(c.req.param('id'), b.name, a.sub); await audit(c, 'CATEGORY_RENAME', c.req.param('id')); return c.json(r); }
    catch (e) { throw catErr(e); }
  });
  app.post('/v1/categories/:id/merge', async (c) => {
    const a = need(c, APPROVERS);
    if (!deps.categories) throw new ApiError('NOT_FOUND', '업무 분류가 설정되지 않았습니다');
    const b = await body(c, CategoryMergeBody);
    try { const r = await deps.categories.merge(c.req.param('id'), b.into, a.sub); await audit(c, 'CATEGORY_MERGE', c.req.param('id')); return c.json(r); }
    catch (e) { throw catErr(e); }
  });
  const catErr = (e: unknown) => {
    const m = (e as Error).message;
    if (m === 'NotFound') return new ApiError('NOT_FOUND', '칸을 찾을 수 없습니다');
    if (m === 'HasChildren') return new ApiError('CONFLICT', '하위 칸이 있는 칸은 병합할 수 없습니다. 하위 칸을 먼저 병합하세요');
    if (m === 'SameCategory') return new ApiError('VALIDATION', '같은 칸으로는 병합할 수 없습니다');
    if (/duplicate key|23505/.test(m)) return new ApiError('CONFLICT', '같은 이름의 칸이 이미 있습니다');
    return e as Error;
  };

  // ---- 관리 > 운영 도구 (요청기록/20261117-1910 2장) ----
  // Agent 실행 기록: 최근 실행 50건 (상태·소요 시간·문서 제목). 시작 시각은 workflow_id(ULID)에 들어 있다
  app.get('/v1/admin/runs', async (c) => {
    need(c, APPROVERS);
    if (!deps.workflowRuns) return c.json({ items: [] });
    const titles = new Map((await store.listDocs()).map((d) => [d.doc_id, d.title]));
    const items = (await deps.workflowRuns()).map((r) => {
      const started_at = ulidTime(r.workflow_id);
      const ended = [r.ended_at, ...r.steps.map((s) => s.ended_at)].filter(Boolean).sort().at(-1);
      const failed = r.steps.find((s) => s.status === 'FAILED');
      return {
        workflow_id: r.workflow_id, doc_id: r.doc_id, title: r.doc_id ? titles.get(r.doc_id) ?? '(삭제된 문서)' : undefined, kind: r.kind ?? 'ingest',
        status: r.status ?? (failed ? 'FAILED' : 'RUNNING'), started_at, ended_at: r.ended_at,
        duration_s: started_at && ended ? Math.max(0, Math.round((Date.parse(ended) - Date.parse(started_at)) / 1000)) : undefined,
        steps: r.steps.length, failed_step: failed?.step,
      };
    }).sort((x, y) => (y.started_at ?? '').localeCompare(x.started_at ?? '')).slice(0, 50);
    return c.json({ items, trace_url: `https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#gen-ai-observability/agent-core` });
  });
  app.get('/v1/admin/runs/:id', async (c) => {
    need(c, APPROVERS);
    const id = c.req.param('id');
    if (!/^wf_[0-9A-Z]{26}$/.test(id)) throw new ApiError('VALIDATION', 'workflow_id 형식');
    const steps = deps.workflowSteps ? await deps.workflowSteps(id) : [];
    if (!steps.length) throw new ApiError('NOT_FOUND', '실행 기록 없음');
    return c.json({ workflow_id: id, started_at: ulidTime(id), steps: steps.sort((x, y) => x.ended_at.localeCompare(y.ended_at)) });
  });
  // 규정 변경 영향: 규정 고르기 → 개정 전후 바뀐 조문 → 영향받는 노하우·근거 조문·위험도 (graph trace_impact)
  app.get('/v1/admin/impact/laws', async (c) => {
    need(c, ['REG_APPROVER']);
    const regs = (await store.listDocs()).filter((d) => d.lifecycle === 'PUBLISHED' && d.law_name);
    const by = new Map<string, number>();
    for (const d of regs) by.set(d.law_name!, (by.get(d.law_name!) ?? 0) + 1);
    return c.json({ items: [...by].map(([law_name, versions]) => ({ law_name, versions })).sort((x, y) => y.versions - x.versions || x.law_name.localeCompare(y.law_name)) });
  });
  app.get('/v1/admin/impact', async (c) => {
    need(c, ['REG_APPROVER']);
    const law = (c.req.query('law') ?? '').trim();
    if (!law || law.length > 200) throw new ApiError('VALIDATION', 'law: 1~200자');
    if (!deps.traceImpact) throw new ApiError('NOT_FOUND', '영향 분석 도구가 연결되지 않았습니다');
    try { return c.json(await deps.traceImpact({ law }, c.get('token'))); }
    catch (e) { throw new ApiError('NOT_FOUND', (e as Error).name === 'ToolError' ? '비교할 이전 개정본이 없거나 등록되지 않은 규정입니다' : '영향 분석 도구 호출에 실패했습니다'); }
  });

  // ---- 출처 불일치 (위조 의심) 처리: 승인 대상이 아니므로 별도 큐 ----
  app.get('/v1/review-queue', async (c) => {
    need(c, APPROVERS);
    const docs = await store.listDocs();
    const items = [
      ...docs.filter((d) => d.lifecycle === 'IN_REVIEW' && hasSourceMismatch(d) && !d.source_review)
        .map((d) => ({ doc_id: d.doc_id, title: d.title, dept: d.dept, kind: 'SOURCE_MISMATCH', findings: d.findings.filter((f) => f.code === 'REGISTRY_MISMATCH').map(plainFinding) })),
      // 보안 검사 자동 차단 (결재 대상은 아니지만 관리자가 이유를 확인). 마스킹본 보관 기간(7일) 안의 것만
      ...docs.filter((d) => d.lifecycle === 'BLOCKED' && !d.source_review && Date.now() - Date.parse(d.updated_at) < 7 * 864e5)
        .sort((x, y) => y.updated_at.localeCompare(x.updated_at)).slice(0, 20)
        .map((d) => ({ doc_id: d.doc_id, title: d.title, dept: d.dept, kind: 'BLOCKED', findings: d.findings.filter((f) => f.severity === 'HIGH').map(plainFinding) })),
    ];
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
    // 문서 제목과, 승인 뒤 게시가 멈춘 경우 실패 단계·사유를 함께 (승인했는데 안 보이는 문제를 화면에서 알 수 있게)
    const items = await Promise.all((await store.listApprovals(status)).map(async (r) => {
      const d = await store.getDoc(r.doc_id);
      const failure = d?.workflow_id && d.lifecycle !== 'PUBLISHED' && status !== 'PENDING' && deps.workflowFailure ? await deps.workflowFailure(d.workflow_id) : undefined;
      const v = d?.previous_doc_id && status === 'PENDING' ? await versionDiff(c.get('actor'), d).catch(() => null) : null;
      // 규칙 3: 승인자는 한 줄 요약 + 바뀐 부분 + 승인·반려. 나머지는 '자세히'(문서 상세)
      const summary_line = (d?.summary ?? '').split(/(?<=[.다])\s+/u)[0]?.slice(0, 140) || null;
      return { ...r, task_token: undefined, title: d?.title, lifecycle: d?.lifecycle, workflow_failure: failure, summary_line, source: d?.source ?? 'UPLOAD',
        ...(v ? { version: { version_no: d!.version_no, previous_title: v.previous.title, changes_count: v.count, changes: v.changes.slice(0, 6) } } : {}) };
    }));
    // 폐기·반려된 문서의 남은 승인 요청은 결재함에 보이지 않게 (승인 대기는 문서도 PENDING_APPROVAL일 때만)
    return c.json({ items: items.filter((i) => i.lifecycle && i.lifecycle !== 'DELETED' && (status !== 'PENDING' || i.lifecycle === 'PENDING_APPROVAL')) });
  });

  app.post('/v1/approvals/:id/decision', async (c) => {
    const a = need(c, ['REG_APPROVER']);
    const b = await body(c, DecisionBody);
    const apr = await store.getApproval(c.req.param('id'));
    if (!apr) throw new ApiError('NOT_FOUND', 'approval not found');
    const d = await store.getDoc(apr.doc_id);
    if (!d) throw new ApiError('NOT_FOUND', 'document not found');
    if (b.decision === 'APPROVE' && !(d.document_type ?? d.classification?.document_type)) throw new ApiError('CONFLICT', 'unclassified: 분류되지 않은 문서는 승인할 수 없습니다. 반려 후 다시 분석하세요');
    // 승인 시점의 실제 객체를 다시 읽어 바인딩 검증 (검사 후 변경 차단)
    const head = await deps.headObject(quarantineKey(d));
    if (!head) throw new ApiError('CONFLICT', 'object missing');
    const status = b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    // 반려·재검증은 변경된 객체에도 가능해야 하므로 바인딩 검증은 APPROVE에만 적용
    // 버전 ID는 불변 → 현재 객체 버전이 게시 요청 때와 같아야 승인. 해시는 Promote가 바이트로 재검증한다
    const bind = { s3_version_id: status === 'APPROVED' ? head.s3_version_id : apr.s3_version_id, content_hash: apr.content_hash };
    const decided = await store.decideApproval(apr.approval_id, { status, approver_sub: a.sub, ...(a.username ? { approver_name: a.username } : {}), reason: b.reason, ...bind });
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
  const visibleDocs = async (a: Actor) => (await store.listDocs()).filter((d) => d.lifecycle !== 'DELETED' && (d.owner === a.sub || (d.lifecycle === 'PUBLISHED' && canRead(a, d.acl_groups))));
  /** 상세용 문서 찾기. 결재함에서 연 결재 대상(게시 전·차단) 문서는 관리자만, 상세 본문 열람 때 감사 기록. 보관함 목록에는 섞지 않는다. 권한 없음도 404 */
  const libraryDoc = async (c: Context<Env>, vis: DocumentRecord[], auditRead = false) => {
    const a = c.get('actor');
    const d = vis.find((x) => x.doc_id === c.req.param('id'));
    if (d) return d;
    const x = hasRole(a, APPROVERS) ? await store.getDoc(c.req.param('id') ?? '') : undefined;
    if (!x || !['IN_REVIEW', 'PENDING_APPROVAL', 'BLOCKED'].includes(x.lifecycle)) throw new ApiError('NOT_FOUND', 'document not found');
    if (auditRead) await audit(c, 'LIBRARY_REVIEW_READ', x.doc_id);
    return x;
  };

  // ---- 버전 관리 (사용자 요청 11/17, let522mj 요청 1211). 연결은 작성자가 확인한 경우에만 ----
  const typeOf = (d: DocumentRecord) => d.document_type ?? d.classification?.document_type;
  const texts = async (id: string) => (deps.pages ? (await deps.pages(id).catch(() => [])).sort((x, y) => x.page - y.page).map((p) => p.text) : []);
  /** 직전 버전과 바뀐 곳. 직전 버전을 볼 권한이 없으면 내용 없이 개수만 */
  const versionDiff = async (a: Actor, d: DocumentRecord, prevDoc?: DocumentRecord) => {
    if (!d.previous_doc_id && !prevDoc) return null;
    const prev = prevDoc ?? await store.getDoc(d.previous_doc_id!);
    if (!prev) return null;
    const changes = diffDocuments(await texts(prev.doc_id), await texts(d.doc_id));
    const canSee = prev.owner === a.sub || hasRole(a, APPROVERS) || canRead(a, prev.acl_groups);
    return { previous: { doc_id: prev.doc_id, title: prev.title, version_no: prev.version_no ?? 1 }, count: changes.length, changes: canSee ? changes.slice(0, 200) : [] };
  };
  app.get('/v1/library', async (c) => {
    const vis = await visibleDocs(c.get('actor'));
    const f = { type: c.req.query('type'), tag: c.req.query('tag'), q: c.req.query('q')?.slice(0, 200), ...detailFilter((k) => c.req.query(k)) };
    const cat = await categoryView();
    const want = c.req.query('category'); // 업무 분류 칸 (하위 칸 포함)
    const inCat = (doc_id: string) => !want || cat.inside(cat.docs.get(doc_id), want);
    // 같은 문서의 여러 버전(규정 개정본, 작성자가 연결한 새 버전)은 카드 1장: 오늘 시행 중인 버전이 대표
    const groups = [...groupSeries(vis.filter((d) => d.lifecycle !== 'BLOCKED')).values()];
    const items = groups.map((g) => ({ rep: representative(g), n: g.length })).filter(({ rep }) => matches(rep, f) && inCat(rep.doc_id))
      .sort((x, y) => y.rep.updated_at.localeCompare(x.rep.updated_at)).map(({ rep, n }) => ({ ...card(rep, vis), version_count: n, category_path: cat.pathOf(rep.doc_id) }));
    return c.json({ items });
  });
  // 외부 법령 최신본 참고 (미검증). 첫 조회는 Browser라 수십 초 → 상세 본문과 따로 부른다
  app.get('/v1/library/:id/external-laws', async (c) => {
    const vis = await visibleDocs(c.get('actor'));
    const d = await libraryDoc(c, vis);
    if (!deps.pages || !deps.externalLaws) return c.json({ items: [], note: '외부 법령 조회가 설정되지 않았습니다' });
    const laws = await deps.externalLaws((await deps.pages(d.doc_id)).map((p) => p.text).join('\n'));
    const items = await Promise.all(laws.map(async (l) => {
      try { return { ...l, result: deps.officialLaw ? await deps.officialLaw(l, c.get('token')) : null }; }
      catch (e) { return { ...l, error: (e as Error).name }; }
    }));
    return c.json({ items });
  });

  // 버전: 같은 묶음의 버전 목록 + 직전 버전과 바뀐 곳
  app.get('/v1/library/:id/versions', async (c) => {
    const a = c.get('actor');
    const vis = await visibleDocs(a);
    const d = await libraryDoc(c, vis);
    const sid = seriesKey(d);
    const series = vis.filter((x) => seriesKey(x) === sid || x.doc_id === d.series_id);
    if (!series.some((x) => x.doc_id === d.doc_id)) series.push(d);
    const ord = orderVersions(series);
    const rep = representative(series);
    const items = ord.map(({ d: x, version_no }) => ({ doc_id: x.doc_id, title: x.title, version_no, lifecycle: x.lifecycle, freshness: x.freshness, updated_at: x.updated_at,
      effective_from: x.effective_from ?? null, current: x.doc_id === rep.doc_id }));
    // 직전 버전: 작성자가 연결한 previous_doc_id, 없으면(규정 개정본) 순서상 바로 앞 버전
    const i = ord.findIndex((x) => x.d.doc_id === d.doc_id);
    const prev = d.previous_doc_id ? undefined : ord[i - 1]?.d;
    const diff = await versionDiff(a, d, prev);
    return c.json({ items, diff: diff && prev ? { ...diff, previous: { ...diff.previous, version_no: ord[i - 1]!.version_no } } : diff });
  });

  // 원본 내려받기 (사용자 요청 11/17): 상세를 볼 수 있는 사람만, 감사 기록. 차단·반려·삭제로 원본을 지운 문서는 없음
  app.get('/v1/library/:id/download', async (c) => {
    const d = await libraryDoc(c, await visibleDocs(c.get('actor')));
    if (!deps.presignGet || d.purge?.original_at || d.purge?.deleted_at) throw new ApiError('NOT_FOUND', '원본 파일이 없습니다 (검증 실패·삭제로 지워짐)');
    const filename = d.filename ?? `${d.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.${d.ext}`;
    const url = await deps.presignGet(quarantineKey(d), d.s3_version_id, filename);
    await audit(c, 'DOCUMENT_DOWNLOAD', d.doc_id);
    return c.json({ url, filename });
  });

  // 다른 유형의 비슷한 문서 (매뉴얼·규정·노하우 상호 보완). 검색 2회라 상세 본문과 따로 부른다
  app.get('/v1/library/:id/similar', async (c) => {
    const vis = await visibleDocs(c.get('actor'));
    const d = await libraryDoc(c, vis);
    const q = (d.summary ?? d.title).slice(0, 300);
    // 규정은 결과가 규정 조문으로만 채워지지 않게 노하우·매뉴얼 색인을 따로 찾는다
    const isReg = (d.document_type ?? d.classification?.document_type) === 'REGULATION';
    const hits = (await Promise.all([
      deps.search(q, c.get('actor'), { tags: [] }),
      ...(isReg ? [deps.search(q, c.get('actor'), { tags: [], index_groups: ['wiki-knowledge', 'official-manuals'] })] : []),
    ].map((p) => p.catch(() => [])))).flat().filter((h) => !(h as { weak?: boolean }).weak).reverse() as { doc_id: string; title: string; document_type?: string }[];
    return c.json({ items: similar(d, hits, vis, card(d, vis).related) });
  });

  app.get('/v1/library/:id', async (c) => {
    const a = c.get('actor');
    const vis = await visibleDocs(a);
    const d = await libraryDoc(c, vis, true);
    const pages = deps.pages ? (await deps.pages(d.doc_id).catch(() => [])).sort((x, y) => x.page - y.page) : [];
    const marks = deps.marks && pages.length ? await deps.marks(pages, d) : [];
    const sum = new Map((d.page_summaries ?? []).map((p) => [p.page, p.summary]));
    const meta = await pageMetas(deps, d.doc_id); // 쪽 요약 단계 결과가 있으면 Classify 요약보다 우선
    const lawNames = vis.flatMap((x) => (x.law_name ? [x.law_name] : [])); // 인용 조문을 등록 규정 이름과 묶기
    const structuredMap = deps.structuredPages ? await deps.structuredPages(d.doc_id).catch(() => new Map<number, string>()) : new Map<number, string>();
    const approval = d.lifecycle === 'PUBLISHED' ? [...await store.listApprovals('USED'), ...await store.listApprovals('APPROVED')].filter((x) => x.doc_id === d.doc_id).sort((x, y) => (y.decided_at ?? '').localeCompare(x.decided_at ?? ''))[0] : undefined;
    const base = card(d, vis);
    const pendingApproval = d.lifecycle === 'PENDING_APPROVAL' && hasRole(a, APPROVERS) ? (await store.listApprovals('PENDING')).find((x) => x.doc_id === d.doc_id) : undefined;
    return c.json({
      ...base,
      ...await (async () => { const cv = await categoryView(); return { category_path: cv.pathOf(d.doc_id), category_id: cv.docs.get(d.doc_id) ?? null }; })(),
      claims: await docClaimsView(d),
      can_delete: d.owner === a.sub || hasRole(a, APPROVERS),
      // 결재 대상이면 결재 정보와 확인할 이유(쪽 본문이 없을 때 Finding으로 대신)
      review: d.lifecycle === 'PUBLISHED' || !hasRole(a, APPROVERS) ? undefined : {
        lifecycle: d.lifecycle,
        approval_id: pendingApproval?.approval_id,
        source_mismatch: d.lifecycle === 'IN_REVIEW' && hasSourceMismatch(d) && !d.source_review,
        findings: d.findings.filter((f) => f.severity !== 'LOW').map((f) => ({ severity: f.severity, code: f.code, step: f.step, message: plainMessage(f), fix_hint: f.fix_hint, page: f.location?.page })),
      },
      ...docDatesOf(d, pages),
      verification: verification(d, approval),
      doc_marks: marks.filter((m) => m.page === null), // 위치를 못 찾은 항목 (예: 공식 원본에서 빠진 조문) → 상단에 모아 표시
      pages: pages.map((p, i) => ({ page: p.page, text: p.text, structured: structuredMap.get(p.page) ?? null, ...meta.get(p.page),
        clause_groups: clauseGroups(meta.get(p.page)?.clause_refs ?? [], p.text, d.law_name, lawNames), summary: meta.get(p.page)?.summary || (sum.get(p.page) ?? null), marks: marks.filter((m) => m.page === i) })),
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
    const df = detailFilter((k) => c.req.query(k)); // 업무·부서·문서 일자·검증 상태·최신성 (search_wiki가 그대로 받음)
    // 문서 종류 필터 (규정·노하우·매뉴얼). 태그는 AI가 붙인 자유 문구라 화면 필터로 쓰지 않는다
    const type = c.req.query('type');
    if (type && !['REGULATION', 'KNOWHOW', 'MANUAL'].includes(type)) throw new ApiError('VALIDATION', 'type: REGULATION|KNOWHOW|MANUAL');
    const groups = type === 'REGULATION' ? ['legal-clauses'] : type ? ['wiki-knowledge', 'official-manuals'] : undefined;
    const raw = c.req.query('raw') === '1'; // '원래 질의로 찾기': 재구성 끔
    const res = await deps.search(q, a, { tags, as_of, ...df, ...(groups ? { index_groups: groups } : {}), ...(raw ? { rewrite: false } : {}) });
    const rewritten = res.rewritten;
    const all = res as unknown as { doc_id: string; document_type?: string; weak?: boolean }[];
    const sem = all.filter((i) => !i.weak);
    // 의미 검색은 조문 조각 상위 몇 개만 남는다 → 제목·요약·업무·태그에 검색어가 있는 게시 문서를 뒤에 더한다 (짧은 단어 검색 보완)
    // 재구성됐으면 핵심 검색어로 ('개인정보 관련된 문서들을 찾아줘' → '개인정보')
    const words = (rewritten?.core ?? q).toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    const seen = new Set(sem.map((i) => i.doc_id));
    // 키워드 보완은 묶음 대표(오늘 시행 중인 판)만: 같은 규정의 개정본이 따로 나오지 않게
    const reps = [...groupSeries((await visibleDocs(a)).filter((d) => d.lifecycle === 'PUBLISHED')).values()].map((g) => representative(g));
    const kw = reps.filter((d) => !seen.has(d.doc_id)
      && matches(d, { type, ...df })
      && words.length > 0 && words.every((w) => `${d.title} ${d.summary ?? ''} ${(d.classification?.business_path ?? []).join(' ')} ${(d.classification?.tags ?? []).join(' ')} ${d.law_name ?? ''}`.toLowerCase().includes(w)))
      .slice(0, 20).map((d) => keywordItem(d));
    const items = [...groupByDoc((type ? sem.filter((i) => i.document_type === type) : sem) as unknown as { doc_id: string; basis?: string; snippet: string }[]), ...kw];
    const shown = new Set(items.map((i) => i.doc_id));
    const related = groupByDoc(all.filter((i) => i.weak && !shown.has(i.doc_id) && (!type || i.document_type === type)) as unknown as { doc_id: string; basis?: string; snippet: string }[]);
    return c.json({ items, related, ...(rewritten ? { rewritten } : {}) });
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
