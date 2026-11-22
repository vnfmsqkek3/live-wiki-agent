import { changePrompt, type ChangeRequest } from './steps/change-request.ts';
import { groupLaws } from './steps/external-laws.ts';
import { ackItem, makeCarry } from './steps/carry.ts';
import { sentences } from './steps/edit-review.ts';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { ulid } from 'ulid';
import type { z } from 'zod';
import { canRead, hasRole, type VerifyToken } from './auth.ts';
import { diffDocuments, previousVersionCandidates, similarity } from '@hanaeum/legal-parser';
import { card, detailFilter, docDatesOf, groupSeries, orderVersions, representative, seriesKey, keywordItem, matches, similar, verification, type Mark, type Page, clauseGroups } from './library.ts';
import { blockedReasons, issues, plainMessage, progress } from './progress.ts';
import { groupByDoc } from './search.ts';
import { currentRevisions } from './steps/freshness.ts';
import {
  ALLOWED_EXT, CategoryMergeBody, CategoryRenameBody, ClassificationBody, EditBody, DecisionBody, DeleteBody, FeedbackBody, PreviousBody, TitleBody, GuideBody, SourceReviewBody, UploadUrlBody, newId,
  type Actor, type ApprovalRecord, type DocumentRecord, type Finding, type Role,
} from './contracts.ts';
import { ApiError } from './errors.ts';
import type { Rating, Store } from './store.ts';
import { CHECK_CODES, checkView, FIX_CODES, hasSourceMismatch, isOpenFix, REVIEW_CODES, submitForApproval } from './submit.ts';
import { detectPii, mask } from './steps/pii-detect.ts';
import { buildDocPages } from './steps/structure.ts';
import { composePrompt, fallbackAfter, keepsRest, safeSuggestion, type ClarifyKind } from './steps/clarify.ts';

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
  /** 원본 보기: 개인정보만 가린 쪽 이미지(masked/view) presigned GET 5분, 쪽 목록 */
  presignView?(key: string): Promise<string>;
  viewPageList?(doc_id: string): Promise<number[]>;
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
  figureKeys?(doc_id: string): Promise<Map<string, string>>;
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
  /** 확인 필요 답을 문장에 넣기 (Haiku) */
  composeClarify?(prompt: string): Promise<{ edits: { n: number; ok: boolean; no_change?: boolean; after: string; reason?: string }[] }>;
  /** 위키 수정 요청 판단 (Haiku) */
  judgeChange?(prompt: string): Promise<{ verdict: 'APPROPRIATE' | 'INAPPROPRIATE' | 'UNKNOWN'; after?: string; reason: string }>;
  /** Change Impact 수정 초안 (AI팀 steps/impact-draft.ts: impactPrompt → 모델 → checkImpactDraft). 없으면 UNKNOWN 으로만 저장 */
  /** Gateway 안에서 일어난 거부(AgentCore Policy·interceptor). API 감사 DB 밖이라 Gateway 로그에서 읽는다 (P1 데모 06, 11/20). sub 는 넘기지 않는다 */
  gatewayDenials?(since: string): Promise<{ at: string; role: string; tool: string; reason: string; trace_id: string }[]>;
  draftImpact?(i: { before: string; old_clause: string; new_clause: string; path: string; kind: string; context: string; /** 개정 규정 이름 → 초안 괄호 인용에 붙임 (AI팀 11/20) */ law_name?: string }): Promise<{ verdict: 'APPROPRIATE' | 'INAPPROPRIATE' | 'UNKNOWN'; after?: string; reason: string }>;
  structuredPages?(doc_id: string): Promise<Map<number, { markdown: string; source: 'TEXT' | 'VISION' | 'AI' }>>;
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
/** 위키 편집 글과 같은 그림 표시: 쪽(1부터) n 의 '(그림 k)' → '(그림 n-k)'. 이미 'n-k' 인 위키 수정본은 그대로 (11/18) */
const figRefs = (t: string, page?: number) => (page ? t.replace(/([([])그림\s*(\d+)([)\]])/g, (_m, a: string, k: string, b: string) => `${a}그림 ${page}-${k}${b}`) : t);
/** 확인 필요 항목의 문장들을 편집 글과 같은 그림 표시로 (그래야 저장 때 본문에서 찾는다, 사용자 지적 11/18 '원래 문장을 찾지 못한 항목') */
const clarifyView = (det: Record<string, unknown>) => {
  const pg = typeof det['page'] === 'number' ? det['page'] as number : undefined;
  const sg = (det['suggestions'] as { after?: string }[] | undefined)?.map((x) => ({ ...x, ...(x.after ? { after: figRefs(x.after, pg) } : {}) }));
  return { ...det, ...(typeof det['before'] === 'string' ? { before: figRefs(det['before'] as string, pg) } : {}), ...(sg ? { suggestions: sg } : {}) };
};
const plainFinding = <F extends Finding>(f: F): F => ({ ...f, message: plainMessage(f) });
/** 평점(인기)은 결재·검증(신뢰성)과 따로: rating{avg,count}(별점 0건이면 생략)·useful_count (P1 추천·평점, 프론트 요청 11/20) */
const ratingOf = (r?: Rating) => ({ ...(r?.count ? { rating: { avg: r.avg, count: r.count } } : {}), ...(r?.useful_count ? { useful_count: r.useful_count } : {}) });

const APPROVERS: Role[] = ['REG_APPROVER', 'SECURITY_REVIEWER'];
/** 고칠 곳 하나를 가리키는 키 (해당 없음 기록용). 재분석해도 같은 문장·종류면 같은 키 */
export const markKey = (m: Pick<Mark, 'kind' | 'reason'> & { original?: string | null }) => `${m.kind}|${m.original ?? m.reason}`.slice(0, 400);
/** 공백만 다른 같은 문장을 본문에서 찾아 본문 쪽 글자를 돌려준다 (없으면 undefined) */
export const looseFind = (text: string, s: string) => {
  const chars = [...s.replace(/\s+/g, '')];
  if (chars.length < 6) return undefined;
  return new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'u').exec(text)?.[0];
};
const quarantineKey = (d: Pick<DocumentRecord, 'doc_id' | 'ext'>) => `${d.doc_id}/original.${d.ext}`;

export function createApp(deps: Deps) {
  const app = new Hono<Env>();
  const { store } = deps;

  app.onError(async (err, c) => {
    const trace_id = c.get('trace_id') ?? ulid();
    const e = err instanceof ApiError ? err : new ApiError('INTERNAL', 'internal error');
    if (!(err instanceof ApiError)) console.error(JSON.stringify({ trace_id, err: String(err?.name) })); // 메시지에 원문이 섞일 수 있어 이름만
    if (e.status === 403 && c.get('actor'))
      // detail: 관리 '평가' 화면 거부 목록용 역할·사유 (원문·토큰 없음)
      await store.audit({ at: new Date().toISOString(), actor: c.get('actor').sub, action: `${c.req.method} ${c.req.routePath}`, resource: c.req.path, result: 'DENIED', trace_id, detail: { roles: c.get('actor').groups, reason: e.message.slice(0, 200) } });
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
    const b = await body(c, EditBody);
    const r = await editDoc(c.get('actor'), c.req.param('id'), b.markdown);
    await audit(c, 'WIKI_EDIT', r.doc_id);
    return c.json(r, 201);
  });
  /** 위키 수정 본체: 수정 요청 반영(관리자)도 같은 길로 새 버전을 만든다 */
  const editDoc = async (a: Actor, id: string, markdown: string, acks: ReturnType<typeof ackItem>[] = []) => {
    if (!deps.putOriginal) throw new ApiError('NOT_FOUND', '위키 수정이 설정되지 않았습니다');
    const b = { markdown };
    const t = await store.getDoc(id);
    if (!t || t.lifecycle === 'DELETED' || (t.owner !== a.sub && !(t.lifecycle === 'PUBLISHED' && canRead(a, t.acl_groups)))) throw new ApiError('NOT_FOUND', 'document not found');
    const type = t.document_type ?? t.classification?.document_type;
    if (type === 'REGULATION') throw new ApiError('CONFLICT', '규정은 위키에서 고칠 수 없습니다. 개정된 원본 파일을 올려 주세요');
    if (t.freshness === 'SUPERSEDED') throw new ApiError('CONFLICT', '새 버전으로 대체된 문서입니다. 최신 버전에서 고쳐 주세요');
    const now = new Date().toISOString();
    const md = new TextEncoder().encode(b.markdown);
    const fresh = { lifecycle: 'QUARANTINED' as const, trust_gate_result: undefined, findings: [], workflow_id: newId.wf(), s3_version_id: undefined, content_hash: undefined,
      knowhow_validation: undefined, ext: 'md', source: 'WIKI_EDIT' as const, updated_at: now };
    let doc: DocumentRecord;
    if (t.owner === a.sub && t.lifecycle === 'IN_REVIEW') doc = { ...t, ...fresh, review_carry: makeCarry(await editText(t.doc_id), t.findings, !!t.knowhow_validation) }; // 내 검토 중 문서: '고칠 것'을 반영해 다시 분석. 결정은 잇는다(원본을 쓰면 옛 결과가 지워지므로 그 전에 읽음)
    else if (t.lifecycle === 'PUBLISHED') doc = {
      ...fresh, doc_id: newId.doc(), version: 1, owner: a.sub, dept: a.dept ?? t.dept, acl_groups: t.acl_groups, title: t.title, title_source: 'USER',
      filename: `${t.title.slice(0, 80)}.md`, authority_status: 'UNVERIFIED', freshness: 'CURRENT', previous_doc_id: t.doc_id, created_at: now,
      // 새 버전도 이전 버전에서 답한 확인 필요·결정을 잇는다 (사용자 지적 11/18: 수정 요청 반영 뒤 이미 답한 질문이 다시 나왔다)
      review_carry: makeCarry(await editText(t.doc_id), t.findings, !!t.knowhow_validation),
      ...(type ? { classification: { ...(t.classification ?? { business_path: [], tags: [], confidence: 1, rationale: '' }), document_type: type, source: 'HUMAN' as const } } : {}),
    };
    else throw new ApiError('CONFLICT', '게시된 문서이거나, 검토 중인 내 문서만 고칠 수 있습니다');
    if (acks.length && doc.review_carry) doc.review_carry = { ...doc.review_carry, items: [...doc.review_carry.items, ...acks] };
    doc.figure_source = t.figure_source ?? { doc_id: t.doc_id, pages: figurePages(t) };
    // 처음 올린 원본 파일을 기억한다(버킷 버전 관리로 남아 있음): 수정 뒤에도 '원본 파일' 다운로드 (사용자 요청 11/18)
    if (t.source !== 'WIKI_EDIT' && t.s3_version_id) doc.original_upload = { key: quarantineKey(t), version_id: t.s3_version_id, filename: t.filename ?? `${t.title.slice(0, 80)}.${t.ext}` };
    else if (t.original_upload) doc.original_upload = t.original_upload;
    await store.putDoc(doc);
    // 이전 검사 결과를 DB 에서도 지운다: putDoc 은 '새 결과에 있는 단계'만 바꿔서, 비운 결과로는 옛 고칠 것이 남았다 (11/18 dev 시험 D2, 사용자 '고칠 것이 계속 남음')
    await store.clearFindings?.(doc.doc_id);
    await deps.putOriginal(quarantineKey(doc), md);
    return { doc_id: doc.doc_id, previous_doc_id: doc.previous_doc_id ?? null, new_version: doc.doc_id !== t.doc_id };
  };

  // 항목별 확인 '그대로 사용' (Fable 권고 11/18): 명시한 finding_ids 만, 사유 필수, 요청 1번·저장 1번(병렬 덮어쓰기 방지), 문서 단위 플래그 없음
  app.post('/v1/documents/:id/findings/ack', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub) throw new ApiError('FORBIDDEN', 'not the owner');
    const b = (await c.req.json().catch(() => ({}))) as { finding_ids?: unknown; reason?: unknown };
    const ids = [...new Set(Array.isArray(b.finding_ids) ? b.finding_ids.map(String) : [])].slice(0, 100);
    const reason = String(b.reason ?? '').trim().slice(0, 200);
    if (!ids.length) throw new ApiError('VALIDATION', '확인할 항목을 고르세요');
    if (!reason) throw new ApiError('VALIDATION', '그대로 사용하는 사유를 적어 주세요');
    const targets = ids.map((id) => d.findings.find((x) => x.finding_id === id));
    if (targets.some((f) => !f || !REVIEW_CODES.has(f.code))) throw new ApiError('NOT_FOUND', '확인할 수 있는 항목이 아닙니다');
    const at = new Date().toISOString(); const r = mask(reason, detectPii(reason));
    await store.putDoc({ ...d, findings: d.findings.map((x) => (ids.includes(x.finding_id) ? { ...x, acknowledged: { by: a.sub, at, reason: r } } : x)), updated_at: at });
    for (const id of ids) await audit(c, 'FINDING_ACK', `${d.doc_id}#${id}`);
    return c.json({ acked: ids });
  });

  // '의도한 삭제' 확인: 수정에서 지운 중요 문장을 올린 사람이 일부러 지웠다고 확인 (게시 요청 잠금 해제, 승인자에게는 보임)
  app.post('/v1/documents/:id/findings/:fid/ack', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub) throw new ApiError('FORBIDDEN', 'not the owner');
    const f = d.findings.find((x) => x.finding_id === c.req.param('fid'));
    if (!f || !['EDIT_REMOVED_KEY_SENTENCE', 'CLARIFY_NEEDED', 'KNOWHOW_CONFLICT'].includes(f.code)) throw new ApiError('NOT_FOUND', '확인할 수 있는 항목이 아닙니다');
    const at = new Date().toISOString();
    // 확인 필요 '해당 없음': 사유 한 줄 필수, 감사 기록, 승인 화면 '자세히'에 보인다 (계약 6.5)
    let details = f.details;
    if (f.code === 'CLARIFY_NEEDED') {
      const reason = String(((await c.req.json().catch(() => ({}))) as { reason?: unknown }).reason ?? '').trim().slice(0, 200);
      if (!reason) throw new ApiError('VALIDATION', '해당 없음 사유를 적어 주세요');
      details = { ...(f.details ?? {}), status: 'DISMISSED', dismiss_reason: mask(reason, detectPii(reason)) };
    }
    // 규정 충돌 '그대로 사용': 제안을 적용할 수 없을 때 사유 필수, 승인자 카드에 보인다 (사용자 결정 11/18, 규칙 2 완화)
    let reason: string | undefined;
    if (f.code === 'KNOWHOW_CONFLICT') {
      const r = String(((await c.req.json().catch(() => ({}))) as { reason?: unknown }).reason ?? '').trim().slice(0, 200);
      if (!r) throw new ApiError('VALIDATION', '그대로 사용하는 사유를 적어 주세요');
      reason = mask(r, detectPii(r));
    }
    await store.putDoc({ ...d, findings: d.findings.map((x) => (x === f ? { ...x, acknowledged: { by: a.sub, at, ...(reason ? { reason } : {}) }, ...(details ? { details } : {}) } : x)), updated_at: at });
    await audit(c, f.code === 'CLARIFY_NEEDED' ? 'CLARIFY_DISMISS' : f.code === 'KNOWHOW_CONFLICT' ? 'CONFLICT_KEEP' : 'FINDING_ACK', d.doc_id);
    return c.json({ ok: true });
  });

  // 확인 필요 답 넣기 (사용자 요청 11/18): 답 → AI 가 문장에 넣고 걸러서 before→after 를 돌려준다. 저장은 화면의 위키 편집기에서 사람이
  app.post('/v1/documents/:id/clarify/compose', async (c) => {
    const d = await loadDoc(c, c.req.param('id'));
    const b = (await c.req.json().catch(() => ({}))) as { answers?: { finding_id?: string; answer?: string }[] };
    const items = (b.answers ?? []).slice(0, 10).map((x, n) => {
      const f = d.findings.find((y) => y.finding_id === x.finding_id && y.code === 'CLARIFY_NEEDED');
      const det = (f?.details ?? {}) as { kind?: string; item?: string; before?: string; question?: string; span?: string };
      const answer = mask(String(x.answer ?? '').trim(), detectPii(String(x.answer ?? '')));
      return f && det.before && answer ? { n, finding_id: f.finding_id, page: (det as { page?: number }).page, before: det.before, question: det.question ?? '', answer, ...(det.span ? { span: det.span } : {}), cand: { kind: (det.kind ?? 'MISSING_VALUE') as ClarifyKind, item: det.item ?? '', before: det.before, question: det.question ?? '', in_procedure: false, query: '' } } : undefined;
    }).filter((x): x is NonNullable<typeof x> => !!x);
    if (!items.length) throw new ApiError('VALIDATION', '답을 적은 항목이 없습니다');
    const out = deps.composeClarify ? (await deps.composeClarify(composePrompt(items)).catch(() => ({ edits: [] }))).edits : [];
    const edits = items.map((q) => {
      const e = out.find((x) => x.n === q.n);
      // 모델이 없거나 실패하면 대상 낱말 자리에 답을 넣는다
      const ai = e?.ok !== false && e?.after?.trim() && keepsRest(q.before, q.span, e.after.trim()) ? e.after.trim() : '';
      // 담당자는 모델이 이름을 빼고 넣는다. 모델이 없거나 실패하면 담당자 답은 그대로 넣지 않는다(이름이 섞였을 수 있음, Fable C)
      const after = ai || (q.cand.kind === 'VAGUE_ACTOR' ? '' : fallbackAfter(q.before, q.cand.item, q.span, q.answer));
      const ok = e?.ok !== false && !!after && safeSuggestion(q.cand, { value: q.answer, after }, false);
      return { finding_id: q.finding_id, before: figRefs(q.before, q.page), after: figRefs(mask(after, detectPii(after)), q.page), ok, ...(ok && e?.reason ? { note: e.reason } : {}), ...(e?.no_change ? { no_change: true } : {}), ...(ok ? {} : { reason: e?.ok === false ? (e.reason ?? '이 답은 넣을 수 없습니다') : !after ? 'AI가 답을 넣지 못했습니다. 잠시 뒤 다시 눌러 주세요.' : '개인정보(전화번호·이메일 등)가 들어갔거나 문장이 바뀌지 않았습니다' }) };
    });
    await audit(c, 'CLARIFY_COMPOSE', d.doc_id);
    return c.json({ edits });
  });

  // 위키 수정 요청 (사용자 결정 11/18): 게시 문서를 읽을 수 있는 사람 누구나. AI 가 적절성·초안을 붙여 관리자에게. 게시는 관리자 반영(새 버전) → AI 검사 → 사람 승인
  app.post('/v1/documents/:id/change-requests', async (c) => {
    const a = c.get('actor');
    const d = await store.getDoc(c.req.param('id'));
    if (!d || d.lifecycle !== 'PUBLISHED' || !canRead(a, d.acl_groups)) throw new ApiError('NOT_FOUND', 'document not found');
    const b = (await c.req.json().catch(() => ({}))) as { before?: unknown; request?: unknown };
    const before = String(b.before ?? '').trim().slice(0, 500), raw = String(b.request ?? '').trim().slice(0, 500);
    if (!before || !raw) throw new ApiError('VALIDATION', '고칠 부분과 고칠 내용을 모두 적어 주세요');
    const text = await editText(d.doc_id);
    const at = text.indexOf(before);
    if (at < 0) throw new ApiError('VALIDATION', '선택한 부분을 문서에서 찾지 못했습니다. 문서 글을 그대로 골라 주세요');
    const request = mask(raw, detectPii(raw));
    const j = deps.judgeChange ? await deps.judgeChange(changePrompt(before, request, text.slice(Math.max(0, at - 1500), at + before.length + 1500))).catch(() => undefined) : undefined;
    const after = j?.after?.trim();
    const okAfter = j?.verdict === 'APPROPRIATE' && after && after !== before && !detectPii(after).length ? after : undefined;
    const cr: ChangeRequest = { id: newId.fnd().replace('fnd_', 'cr_'), by: a.sub, at: new Date().toISOString(), before, request,
      verdict: j ? (j.verdict === 'APPROPRIATE' && !okAfter ? 'UNKNOWN' : j.verdict) : 'UNKNOWN', ...(okAfter ? { after: okAfter } : {}), ai_reason: j?.reason?.slice(0, 300) ?? 'AI 판단을 받지 못했습니다', status: 'OPEN' };
    const cur = (await store.getDoc(d.doc_id))!;
    await store.putDoc({ ...cur, change_requests: [...(cur.change_requests ?? []), cr].slice(-50) });
    await audit(c, 'CHANGE_REQUEST', d.doc_id);
    return c.json({ id: cr.id, verdict: cr.verdict, after: cr.after ?? null, ai_reason: cr.ai_reason }, 201);
  });
  app.get('/v1/admin/change-requests', async (c) => {
    need(c, APPROVERS);
    const items = (await store.listDocs()).flatMap((d) => (d.change_requests ?? []).filter((r) => r.status === 'OPEN').map((r) => ({ ...r, doc_id: d.doc_id, title: d.title, published: d.lifecycle === 'PUBLISHED' })))
      .sort((x, y) => y.at.localeCompare(x.at));
    return c.json({ items });
  });
  app.post('/v1/admin/change-requests/:doc/:id', async (c) => {
    need(c, APPROVERS);
    const a = c.get('actor');
    const b = (await c.req.json().catch(() => ({}))) as { decision?: unknown; reason?: unknown; after?: unknown };
    const d = await store.getDoc(c.req.param('doc'));
    const cr = d?.change_requests?.find((r) => r.id === c.req.param('id'));
    if (!d || !cr || cr.status !== 'OPEN') throw new ApiError('NOT_FOUND', '처리할 수 있는 수정 요청이 아닙니다');
    const at = new Date().toISOString(); const reason = String(b.reason ?? '').trim().slice(0, 200);
    let next: Partial<ChangeRequest>;
    if (b.decision === 'REJECT') {
      if (!reason) throw new ApiError('VALIDATION', '반려 사유를 적어 주세요');
      next = { status: 'REJECTED', decision_reason: mask(reason, detectPii(reason)) };
    } else if (b.decision === 'APPLY') {
      const after = String(b.after ?? cr.after ?? '').trim();
      if (!after || after === cr.before) throw new ApiError('VALIDATION', '바꿀 문장을 적어 주세요');
      if (detectPii(after).length) throw new ApiError('VALIDATION', '개인정보가 들어간 문장은 넣을 수 없습니다');
      const text = await editText(d.doc_id);
      if (!text.includes(cr.before)) throw new ApiError('CONFLICT', '문서가 바뀌어 요청한 부분을 찾지 못했습니다');
      // 관리자가 승인한 변경: 바뀐 원래 문장의 '중요 문장 삭제'는 이 결정으로 확인된 것으로 잇는다 (재검사에서 다시 막지 않음)
      const acks = sentences(cr.before).map((x) => ackItem('EDIT_REMOVED_KEY_SENTENCE', x.slice(0, 160), a.sub, '수정 요청 반영(관리자 승인)'));
      const r = await editDoc(a, d.doc_id, text.replace(cr.before, after), acks);
      next = { status: 'APPLIED', new_doc_id: r.doc_id, ...(reason ? { decision_reason: mask(reason, detectPii(reason)) } : {}) };
    } else throw new ApiError('VALIDATION', 'decision 은 APPLY 또는 REJECT');
    const cur = (await store.getDoc(d.doc_id))!;
    await store.putDoc({ ...cur, change_requests: (cur.change_requests ?? []).map((r) => (r.id === cr.id ? { ...r, ...next, decided_by: a.sub, decided_at: at } : r)) });
    await audit(c, b.decision === 'REJECT' ? 'CHANGE_REQUEST_REJECT' : 'CHANGE_REQUEST_APPLY', d.doc_id);
    return c.json({ ok: true, new_doc_id: next.new_doc_id ?? null });
  });

  app.post('/v1/documents/:id/analyze', async (c) => {
    const a = c.get('actor'); // 규칙 1: 로그인한 사람 누구나 (사용자 결정 11/17)
    const d = await loadDoc(c, c.req.param('id'));
    if (d.owner !== a.sub) throw new ApiError('FORBIDDEN', 'not the owner');
    const head = await deps.headObject(quarantineKey(d));
    if (!head) throw new ApiError('CONFLICT', 'file not uploaded');
    // 이미 고정된 검사 버전이 있으면 바꾸지 않는다 (type-detection이 검사한 버전과 다른 버전이 끼어드는 것 방지)
    const doc = { ...d, s3_version_id: d.s3_version_id ?? head.s3_version_id, updated_at: new Date().toISOString(),
      // 검토 중 재분석: 결정은 잇고(Fable D) 결과는 새로. 새 실행 id 로 — 같은 id 는 '이미 끝난 실행'이라 다시 돌지 않아 지운 결과가 비어 남았다 (11/18 prod 결함 ⑤)
      ...(d.lifecycle === 'IN_REVIEW' ? { review_carry: makeCarry(await editText(d.doc_id), d.findings, !!d.knowhow_validation), findings: [], lifecycle: 'QUARANTINED' as const, workflow_id: newId.wf() } : {}) };
    await store.putDoc(doc);
    if (d.lifecycle === 'IN_REVIEW') await store.clearFindings?.(doc.doc_id); // 처음 분석·실패 재시도는 앞 단계(형식 검사) 결과를 지우지 않는다
    await deps.startWorkflow(doc);
    await audit(c, 'ANALYZE', d.doc_id);
    return c.json({ workflow_id: doc.workflow_id }, 202);
  });

  /** 사람이 반려한 사유 (작성자 화면 '승인자가 반려했습니다: …', 엔드유저 11/20). 출처 검토 반려 → 결재 반려 최신. 개인정보는 가림 */
  const rejectionReason = async (d: DocumentRecord) => {
    if (d.authority_status !== 'REJECTED') return null;
    const r = d.source_review?.reason ?? (await store.listApprovals('REJECTED')).filter((x) => x.doc_id === d.doc_id)
      .sort((x, y) => (y.decided_at ?? '').localeCompare(x.decided_at ?? ''))[0]?.reason;
    return r ? mask(r, detectPii(r)) : null;
  };
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
    // 고칠 본문 = 정리본(없으면 원문 글) — 위키 편집기·확인 필요 적용과 같은 기준 (before 가 이 글에 있어야 바꿀 수 있다)
    const text = d.lifecycle === 'IN_REVIEW' && d.owner === a.sub ? await editText(d.doc_id) : undefined;
    // 모델이 뽑은 문장과 본문이 공백만 다르면('1억원'↔'1 억원') 본문 쪽 글자로 돌려준다: [제안대로 고치기]가 본문에서 찾을 수 있게 (11/19 팀 계정 C3)
    const inText = (ex: string) => (!text || !ex || text.includes(ex) ? ex : looseFind(text, ex) ?? ex);
    const fixes = d.findings.filter((f) => FIX_CODES.has(f.code)).map((f) => {
      const ex = f.location?.excerpt ?? '';
      const st = [...sugg.keys()].find((s) => s.includes(ex.slice(0, 40)) || ex.includes(s.slice(0, 40)));
      return { finding_id: f.finding_id, code: f.code, message: f.user_message ?? f.message, excerpt: inText(st ?? ex), suggestion: st ? sugg.get(st) ?? null : null, fix_hint: f.fix_hint ?? null, acknowledged: !!f.acknowledged, ack_reason: f.acknowledged?.reason ?? null };
    });
    const workflow_failure = d.workflow_id && d.lifecycle !== 'PUBLISHED' && deps.workflowFailure ? await deps.workflowFailure(d.workflow_id) : undefined;
    const page_summaries = [...(await pageMetas(deps, d.doc_id))].map(([page_index, m]) => ({ page_index, ...m })).sort((x, y) => x.page_index - y.page_index);
    const suggestions = d.findings.filter((f) => f.code === 'REFERENCE_SUGGESTION' && f.details).map((f) => ({ finding_id: f.finding_id, page: f.location?.page ?? null, ...(f.details as Record<string, unknown>) }));
    // 확인 필요 (계약 6.5): 질문·원문·제안·잠금 여부. 화면이 항목별 적용을 모아 /edit 한 번
    // 항목별 확인(개인정보·비밀값): 쪽·사유·처리 여부
    const reviews = d.findings.filter((f) => REVIEW_CODES.has(f.code) && f.severity === 'MEDIUM').map((f) => ({ finding_id: f.finding_id, code: f.code, page: f.location?.page ?? (/^page:(\d+)/.exec(f.evidence_ref ?? '')?.[1] ? Number(/^page:(\d+)/.exec(f.evidence_ref)![1]) : null), message: f.user_message ?? f.message, fix_hint: f.fix_hint ?? null, acknowledged: !!f.acknowledged, reason: f.acknowledged?.reason ?? null }));
    // 확인 필요 (게시 잠금 아님): 외부 법령과 다름·문서가 든 근거 조문과 다름. 수정 제안은 fix_hint (엔드유저 MX-002 11/20: 화면에 안 보임)
    const checks = d.findings.filter((f) => CHECK_CODES.has(f.code)).map(checkView);
    const clarify = d.findings.filter((f) => f.code === 'CLARIFY_NEEDED' && f.details).map((f) => ({ finding_id: f.finding_id, blocking: isOpenFix(f), severity: f.severity, ...clarifyView(f.details as Record<string, unknown>) }));
    return c.json({ fixes: fixes.filter((x) => x.code !== 'CLARIFY_NEEDED'), clarify, reviews, checks, rejection_reason: await rejectionReason(d), suggestions, ...(text !== undefined ? { text } : {}), source: d.source ?? 'UPLOAD', workflow_failure, page_summaries, doc_id: d.doc_id, title: d.title, title_source: d.title_source, doc_date: d.doc_date, doc_dates: d.doc_dates,
      can_edit: d.owner === a.sub && ['QUARANTINED', 'IN_REVIEW'].includes(d.lifecycle), previous_doc_id: d.previous_doc_id, version_no: d.version_no, version: d.previous_doc_id ? await versionDiff(a, d).catch(() => null) : null, lifecycle: d.lifecycle, trust_gate_result: d.trust_gate_result, authority_status: d.authority_status, freshness: d.freshness, classification: d.classification, findings: d.findings.map(plainFinding), knowhow_validation: d.knowhow_validation });
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
    let apr;
    try { apr = await submitForApproval(store, d, a.sub); }
    catch (e) { await audit(c, 'SUBMIT_REJECTED', `${d.doc_id}#open=${d.findings.filter(isOpenFix).length}`).catch(() => {}); throw e; } // 거절도 남긴다 (11/18: 결재함 0 원인 추적)
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
    // 종류가 바뀌면 다시 검사한다: 노하우는 규정 비교, 규정은 공식 원본 대조가 종류에 따라 달라진다 (11/18 prod 시험: 매뉴얼→노하우로 바꿔도 규정 비교 없이 게시 요청 가능했음)
    let reanalyzed = false;
    if (prev?.document_type !== b.document_type && deps.startWorkflow) {
      const cur = (await store.getDoc(d.doc_id))!;
      const next = { ...cur, review_carry: makeCarry(await editText(d.doc_id), cur.findings, !!cur.knowhow_validation && prev?.document_type === 'KNOWHOW'), findings: [], lifecycle: 'QUARANTINED' as const, workflow_id: newId.wf(), updated_at: new Date().toISOString() };
      await store.putDoc(next);
      await store.clearFindings?.(d.doc_id);
      await deps.startWorkflow(next);
      reanalyzed = true;
    }
    return c.json({ document_type: b.document_type, reanalyzed });
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

  // 관리 > Agent 평가 (docs/02 6장 화면 08, 프론트엔드팀 요청 11/20): 최근 평가 결과 + 비인가 호출 거부 기록.
  // 평가 결과는 실행기가 감사 기록에 남긴 마지막 EVALUATION_RUN (detail.items·failures). 없으면 run_at=null
  app.get('/v1/admin/evaluations', async (c) => {
    need(c, APPROVERS);
    if (!store.listAudit) return c.json({ run_at: null, items: [], failures: [], denials: [] });
    const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
    const [run] = await store.listAudit({ since: ago(30), action: 'EVALUATION_RUN', limit: 1 });
    const denied = await store.listAudit({ since: ago(7), result: 'DENIED', limit: 50 });
    // Gateway 로그를 못 읽어도 화면은 API 거부만으로 보인다
    const gw = deps.gatewayDenials ? await deps.gatewayDenials(ago(7)).catch(() => []) : [];
    const arr = (v: unknown) => (Array.isArray(v) ? v as Record<string, unknown>[] : []);
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const num = (v: unknown) => (typeof v === 'number' ? v : 0);
    return c.json({
      run_at: run?.at ?? null,
      items: arr(run?.detail?.items).map((i) => ({ key: str(i.key), label: str(i.label), target: str(i.target), passed: num(i.passed), total: num(i.total), pass: i.pass === true })),
      failures: arr(run?.detail?.failures).slice(0, 100).map((f) => ({ key: str(f.key), case_id: str(f.case_id), reason: str(f.reason).slice(0, 300) })),
      // 거부 기록에는 사용자 식별값(sub)을 내보내지 않는다. 역할만
      denials: [...denied.map((e) => ({ at: e.at, role: (Array.isArray(e.detail?.roles) ? (e.detail!.roles as string[]) : []).join(','), tool: e.action, reason: str(e.detail?.reason), trace_id: e.trace_id, source: 'API' })),
        ...gw.map((g) => ({ ...g, source: 'GATEWAY' }))].sort((x, y) => y.at.localeCompare(x.at)).slice(0, 50),
      trace_url: 'https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#gen-ai-observability/agent-core',
    });
  });

  // 변경 영향 → 수정 초안 (docs/02 데모 04, AI팀 계약 합의 11/20). 서버가 trace_impact 를 다시 불러 영향 근거를 확인한다(클라이언트 근거 불신).
  // 초안은 위키 수정 요청(OPEN)으로만 저장 → 결재함 [반영] → 새 버전 → AI 검사 → 사람 승인. 자동 수정·게시 없음
  app.post('/v1/admin/impact/draft', async (c) => {
    const a = need(c, ['REG_APPROVER']);
    const b = (await c.req.json().catch(() => ({}))) as { law?: unknown; doc_id?: unknown };
    const law = String(b.law ?? '').trim(), doc_id = String(b.doc_id ?? '');
    if (!law || law.length > 200 || !/^doc_[0-9A-Z]{26}$/.test(doc_id)) throw new ApiError('VALIDATION', 'law(1~200자)·doc_id 필요');
    if (!deps.traceImpact) throw new ApiError('NOT_FOUND', '영향 분석 도구가 연결되지 않았습니다');
    type Ev = { cited_provision_id: string; evidence_span: string; change: { path: string; kind: string; old_text: string; new_text: string } };
    const r = await deps.traceImpact({ law }, c.get('token')).catch(() => { throw new ApiError('NOT_FOUND', '비교할 이전 개정본이 없거나 등록되지 않은 규정입니다'); }) as { law_id?: string; impacted?: { doc_id: string; evidence?: Ev[] }[] };
    const hit = r.impacted?.find((i) => i.doc_id === doc_id);
    // 초안 인용 '(제15조제1항)'에 규정 이름을 붙이도록 Registry 이름을 넘긴다 (사용자 피드백 11/20)
    const lawName = r.law_id ? (await store.listDocs()).find((x) => x.law_id === r.law_id && x.law_name)?.law_name : undefined;
    const d = await store.getDoc(doc_id);
    if (!hit || !d || d.lifecycle !== 'PUBLISHED' || !canRead(a, d.acl_groups)) throw new ApiError('NOT_FOUND', '이 규정 개정의 영향 문서가 아닙니다');
    const text = await editText(doc_id);
    const at = new Date().toISOString();
    const open = (d.change_requests ?? []).filter((x) => x.status === 'OPEN' && x.source === 'IMPACT');
    const out: ChangeRequest[] = [];
    const made: ChangeRequest[] = [];
    for (const ev of (hit.evidence ?? []).slice(0, 3)) {
      const span = ev.evidence_span.trim().slice(0, 500);
      const before = text.includes(span) ? span : looseFind(text, span);
      const dup = open.find((x) => x.before === (before ?? span) && x.path === ev.change.path);
      if (dup) { out.push(dup); continue; }
      const i = before ? text.indexOf(before) : -1;
      const j = before && deps.draftImpact ? await deps.draftImpact({ before, old_clause: ev.change.old_text, new_clause: ev.change.new_text, path: ev.change.path, kind: ev.change.kind, ...(lawName ? { law_name: lawName } : {}),
        context: text.slice(Math.max(0, i - 1500), i + before.length + 1500) }).catch(() => undefined) : undefined;
      // 마지막 방어: AI팀 checkImpactDraft 를 거친 값이어도 PII·무변경이면 버린다
      const after = j?.verdict === 'APPROPRIATE' && j.after?.trim() && j.after.trim() !== before && !detectPii(j.after).length ? j.after.trim() : undefined;
      const cr: ChangeRequest = { id: newId.fnd().replace('fnd_', 'cr_'), by: 'system:impact', at, before: before ?? span,
        request: mask(`근거 조문 개정(${ev.change.path}, ${ev.change.kind}): ${ev.change.old_text.slice(0, 200)} → ${ev.change.new_text.slice(0, 200)}`, detectPii(ev.change.new_text + ev.change.old_text)),
        verdict: !before ? 'UNKNOWN' : j ? (j.verdict === 'APPROPRIATE' && !after ? 'UNKNOWN' : j.verdict) : 'UNKNOWN', ...(after ? { after } : {}),
        ai_reason: !before ? '본문에서 근거 문장을 찾지 못했습니다' : j?.reason?.slice(0, 300) ?? 'AI 초안을 받지 못했습니다',
        status: 'OPEN', source: 'IMPACT', law, path: ev.change.path, requested_by: a.sub };
      out.push(cr); made.push(cr);
    }
    if (!out.length) throw new ApiError('NOT_FOUND', '영향 근거가 없습니다');
    const cur = (await store.getDoc(doc_id))!;
    const provisions = [...new Set((hit.evidence ?? []).map((e) => e.cited_provision_id))];
    await store.putDoc({ ...cur, change_requests: [...(cur.change_requests ?? []), ...made].slice(-50),
      // 영향 문서는 재검토 표시 (trace_impact recommended_freshness). 이미 표시됐으면 이유를 덮지 않는다
      ...(cur.freshness === 'CURRENT' ? { freshness: 'REVIEW_REQUIRED' as const, freshness_reason: { law_id: r.law_id ?? law, law_name: law, cited_revision: '', current_revision: '', effective_from: '', provisions, at } } : {}), updated_at: at });
    if (made.length) await audit(c, 'IMPACT_DRAFT', doc_id);
    return c.json({ items: out.map((x) => ({ id: x.id, doc_id, before: x.before, after: x.after ?? null, verdict: x.verdict, ai_reason: x.ai_reason, path: x.path })) }, made.length ? 201 : 200);
  });

  // 재검토 문서 '변경 없이 유효' (Change Impact 재승인 흐름): 결재자가 개정 조문과 대조해 고칠 것이 없다고 확인 → CURRENT.
  // 사람만 한다. 같은 개정판으로는 다시 표시하지 않고, 열린 영향 초안은 이 사유로 닫는다. 본문은 바꾸지 않는다
  app.post('/v1/documents/:id/freshness/confirm', async (c) => {
    const a = need(c, ['REG_APPROVER']);
    const raw = String(((await c.req.json().catch(() => ({}))) as { reason?: unknown }).reason ?? '').trim().slice(0, 300);
    if (!raw) throw new ApiError('VALIDATION', '유효하다고 본 이유를 적어 주세요');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.lifecycle !== 'PUBLISHED' || d.freshness !== 'REVIEW_REQUIRED') throw new ApiError('CONFLICT', '재검토 중인 게시 문서가 아닙니다');
    if (d.owner === a.sub && !hasRole(a, ['PLATFORM_OPERATOR'])) throw new ApiError('FORBIDDEN', 'self confirmation is not allowed'); // 자기 결재와 같은 규칙 (11/18)
    const reason = mask(raw, detectPii(raw)); const at = new Date().toISOString();
    const law_id = d.freshness_reason?.law_id ?? '';
    // 확인 기준 개정판: 지금 시행 중인 게시본 (재검토 이유에 없으면 문서 목록에서)
    const revision = d.freshness_reason?.current_revision || currentRevisions(await store.listDocs()).get(law_id)?.revision_id || '';
    await store.putDoc({ ...d, freshness_reason: undefined, freshness: 'CURRENT', updated_at: at,
      freshness_confirmed: [...(d.freshness_confirmed ?? []), { law_id, revision, by: a.sub, at, reason }].slice(-20),
      change_requests: (d.change_requests ?? []).map((r) => (r.status === 'OPEN' && r.source === 'IMPACT' ? { ...r, status: 'REJECTED' as const, decided_by: a.sub, decided_at: at, decision_reason: `변경 없이 유효: ${reason}` } : r)) });
    await audit(c, 'FRESHNESS_CONFIRMED', d.doc_id);
    return c.json({ doc_id: d.doc_id, freshness: 'CURRENT', law_id, revision });
  });

  // ---- 출처 불일치 (위조 의심) 처리: 승인 대상이 아니므로 별도 큐 ----
  // 결재함 '게시 요청 전' (사용자 결정 11/18 권고 ①): 작성자가 검토 중인 문서 — 게시 요청을 눌러야 결재할 수 있다
  app.get('/v1/admin/in-review', async (c) => {
    need(c, APPROVERS);
    const me = c.get('actor').sub;
    const items = (await store.listDocs()).filter((d) => d.lifecycle === 'IN_REVIEW' || d.lifecycle === 'QUARANTINED')
      .sort((x, y) => y.updated_at.localeCompare(x.updated_at)).slice(0, 50)
      .map((d) => ({ doc_id: d.doc_id, title: d.title, lifecycle: d.lifecycle, own: d.owner === me, open: d.findings.filter(isOpenFix).length, updated_at: d.updated_at,
        // 출처 불일치면 게시 요청이 409 → '게시 요청만 남음'이 아니라 '출처 확인 대기' (프론트 요청 11/20)
        source_mismatch: hasSourceMismatch(d) && !d.source_review }));
    return c.json({ items });
  });

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
      // 올린 사람이 '그대로 사용'한 규정 충돌·재검사에서 새로 나온 충돌은 승인자가 판단 (사용자 결정 11/18) → 카드에 보인다
      const kept = (d?.findings ?? []).filter((f) => f.code === 'KNOWHOW_CONFLICT' && f.acknowledged).map((f) => ({ text: (f.location?.excerpt ?? '').slice(0, 120), reason: f.acknowledged!.reason ?? '', system: f.acknowledged!.by.startsWith('system:') }));
      // 승인자도 '확인 필요'를 본다 (틀린 매뉴얼 승인 방지, 11/20)
      const checks = (d?.findings ?? []).filter((f) => CHECK_CODES.has(f.code));
      return { ...r, task_token: undefined, own: r.author_sub === c.get('actor').sub, title: d?.title, lifecycle: d?.lifecycle, workflow_failure: failure, summary_line, source: d?.source ?? 'UPLOAD', kept,
        checks_count: checks.length, checks: checks.slice(0, 5).map((f) => ({ code: f.code, text: (f.location?.excerpt ?? '').slice(0, 120), message: f.user_message ?? f.message })),
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
    // 자기 결재: 관리자(PLATFORM_OPERATOR)만 허용 — 사용자 결정 11/18("MVP라서 상관없어", 사용자 직접 확인). 그 밖의 결재자는 금지 유지
    const self = apr.author_sub === a.sub;
    if (self && !hasRole(a, ['PLATFORM_OPERATOR'])) throw new ApiError('FORBIDDEN', 'self approval is not allowed');
    const decided = await store.decideApproval(apr.approval_id, { status, approver_sub: a.sub, ...(a.username ? { approver_name: a.username } : {}), reason: b.reason, ...bind, ...(self ? { self_approved: true } : {}) });
    if (self) await audit(c, 'SELF_APPROVAL', apr.approval_id);
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
  // 쪽마다 1부터인 '(그림 k)'를 '(그림 쪽-k)'로: 위키 수정본은 한 쪽이 되므로 그림을 쪽까지 가리켜야 한다 (11/18 사진 사라짐)
  const editText = async (id: string) => {
    const ps = deps.pages ? (await deps.pages(id).catch(() => [])).sort((x, y) => x.page - y.page) : [];
    const st = deps.structuredPages ? await deps.structuredPages(id).catch(() => new Map<number, { markdown: string }>()) : new Map<number, { markdown: string }>();
    return ps.map((p) => figRefs(st.get(p.page)?.markdown ?? p.text, p.page + 1)).join('\n\n');
  };
  /** 그림을 보여도 되는 쪽: 그림 개인정보 확인이 남지 않은 쪽 (1부터) */
  const figurePages = (t: DocumentRecord) => {
    const open = new Set(t.findings.filter((f) => REVIEW_CODES.has(f.code) && f.severity === 'MEDIUM' && !f.acknowledged).map((f) => f.location?.page ?? Number(/^page:(\d+)/.exec(f.evidence_ref ?? '')?.[1] ?? NaN)));
    return Array.from({ length: 300 }, (_, i) => i + 1).filter((n) => !open.has(n));
  };
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
    const rt = await store.ratings?.(c.get('actor').sub);
    return c.json({ items: items.map((i) => ({ ...i, ...ratingOf(rt?.get(i.doc_id)) })) });
  });
  // 원본 보기 (사용자 요청 11/17 '원본 내용 그대로 png, 쪽별 파일 presigned URL'): 모든 쪽, 개인정보만 가린 이미지.
  // 가리지 않은 원본은 올린 사람·결재자의 원본 다운로드로만. URL 은 로그·감사에 남기지 않는다
  app.get('/v1/library/:id/pages', async (c) => {
    const vis = await visibleDocs(c.get('actor'));
    const d = await libraryDoc(c, vis);
    if (!deps.presignView || !deps.viewPageList) return c.json({ items: [] });
    const pages = await deps.viewPageList(d.doc_id);
    const items = await Promise.all(pages.slice(0, 300).map(async (i) => ({ page: i + 1, url: await deps.presignView!(`${d.doc_id}/masked/view/${String(i).padStart(4, '0')}.png`) })));
    return c.json({ items, expires_in: 300 });
  });
  // 보관함 쪽 이미지: 문서를 볼 수 있는 사람이면 누구나 (개인정보를 가린 masked/pages 만)
  app.get('/v1/library/:id/pages/:page/image', async (c) => {
    const vis = await visibleDocs(c.get('actor'));
    const d = await libraryDoc(c, vis);
    const n = Number(c.req.param('page'));
    if (!Number.isInteger(n) || n < 1 || n > 2000) throw new ApiError('VALIDATION', 'page: 1 이상 정수');
    const png = deps.pageImage ? await deps.pageImage(d.doc_id, n - 1).catch(() => undefined) : undefined;
    if (!png) throw new ApiError('NOT_FOUND', 'page image not found');
    return new Response(new Blob([new Uint8Array(png)]), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=300' } });
  });
  // 외부 법령 최신본 참고 (미검증). 첫 조회는 Browser라 수십 초 → 상세 본문과 따로 부른다
  app.get('/v1/library/:id/external-laws', async (c) => {
    const vis = await visibleDocs(c.get('actor'));
    const d = await libraryDoc(c, vis);
    if (!deps.pages || !deps.externalLaws) return c.json({ items: [], note: '외부 법령 조회가 설정되지 않았습니다' });
    const laws = groupLaws(await deps.externalLaws((await deps.pages(d.doc_id)).map((p) => p.text).join('\n')));
    // 법령당 1건, 인용 조문(조·항) 전부. clause·result·error 는 첫 조문 값 (하위 호환). 조회는 조·항 단위 (법령 페이지는 regulation-server 캐시)
    const fetch = async (law_name: string, clause?: string) => {
      try { return { result: deps.officialLaw ? await deps.officialLaw({ law_name, ...(clause ? { clause } : {}) }, c.get('token')) : null }; }
      catch (e) { return { result: null, error: (e as Error).name }; }
    };
    // Browser 세션 폭증 방지 (인프라 리뷰 11/20): 법령 3개씩, 법령마다 첫 조문을 먼저 받아 페이지 캐시를 채운 뒤 나머지 조문을 병렬로
    const one = async (g: (typeof laws)[number]) => {
      const [c0, ...more] = g.clauses;
      const first = await fetch(g.law_name, c0?.clause);
      const rest = await Promise.all(more.map(async (x) => ({ ...x, ...(await fetch(g.law_name, x.clause)) })));
      return { law_name: g.law_name, ...(c0 ? { clause: c0.clause } : {}), ...first, clauses: c0 ? [{ ...c0, ...first }, ...rest] : [] };
    };
    const items: Awaited<ReturnType<typeof one>>[] = [];
    for (let i = 0; i < laws.length; i += 3) items.push(...await Promise.all(laws.slice(i, i + 3).map(one)));
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
    // 위키에서 고친 문서는 원본이 md 로 바뀐다: 파일 이름 확장자를 실제 내용에 맞춘다 (전에는 '….pdf' 이름으로 md 가 내려와 열리지 않았다, 11/18)
    // ?kind=original: 위키 수정 전 처음 올린 파일 (올린 파일 형식 그대로, 사용자 요청 11/18)
    if (c.req.query('kind') === 'original' && d.original_upload) {
      const o = d.original_upload;
      const url = await deps.presignGet(o.key, o.version_id, o.filename);
      await audit(c, 'DOCUMENT_DOWNLOAD', d.doc_id);
      return c.json({ url, filename: o.filename });
    }
    const base = (d.filename ?? d.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)).replace(/\.[^.]+$/, '');
    const filename = `${base}${d.source === 'WIKI_EDIT' ? '_수정본' : ''}.${d.ext}`;
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

  // 게시 문서 '고칠 곳' 해당 없음: 올린 사람·결재자만, 사유 필수·개인정보 가림, 감사 기록. 본문은 바꾸지 않는다 (사용자 요청 11/19)
  app.post('/v1/library/:id/marks/dismiss', async (c) => {
    const a = c.get('actor');
    const d = await loadDoc(c, c.req.param('id'));
    if (d.lifecycle !== 'PUBLISHED') throw new ApiError('CONFLICT', '게시 전 문서는 검토 화면에서 처리합니다');
    if (d.owner !== a.sub && !hasRole(a, [...APPROVERS, 'PLATFORM_OPERATOR'])) throw new ApiError('FORBIDDEN', '올린 사람이나 결재자만 해당 없음으로 둘 수 있습니다');
    const b = (await c.req.json().catch(() => ({}))) as { key?: unknown; reason?: unknown };
    const key = String(b.key ?? '').slice(0, 400); const reason = String(b.reason ?? '').trim().slice(0, 200);
    if (!key) throw new ApiError('VALIDATION', 'key 가 필요합니다');
    if (!reason) throw new ApiError('VALIDATION', '해당 없음 사유를 적어 주세요');
    const at = new Date().toISOString();
    const x = { key, reason: mask(reason, detectPii(reason)), by: a.sub, at };
    await store.putDoc({ ...d, mark_dismissals: [...(d.mark_dismissals ?? []).filter((y) => y.key !== key), x], updated_at: at });
    await audit(c, 'MARK_DISMISSED', d.doc_id);
    return c.json({ ok: true, reason: x.reason });
  });
  app.get('/v1/library/:id', async (c) => {
    const a = c.get('actor');
    const vis = await visibleDocs(a);
    const d = await libraryDoc(c, vis, true);
    const pages = deps.pages ? (await deps.pages(d.doc_id).catch(() => [])).sort((x, y) => x.page - y.page) : [];
    // 해당 없음으로 둔 곳은 '참고'(LOW)로 내리고 사유를 보인다 (사용자 요청 11/19). key 는 화면이 해당 없음 요청에 쓴다
    const dis = new Map((d.mark_dismissals ?? []).map((x) => [x.key, x]));
    const marks = (deps.marks && pages.length ? await deps.marks(pages, d) : []).map((m) => { const key = markKey(m); const x = dis.get(key);
      return x ? { ...m, key, severity: 'LOW' as const, reason: `해당 없음으로 둠: ${x.reason}` } : { ...m, key }; });
    const sum = new Map((d.page_summaries ?? []).map((p) => [p.page, p.summary]));
    const meta = await pageMetas(deps, d.doc_id); // 쪽 요약 단계 결과가 있으면 Classify 요약보다 우선
    const lawNames = vis.flatMap((x) => (x.law_name ? [x.law_name] : [])); // 인용 조문을 등록 규정 이름과 묶기
    const figUrls = new Map<number, { k: number | string; url: string | null }[]>(await Promise.all(pages.map(async (p) => [p.page, await Promise.all((p.figure_keys ?? []).map(async (key, k) =>
      ({ k: k + 1, url: key && deps.presignView ? await deps.presignView(key).catch(() => null) : null })))] as const)));
    // 위키 수정본: '(그림 쪽-k)'는 원래 문서의 잘라 둔 그림 (개인정보 확인을 마친 쪽만)
    if (d.source === 'WIKI_EDIT' && d.figure_source && deps.figureKeys && deps.presignView && pages[0]) {
      const fk = await deps.figureKeys(d.figure_source.doc_id).catch(() => new Map<string, string>());
      const okPages = new Set(d.figure_source.pages);
      const extra = await Promise.all([...fk].filter(([pk]) => okPages.has(Number(pk.split('-')[0]))).map(async ([pk, key]) => ({ k: pk, url: await deps.presignView!(key).catch(() => null) })));
      figUrls.set(pages[0].page, [...(figUrls.get(pages[0].page) ?? []), ...extra]);
    }
    const structuredMap = deps.structuredPages ? await deps.structuredPages(d.doc_id).catch(() => new Map<number, { markdown: string; source: 'TEXT' | 'VISION' | 'AI' }>()) : new Map<number, { markdown: string; source: 'TEXT' | 'VISION' | 'AI' }>();
    const approval = d.lifecycle === 'PUBLISHED' ? [...await store.listApprovals('USED'), ...await store.listApprovals('APPROVED')].filter((x) => x.doc_id === d.doc_id).sort((x, y) => (y.decided_at ?? '').localeCompare(x.decided_at ?? ''))[0] : undefined;
    const base = card(d, vis);
    const pendingApproval = d.lifecycle === 'PENDING_APPROVAL' && hasRole(a, APPROVERS) ? (await store.listApprovals('PENDING')).find((x) => x.doc_id === d.doc_id) : undefined;
    const myRt = (await store.ratings?.(a.sub))?.get(d.doc_id);
    return c.json({
      ...base,
      ...ratingOf(myRt), my_stars: myRt?.mine ?? null,
      rejection_reason: d.owner === a.sub || hasRole(a, APPROVERS) ? await rejectionReason(d) : null,
      ...await (async () => { const cv = await categoryView(); return { category_path: cv.pathOf(d.doc_id), category_id: cv.docs.get(d.doc_id) ?? null }; })(),
      claims: await docClaimsView(d),
      // 참조 확인(6.4) 참고 제안: 웹에서 확인한 주소. 근거 인용 불가, '정리본에 넣기' 는 위키 수정(6.2)
      clarify: d.findings.filter((f) => f.code === 'CLARIFY_NEEDED' && f.details).map((f) => ({ finding_id: f.finding_id, severity: f.severity, ...clarifyView(f.details as Record<string, unknown>) })),
      suggestions: d.findings.filter((f) => f.code === 'REFERENCE_SUGGESTION' && f.details).map((f) => ({ finding_id: f.finding_id, page: f.location?.page ?? null, ...(f.details as { item: string; reason: string; url: string; title: string; checked_at: string }) })),
      // 그림이 있는 쪽(개인정보 가린 쪽 이미지가 있는 쪽, page_index). 문서 보기에서 글 옆에 쪽 이미지 (사용자 지적 11/17 "그림은 따로 안 보여줘?")
      image_pages: deps.pageImageList ? await deps.pageImageList(d.doc_id).catch(() => []) : [],
      can_delete: d.owner === a.sub || hasRole(a, APPROVERS),
      // 결재 대상이면 결재 정보와 확인할 이유(쪽 본문이 없을 때 Finding으로 대신)
      review: d.lifecycle === 'PUBLISHED' || !hasRole(a, APPROVERS) ? undefined : {
        lifecycle: d.lifecycle,
        approval_id: pendingApproval?.approval_id,
        source_mismatch: d.lifecycle === 'IN_REVIEW' && hasSourceMismatch(d) && !d.source_review,
        findings: d.findings.filter((f) => f.severity !== 'LOW').map((f) => ({ severity: f.severity, code: f.code, step: f.step, message: plainMessage(f), fix_hint: f.fix_hint, page: f.location?.page,
          ...(f.acknowledged ? { ack_reason: f.acknowledged.reason ?? '' } : {}) })), // 작성자 '그대로 사용' 사유 → 승인자 상세에 (엔드유저 11/20)
      },
      ...docDatesOf(d, pages),
      verification: verification(d, approval),
      doc_marks: marks.filter((m) => m.page === null), // 위치를 못 찾은 항목 (예: 공식 원본에서 빠진 조문) → 상단에 모아 표시
      // 정리본 보기 페이지: 내용 단위로 묶음 (사용자 요청 11/18, 보기용 — 인용·색인은 쪽 단위)
      doc_pages: buildDocPages(pages.map((p) => ({ page: p.page, markdown: structuredMap.get(p.page)?.markdown ?? p.text }))),
      pages: pages.map((p, i) => ({ page: p.page, text: p.text, structured: structuredMap.get(p.page)?.markdown ?? null, structured_source: structuredMap.get(p.page)?.source ?? null, ...meta.get(p.page),
        clause_groups: clauseGroups(meta.get(p.page)?.clause_refs ?? [], p.text, d.law_name, lawNames),
        // 정리본 '(그림 k)' 아래 인라인 그림 (ImageDescribe 가 잘라낸 masked/figures, presigned 5분). k 는 1부터
        figures: figUrls.get(p.page) ?? [], summary: meta.get(p.page)?.summary || (sum.get(p.page) ?? null), marks: marks.filter((m) => m.page === i) })),
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
    const rt = await store.ratings?.(a.sub);
    return c.json({ items: items.map((i) => ({ ...i, ...ratingOf(rt?.get(i.doc_id)) })), related, ...(rewritten ? { rewritten } : {}) });
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
