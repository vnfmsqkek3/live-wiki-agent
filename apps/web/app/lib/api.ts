'use client';
import { roleText } from './roles';
// API·인증 클라이언트. NEXT_PUBLIC_API_URL이 정의되지 않으면 합성 mock으로 동작한다 (11/17 공유 dev 연동 전).
// 버튼 노출은 편의일 뿐 권한은 서버가 강제한다 (01 §3.1).

const API = process.env.NEXT_PUBLIC_API_URL;
const REGION = process.env.NEXT_PUBLIC_AWS_REGION ?? 'us-east-1';
const CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
// 빈 문자열 = 같은 도메인(CloudFront가 /v1/* 를 API로 전달). 정의되지 않았을 때만 mock
export const MOCK = API === undefined;

export type Role = 'USER' | 'AUTHOR' | 'REG_APPROVER' | 'SECURITY_REVIEWER' | 'PLATFORM_OPERATOR';
export interface Session { token: string; groups: Role[]; username: string }

const KEY = 'hanaeum.session';
// ponytail: sessionStorage(탭 단위). XSS 노출면이 있으므로 prod 전 Cognito managed login + httpOnly 쿠키 검토
export function getSession(): Session | undefined {
  try { const s = sessionStorage.getItem(KEY); return s ? (JSON.parse(s) as Session) : undefined; } catch { return undefined; }
}
/** 토큰 만료·무효: 세션을 지우고 로그인 화면으로 (돌아올 주소 포함) */
function expired() {
  logout();
  if (typeof window !== 'undefined' && window.location.pathname !== '/login')
    window.location.assign(`/login?expired=1&next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}
export function logout() { try { sessionStorage.removeItem(KEY); } catch { /* 저장소 차단 시 무시 */ } }

export async function login(username: string, password: string): Promise<Session> {
  let s: Session;
  if (MOCK || !CLIENT_ID) {
    // 데모 계정 2종: admin(전 그룹) / user(직원 + 작성자)
    const groups: Role[] = username.includes('admin') ? ['USER', 'AUTHOR', 'REG_APPROVER', 'SECURITY_REVIEWER', 'PLATFORM_OPERATOR'] : ['USER', 'AUTHOR'];
    s = { token: 'mock', groups, username };
  } else {
    const r = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
      body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: CLIENT_ID, AuthParameters: { USERNAME: username, PASSWORD: password } }),
    });
    if (!r.ok) throw new Error('아이디 또는 비밀번호를 확인하세요');
    const token = ((await r.json()) as { AuthenticationResult: { AccessToken: string } }).AuthenticationResult.AccessToken;
    // 표시용으로만 디코드 (서명 검증은 서버)
    const claims = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    s = { token, groups: (claims['cognito:groups'] as Role[] | undefined) ?? ['USER'], username };
  }
  sessionStorage.setItem(KEY, JSON.stringify(s));
  return s;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (MOCK) return mock(method, path, body) as T;
  const s = getSession();
  // 응답이 오지 않는 요청이 화면을 '찾는 중'에 묶어 두지 않게 45초에서 끊는다 (인프라 11/20: 서버 3초 응답인데 화면 60초 고정, 재현 안 됨)
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  }).catch((e: Error) => { throw new ApiError(0, e.name === 'TimeoutError' ? '응답이 늦어 중단했습니다. 다시 시도해 주세요.' : '서버에 연결하지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.'); });
  const j = (await r.json().catch(() => ({}))) as { error?: { message: string } };
  if (r.status === 401) expired();
  if (!r.ok) throw new ApiError(r.status, roleText(j.error?.message ?? `HTTP ${r.status}`));
  return j as T;
}

// ---------- 합성 mock (하나은행 가상 데이터 · SYNTHETIC) ----------
export interface SearchItem {
  doc_id: string; title: string; snippet: string; team?: string; updated?: string; rating?: Rating; business_path?: string[];
  tags: string[]; authority_status: 'VERIFIED' | 'UNVERIFIED'; freshness: 'CURRENT' | 'REVIEW_REQUIRED' | 'SUPERSEDED';
  document_type: 'REGULATION' | 'KNOWHOW' | 'MANUAL';
  basis?: string; effective_from?: string; reason: string;
  matches?: { basis?: string; snippet: string; page?: number; quotable?: boolean; evidence_kind?: 'FIGURE'; page_context?: string }[];
}
export const MOCK_ITEMS: SearchItem[] = [
  { doc_id: 'doc_F001', title: '기업여신 심사규정', snippet: '제12조(승인 기준) ② 담보가액이 3억원 이상인 경우 본부 승인을 받아야 한다.', team: '여신정책부', updated: '2026-11-01', rating: { avg: 4.6, count: 4 }, tags: ['공식규정', '여신'], authority_status: 'VERIFIED', freshness: 'CURRENT', document_type: 'REGULATION', basis: '기업여신 심사규정 제12조제2항', effective_from: '2026-11-01', reason: '찾는 내용과 조문이 직접 일치합니다', matches: [{ basis: '기업여신 심사규정 제12조제2항', snippet: '제12조(승인 기준) ② 담보가액이 3억원 이상인 경우 본부 승인을 받아야 한다.' }, { basis: '기업여신 심사규정 제14조제1항', snippet: '담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다.' }] },
  { doc_id: 'doc_K001', title: '담보평가 실무 체크리스트', snippet: '감정평가서를 받은 뒤 3영업일 안에 담보 적정성 검토 결과를 등록한다.', team: '여신심사1팀', updated: '2026-10-21', rating: { avg: 4.4, count: 4 }, tags: ['체크리스트', '여신'], authority_status: 'VERIFIED', freshness: 'CURRENT', document_type: 'KNOWHOW', basis: '기업여신 심사규정 제12조', effective_from: '2026-11-01', reason: '같은 업무 담당자가 자주 찾고, 근거 규정이 최신입니다' , matches: [{ snippet: '1억원 이하 부동산 담보대출은 현장 실사를 생략한다.', page: 1 }, { snippet: '[그림 설명 · 원문 아님] screenshot: 신도 복합기의 주소 등록 입력 화면 캡처로 보임. 주소 종류, 등록번호가 표시되어 있다. / 표기: 주소 등록 / *가 표시된 항목은 반드시 입력하십시오. / 의도: 신규 주소 등록 방법 안내', page: 36, quotable: false }, { snippet: '[그림 설명 · 원문 아님] screenshot: 설치 완료 화면. / 표기: 마침 버튼 / 의도: 설치 완료', page: 14, quotable: false }]},
  { doc_id: 'doc_K003', title: '소액 담보 처리 팁 (2025)', snippet: '5억원 미만은 지점 전결로 처리할 수 있다.', team: '여신심사2팀', updated: '2025-06-02', rating: { avg: 4.8, count: 4 }, tags: ['실무사례'], authority_status: 'VERIFIED', freshness: 'REVIEW_REQUIRED', document_type: 'KNOWHOW', basis: '기업여신 심사규정 제12조 (2025-01-01 개정 전)', effective_from: '2025-01-01', reason: '평점은 높지만 근거 규정이 개정되었습니다' },
];

function mock(method: string, path: string, body?: unknown): unknown {
  if (path.startsWith('/v1/search')) {
    const u = new URL(path, 'http://x');
    const tag = u.searchParams.get('tags');
    return { items: MOCK_ITEMS.filter((i) => !tag || i.tags.includes(tag)) }; // ponytail: mock은 질의 무관 전체 반환
  }
  if (/\/v1\/library\/.+\/similar/.test(path)) return { items: [] };
  if (/\/v1\/library\/.+\/external-laws/.test(path)) return { items: [{ law_name: '외국환거래법', clauses: [], result: { source: '국가법령정보센터 (AgentCore Browser)', url: 'https://www.law.go.kr', fetched_at: '2026-11-20T02:00:00Z', from_cache: false, effective_from: '2026-01-01', note: '외부 공식 사이트 원문 참고용', clause: null } }, { law_name: '외국환거래규정', clauses: [
    { clause: '제9-9조제1항', sub: ['제8호', '제9호'], result: { source: '국가법령정보센터 (AgentCore Browser)', url: 'https://www.law.go.kr', fetched_at: '2026-11-20T02:00:00Z', from_cache: true, effective_from: '2026-07-01', note: '외부 공식 사이트 원문 참고용', clause: { path: 'ARTICLE:9-9/PARAGRAPH:1', text: '① 거주자가 다음 각 호의 어느 하나에 해당하는 해외직접투자를 하고자 하는 경우에는…' } } },
    { clause: '제9-4조제1항', result: null, error: 'NOT_FOUND' }] }, { law_name: '개인정보 보호법', clause: '제15조제1항', result: { source: '국가법령정보센터 (AgentCore Browser)', url: 'https://www.law.go.kr', fetched_at: '2026-11-17T02:00:00Z', from_cache: false, effective_from: '2026-09-11', note: '외부 공식 사이트 원문 참고용', clause: { path: 'ARTICLE:15/PARAGRAPH:1', text: '① 개인정보처리자는 다음 각 호의 어느 하나에 해당하는 경우에는 개인정보를 수집할 수 있으며…' } } }] };
  if (/^\/v1\/library\/[^/]+\/versions$/.test(path)) {
    const id = decodeURIComponent(path.split('/')[3]!);
    const d = MOCK_LIBRARY.find((x) => x.doc_id === id);
    if (!d) throw new ApiError(404, 'document not found');
    const items: VersionItem[] = [{ doc_id: d.doc_id, title: d.title, version_no: d.version_no ?? 1, lifecycle: d.lifecycle, freshness: d.freshness, updated_at: d.updated_at, effective_from: d.effective_from, current: true }];
    if (id === 'doc_F001' || id === 'doc_F001_old') {
      const current = MOCK_LIBRARY.find((x) => x.doc_id === 'doc_F001')!;
      const old = MOCK_LIBRARY.find((x) => x.doc_id === 'doc_F001_old')!;
      return { items: [current, old].map((x) => ({ doc_id: x.doc_id, title: x.title, version_no: x.version_no, lifecycle: x.lifecycle, freshness: x.freshness, updated_at: x.updated_at, effective_from: x.effective_from, current: x.doc_id === current.doc_id })), diff: id === current.doc_id ? { previous: { doc_id: old.doc_id, title: old.title, version_no: old.version_no }, count: 1, changes: [{ kind: 'CHANGED', where: '제12조제2항', old_page: 0, new_page: 0, old_text: old.pages[0]!.text, new_text: current.pages[0]!.text.split('\n')[0]!, numbers_changed: { old: ['5억원'], new: ['3억원'] } }] } : null };
    }
    return { items, diff: null };
  }
  if (path.startsWith('/v1/library/')) {
    const d = MOCK_LIBRARY.find((x) => x.doc_id === decodeURIComponent(path.slice('/v1/library/'.length)));
    if (!d) throw new ApiError(404, 'document not found');
    return d;
  }
  if (path.startsWith('/v1/library')) {
    const u = new URL(path, 'http://x');
    const type = u.searchParams.get('type');
    const business = u.searchParams.get('business');
    return { items: MOCK_LIBRARY.filter((d) => !d.superseded_by && (!type || d.document_type === type) && (!business || d.business_path.includes(business))) };
  }
  if (path === '/v1/documents/upload-url') return { doc_id: 'doc_MOCK', url: 'mock://upload' };
  if (path === '/v1/approvals?status=APPROVED' || path === '/v1/approvals?status=USED')
    return { items: path.endsWith('APPROVED') ? [{ approval_id: 'apr_STUCK', doc_id: 'doc_STUCK', title: '보안 테스트 문서', lifecycle: 'PENDING_APPROVAL', workflow_failure: { step: 'Promote', error: 'UnclassifiedDocument' } }] : [] };
  if (path === '/v1/approvals?status=PENDING')
    return { items: [
      { approval_id: 'apr_K001', doc_id: 'doc_K001', title: '담보평가 실무 체크리스트', detail: '작성자가 개인정보 마스킹을 확인했습니다.', stage: 2 },
    ] };
  if (path === '/v1/admin/knowledge-debt') return { conflicts: 1, review_required: 2, unverified: 3, healthy: 12, docs_needing_attention: 2 };
  if (path === '/v1/review-queue')
    return { items: [{ doc_id: 'doc_F003', title: '기업여신 심사규정 (출처 미확인 사본)', dept: '여신', findings: [{ message: '공식 원본과 내용 불일치 (조문 1개: ARTICLE:12/PARAGRAPH:1, 원본 5억원 · 업로드본 3억원). 위조 확정 아님, 출처 검토 필요', evidence_ref: 'SYN-LOAN-001@2026-11-01' }] }] };
  if (/\/v1\/documents\/.+\/source-review/.test(path)) return { lifecycle: 'BLOCKED' };
  if (/\/v1\/approvals\/.+\/decision/.test(path)) return { status: (body as { decision: string }).decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
  if (/\/v1\/documents\/.+\/analyze/.test(path)) { mockTick = 0; return { workflow_id: 'wf_MOCK' }; }
  if (/\/v1\/documents\/.+\/progress/.test(path)) return mockProgress();
  if (/\/v1\/documents\/.+\/issues/.test(path)) return MOCK_ISSUES;
  if (/\/v1\/documents\/.+\/findings\/ack/.test(path)) return { acked: (body as { finding_ids: string[] }).finding_ids };
  if (/\/v1\/documents\/.+\/review/.test(path)) return MOCK_REVIEW;
  if (/\/v1\/documents\/.+\/classification/.test(path)) return { document_type: (body as { document_type: string }).document_type };
  if (/\/v1\/documents\/.+\/submit/.test(path)) return { approval_id: 'apr_MOCK' };
  if (path === '/v1/guides') return MOCK_GUIDE;
  if (path === '/v1/feedback') return { ok: true };
  // 규정 변경 영향 (SYNTHETIC): 제14조제1항 개정 → K-002 직접 영향
  if (path === '/v1/admin/change-requests') return { items: [{ id: 'cr_MOCK2', doc_id: 'doc_K002', title: '소액 부동산 담보대출 빠른 처리 팁', before: '1억원 이하는 감정평가서만으로 처리한다.', request: '', verdict: 'UNKNOWN', after: null, ai_reason: '금액 기준 예외가 개정 조문과 어떻게 맞물리는지 판단할 수 없습니다.', at: '2026-11-20T09:00:00Z', source: 'IMPACT', law: '기업여신 심사규정', path: 'ARTICLE:14/PARAGRAPH:1' }, { id: 'cr_MOCK3', doc_id: 'doc_KREV', title: '외국환 실무 메모 2', before: '건당 5천달러 이하 송금은 증빙 없이 처리한다.', request: '', verdict: 'APPROPRIATE', after: '건당 3천달러 이하 송금은 증빙 없이 처리한다.', ai_reason: '개정 조문이 기준 금액을 3천달러로 낮췄습니다.', at: '2026-11-22T09:00:00Z', source: 'IMPACT', law: '외국환업무 취급규정', path: 'ARTICLE:5/PARAGRAPH:1', revision: { law_name: '외국환업무 취급규정', effective_from: '2026-12-01', current_effective_from: '2026-11-01', old_text: '건당 미화 5천달러 이하', new_text: '건당 미화 3천달러 이하', kind: 'MODIFIED', label: '제5조제1항' } }] };
  if (/\/v1\/admin\/change-requests\/.+/.test(path)) { if ((body as { decision: string }).decision === 'APPLY') throw new ApiError(409, 'before not found in document'); return { new_doc_id: null }; }
  if (/\/v1\/documents\/.+\/freshness\/confirm/.test(path)) return { doc_id: path.split('/')[3], freshness: 'CURRENT', law_id: 'SYN-LOAN-001', revision: '2026-12-01' };
  if (path === '/v1/admin/impact/laws') return { items: [{ law_name: '기업여신 심사규정', versions: 2 }] };
  if (path.startsWith('/v1/admin/impact?')) return { old_revision: '2026-11-01', new_revision: '2026-12-01',
    changes: [{ path: 'ARTICLE:14/PARAGRAPH:1', kind: 'MODIFIED', old_text: '담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다.', new_text: '담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하고 실사 보고서를 승인 전에 작성하여야 한다.' }],
    impacted: [{ doc_id: 'doc_K002', title: '소액 부동산 담보대출 빠른 처리 팁', relation: 'DIRECT', risk: 'HIGH', evidence: [{ cited_provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:14/PARAGRAPH:1', evidence_span: '실사 보고서는 나중에 작성해도 된다', change: { path: 'ARTICLE:14/PARAGRAPH:1', kind: 'MODIFIED', old_text: '', new_text: '' } }] }] };
  if (path === '/v1/admin/impact/draft') return { items: [
    { id: 'cr_MOCK1', doc_id: (body as { doc_id: string }).doc_id, path: 'ARTICLE:14/PARAGRAPH:1', before: '실사 보고서는 나중에 작성해도 된다.', after: '실사 보고서는 승인 전에 작성한다 (기업여신 심사규정 제14조제1항, 2026-12-01 개정).', verdict: 'APPROPRIATE', ai_reason: '개정 조문이 실사 보고서를 승인 전에 작성하도록 정했습니다.' },
    { id: 'cr_MOCK2', doc_id: (body as { doc_id: string }).doc_id, path: 'ARTICLE:14/PARAGRAPH:1', before: '1억원 이하는 감정평가서만으로 처리한다.', after: null, verdict: 'UNKNOWN', ai_reason: '금액 기준 예외가 개정 조문과 어떻게 맞물리는지 판단할 수 없습니다.' }] };
  throw new ApiError(404, `mock 없음: ${method} ${path}`);
}

/** presigned PUT. fetch는 업로드 진행률을 주지 않아 XHR 사용 */
export function uploadFile(url: string, file: File, onProgress?: (ratio: number) => void): Promise<void> {
  if (url.startsWith('mock://')) { onProgress?.(1); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => (x.status < 300 ? resolve() : reject(new ApiError(x.status, '파일 업로드 실패')));
    x.onerror = () => reject(new ApiError(0, '네트워크 오류로 업로드하지 못했습니다'));
    x.send(file);
  });
}

export interface Progress { lifecycle: string; total: number; done: number; finished: boolean; halted: boolean; blocked_reasons?: string[]; steps: { key: string; label: string; state: 'done' | 'running' | 'pending' | 'failed' | 'blocked' | 'skipped' }[] }
let mockTick = 0;
function mockProgress(): Progress {
  const labels = ['악성코드 검사', '파일 구조 검사', '텍스트 추출', '페이지 이미지', '문자 인식', '본문 정리', '개인정보 가림', '지시문 검사', '분류·요약', '출처·근거 검증', '검토 준비'];
  const done = Math.min(labels.length, ++mockTick);
  return { lifecycle: done === labels.length ? 'IN_REVIEW' : 'QUARANTINED', total: labels.length, done, finished: done === labels.length, halted: false,
    steps: labels.map((label, i) => ({ key: String(i), label, state: i < done ? 'done' : i === done ? 'running' : 'pending' })) };
}

// ---------- 05 검토 · 03 가이드 ----------
/** 본문에 적힌 일자 (시행·개정·제정·작성·발행·기준). page는 0부터 */
export interface DocDate { kind: string; date: string; page: number }
/** PageSummarize 쪽 메타데이터 (masked/summary.json) */
export interface PageMeta { summary: string; keywords?: string[]; clause_refs?: string[]; clause_groups?: { law: string | null; clauses: string[] }[]; page_type?: string }
export interface Finding { finding_id: string; step: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; code: string; message: string; evidence_ref: string; user_message?: string; fix_hint?: string; location?: { page?: number; excerpt?: string } }
/** 게시를 막지 않지만 사람이 확인할 근거 문제 (EXTERNAL·BASIS_MISMATCH, OUTDATED_CITATION, NO_BASIS — 백엔드 checks 계약·AI 11/20, MX-002) */
export const isCheck = (code: string) => /(_EXTERNAL_MISMATCH|_BASIS_MISMATCH|OUTDATED_CITATION|NO_BASIS)$/.test(code);
export interface Fix { finding_id: string; code: string; message: string; excerpt: string; suggestion: string | null; fix_hint: string | null; acknowledged: boolean; ack_reason?: string | null }
export interface Review {
  fixes?: Fix[]; reviews?: import('../review-items').ReviewItem[]; clarify?: import('../clarify').ClarifyItem[]; text?: string; source?: 'UPLOAD' | 'WIKI_EDIT'; suggestions?: import('../ref-suggestions').RefSuggestion[];
  doc_id: string; title?: string; lifecycle: string; trust_gate_result?: 'PASS' | 'REVIEW_REQUIRED' | 'QUARANTINED';
  authority_status: string;
  rejection_reason?: string | null; // 백엔드 요청 중 (엔드유저 11/20)
  classification?: { document_type: 'REGULATION' | 'KNOWHOW' | 'MANUAL'; confidence: number; rationale: string; source?: 'MODEL' | 'HUMAN' };
  findings: Finding[]; masked_preview?: string;
  page_summaries?: ({ page_index: number } & PageMeta)[];
  title_source?: 'AUTO' | 'USER'; can_edit?: boolean;
  doc_date?: DocDate; doc_dates?: DocDate[];
  previous_doc_id?: string; version_no?: number;
  version?: { previous: { doc_id: string; title: string; version_no: number }; count: number; changes: DocChange[] } | null;
  knowhow_validation?: KnowhowValidation;
  workflow_failure?: { step: string; error: string };
}
export interface KnowhowValidation {
  verdict: 'SUPPORTED' | 'CONFLICT' | 'OUTDATED' | 'INSUFFICIENT';
  items: { statement: string; provision_id: string; label: string; relation: 'SUPPORTS' | 'SUPPLEMENTS' | 'CONFLICTS' | 'UNRELATED' | 'INSUFFICIENT'; reason: string; quote: string; verified_quote: boolean }[];
  outdated: { cited: string; current: string; label: string }[];
  model?: string;
}
const MOCK_REVIEW: Review = {
  text: '1억원 이하 부동산 담보대출은 현장 실사를 생략하고 감정평가서만으로 처리한다. 실사 보고서는 담당자의 확인을 받아 나중에 작성한다.',
  clarify: [{ finding_id: 'fnd_C1', kind: 'VAGUE_ACTOR', item: '담당자', page: 1, before: '실사 보고서는 담당자의 확인을 받아 나중에 작성한다.', question: "이 '담당자'는 어느 부서의 어떤 직책인가요?", blocking: true, severity: 'MEDIUM', status: 'OPEN',
    suggestions: [{ value: '여신심사부 심사역', after: '실사 보고서는 여신심사부 심사역의 확인을 받아 나중에 작성한다.', source: { type: 'WIKI', doc_id: 'doc_F001', title: '[SYNTHETIC] 기업여신 심사규정', page: 3 } }] }],
  reviews: [{ finding_id: 'fnd_R0', code: 'SECRET_MASKED', page: 2, message: '비밀번호로 보이는 값 1건을 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }, { finding_id: 'fnd_R1', code: 'SECRET_MASKED', page: 5, message: '접속 키로 보이는 값 1건을 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }, { finding_id: 'fnd_R2', code: 'PII_IMAGE_REVIEW', page: 1, message: '그림 속 글자에 개인정보가 있을 수 있어 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }, { finding_id: 'fnd_R3', code: 'PII_IMAGE_REVIEW', page: 2, message: '그림 속 글자에 개인정보가 있을 수 있어 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }, { finding_id: 'fnd_R4', code: 'PII_IMAGE_REVIEW', page: 3, message: '그림 속 글자에 개인정보가 있을 수 있어 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }, { finding_id: 'fnd_R5', code: 'PII_IMAGE_REVIEW', page: 4, message: '그림 속 글자에 개인정보가 있을 수 있어 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }, { finding_id: 'fnd_R6', code: 'PII_IMAGE_REVIEW', page: 6, message: '그림 속 글자에 개인정보가 있을 수 있어 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }, { finding_id: 'fnd_R7', code: 'PII_IMAGE_REVIEW', page: 7, message: '그림 속 글자에 개인정보가 있을 수 있어 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }, { finding_id: 'fnd_R8', code: 'PII_IMAGE_REVIEW', page: 8, message: '그림 속 글자에 개인정보가 있을 수 있어 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }, { finding_id: 'fnd_R9', code: 'PII_IMAGE_REVIEW', page: 9, message: '그림 속 글자에 개인정보가 있을 수 있어 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }, { finding_id: 'fnd_R10', code: 'PII_IMAGE_REVIEW', page: 10, message: '그림 속 글자에 개인정보가 있을 수 있어 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }, { finding_id: 'fnd_R11', code: 'PII_IMAGE_REVIEW', page: 12, message: '그림 속 글자에 개인정보가 있을 수 있어 가렸습니다.', fix_hint: null, acknowledged: false, reason: null }],
  doc_id: 'doc_MOCK', title: '소액 부동산 담보대출 빠른 처리 팁', lifecycle: 'IN_REVIEW', trust_gate_result: 'REVIEW_REQUIRED', authority_status: 'UNVERIFIED',
  classification: { document_type: 'KNOWHOW', confidence: 0.82, rationale: '절차·체크 항목 중심의 실무 문서이며 공식 규정 번호 체계가 없습니다.', source: 'MODEL' },
  knowhow_validation: {
    verdict: 'CONFLICT', outdated: [], model: 'us.anthropic.claude-sonnet-4-6',
    items: [
      { statement: '1억원 이하 부동산 담보대출은 현장 실사를 생략하고 감정평가서만으로 처리한다', provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:14/PARAGRAPH:1', label: '기업여신 심사규정 제14조제1항', relation: 'CONFLICTS', reason: '규정은 담보가 부동산이면 금액과 관계없이 현장 실사를 반드시 하도록 정하고 있어, 금액 기준으로 실사를 생략하는 방법은 규정과 어긋납니다.', quote: '담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다.', verified_quote: true },
      { statement: '실사 보고서는 나중에 작성해도 된다', provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:14/PARAGRAPH:2', label: '기업여신 심사규정 제14조제2항', relation: 'INSUFFICIENT', reason: '작성 시점에 대한 기준이 조문에 없어 판단할 수 없습니다.', quote: '', verified_quote: false },
    ],
  },
  findings: [
    { finding_id: 'f1', step: 'PII_SCAN', severity: 'LOW', code: 'PII_MASKED_PHONE', message: '전화번호 2건 가림', evidence_ref: 'page:1' },
    { finding_id: 'fx1', step: 'KNOWHOW_VALIDATION', severity: 'MEDIUM', code: 'KNOWHOW_EXTERNAL_MISMATCH', message: '"주채무계열 소속 기업이면 여신최다은행" 문장이 외국환거래규정 제9-5조제1항(외부·미검증) 원문과 다릅니다: 원문은 주채권은행에 신고하도록 정합니다.', evidence_ref: 'EXT:외국환거래규정/제9-5조제1항', fix_hint: '확인 후 이렇게 고쳐 주세요: "주채무계열 소속 기업이면 주채권은행이다."', location: { page: 1, excerpt: '주채무계열 소속 기업이면 여신최다은행' } },
    { finding_id: 'f2', step: 'PII_SCAN', severity: 'MEDIUM', code: 'PII_UNCERTAIN_ACCOUNT', message: '계좌번호 1건 가림 (그중 1건은 개인정보인지 확인 필요)', evidence_ref: 'page:2' },
    { finding_id: 'f3', step: 'OCR', severity: 'MEDIUM', code: 'OCR_LOW_CONFIDENCE', message: '인식 신뢰도가 낮은 페이지 (평균 0.86)', evidence_ref: 'page:3' },
  ],
  masked_preview: '1. 감정평가서를 받은 뒤 3영업일 안에 담보 적정성 검토 결과를 등록한다.\n2. 담당자 연락처 [전화번호]로 평가 일정을 확인한다.\n3. 입금 계좌 [계좌번호]는 고객 확인 후 기재한다.',
};

export interface Evidence { doc_id: string; title: string; snippet: string; provision?: string; provision_id?: string; effective_from?: string; authority_status: string; freshness: string; page?: number }
export interface Guide { status: 'OK' | 'NO_EVIDENCE'; query_masked: boolean; model: string; evidence: Evidence[]; steps: { text: string; sources: Evidence[] }[]; sections?: { title: string; note: string; steps: { text: string; sources: Evidence[] }[]; fallback?: string; source_note?: string }[]; dropped_steps: number; uncertainty: string }
const MOCK_GUIDE: Guide = {
  status: 'OK', query_masked: false, model: 'us.anthropic.claude-sonnet-4-6', dropped_steps: 0,
  evidence: [],
  steps: [
    { text: '담보가액이 3억원 이상이면 본부 승인을 받아야 하므로, 담보 4억원 건은 본부 승인 대상입니다.', sources: [{ doc_id: 'doc_F001', title: '기업여신 심사규정', snippet: '', provision: '기업여신 심사규정 제12조제2항', effective_from: '2026-11-01', authority_status: 'VERIFIED', freshness: 'CURRENT' }] },
    { text: '감정평가서를 받은 뒤 3영업일 안에 담보 적정성 검토 결과를 등록합니다.', sources: [{ doc_id: 'doc_K001', title: '담보평가 실무 체크리스트', snippet: '', provision: '기업여신 심사규정 제12조', effective_from: '2026-11-01', authority_status: 'VERIFIED', freshness: 'CURRENT' }] },
  ],
  uncertainty: '"5억원 미만은 지점 전결" 팁은 개정 전 규정을 근거로 하고 있어 재검토 중입니다. 현행 기준은 3억원 이상 본부 승인입니다.',
};

// ---------- 문서보관함 (let522mj 요청 2220) ----------
export interface Mark {
  page: number | null; start: number | null; end: number | null; severity: 'HIGH' | 'MEDIUM' | 'LOW';
  kind: 'CONFLICT' | 'OUTDATED' | 'INSUFFICIENT' | 'BASIS_MISMATCH' | 'REGISTRY_MISMATCH' | 'PII_UNCERTAIN' | 'INJECTION' | 'CONFIRMED' | 'SUPPLEMENT';
  /** let522mj buildMarks 표시 이름 (있으면 그대로 쓴다) */
  label?: string;
  reason: string; basis?: { provision_id: string; label: string; text: string; effective_from?: string }; fix?: string;
  /** 세 칸 (사용자 요청 11/17, let522mj PR #15): 올린 문서의 그 부분(없으면 null) · 근거(basis) · 근거를 바탕으로 한 수정(필요 없으면 null). 이전 API는 없음 */
  original?: string | null; revision?: string | null;
  /** 해당 없음 요청 키 (게시 문서, 11/19) */
  key?: string;
}
/** 업무 분류 칸 (AI 자동 분류). doc_count = 이 사용자가 볼 수 있는 게시 문서 수(하위 포함) */
export interface CategoryNode { category_id: string; parent_id: string | null; name: string; path: string; level: number; description: string; doc_count: number }
/** 평점 집계 (P1, 백엔드 #125): 0건이면 서버가 생략 */
export interface Rating { avg: number; count: number }
/** 재검토 이유. changes·open_change_requests는 백엔드 요청 중(11/23): 없으면 화면이 그 줄을 숨긴다 */
export interface FreshnessReason {
  law_id: string; law_name: string; cited_revision: string; current_revision: string; effective_from: string; provisions: string[]; at: string; deleted_doc?: string;
  changes?: { provision_id: string; label?: string; kind?: string; old_text?: string; new_text?: string; cited_text?: string }[];
  open_change_requests?: number;
}
/** 수정 요청(IMPACT)의 개정 정보 (백엔드 요청 중) */
export interface CrRevision { law_name?: string; effective_from?: string; current_effective_from?: string; old_text?: string; new_text?: string; kind?: string; label?: string }
export interface LibraryCard {
  rating?: Rating; useful_count?: number;
  category_path?: string | null; category_id?: string | null;
  doc_id: string; title: string; document_type?: 'REGULATION' | 'KNOWHOW' | 'MANUAL'; lifecycle: string;
  business_path: string[]; tags: string[]; summary: string | null; authority_status: 'VERIFIED' | 'UNVERIFIED' | 'REJECTED';
  freshness: 'CURRENT' | 'REVIEW_REQUIRED' | 'SUPERSEDED'; effective_from: string | null; uploaded_at: string; updated_at: string; mark_count: number; edited?: boolean; has_original_upload?: boolean;
  version_count?: number;
  doc_dates?: DocDate[]; version_no?: number | null; superseded_by?: string | null;
  freshness_reason?: FreshnessReason | null;
  /** 같은 규정의 시행 예정 개정판 (총괄 11/23, 백엔드 요청 중) */
  upcoming?: { doc_id: string; version_no?: number | null; effective_from: string } | null;
  related: { doc_id: string; title: string; relation: 'CITES' | 'CITED_BY' | 'CONFLICTS' | 'SIMILAR'; reason: string; document_type?: string }[];
}
export interface Verification {
  method: string; basis: { what: string; label: string; result: string; quote?: string; effective_from?: string; statement?: string; reason?: string; relation?: string }[];
  checks: { trust_gate: string | null; verdict: string | null; checked_at: string | null };
  approved_by: string | null; approved_at: string | null; approval_reason: string | null;
}
export interface LawResult { source: string; url: string; fetched_at: string; from_cache: boolean; effective_from?: string; promulgation?: string; note: string; clause?: { path: string; text: string } | null }
/** clauses: 본문이 인용한 조문 전부(등장 순서). 없으면 옛 응답(clause·result 1건) */
export interface ExternalLaw { law_name: string; clause?: string; error?: string; result?: LawResult | null;
  clauses?: { clause: string; sub?: string[]; result: LawResult | null; error?: string }[] }
/** 결재 대상 문서를 관리자가 열었을 때 (GET /v1/library/:id). 쪽 본문이 없으면 findings로 이유를 보여 준다 */
export interface ReviewInfo {
  lifecycle: string; approval_id?: string; source_mismatch: boolean;
  findings: { severity: 'HIGH' | 'MEDIUM'; code: string; step: string; message: string; fix_hint?: string; page?: number; ack_reason?: string; excerpt?: string }[];
}
export interface Claim { claim_id: string; seq: number; statement: string; page: number | null; provision_id: string | null; label: string | null; relation: string; reason: string; quote: string | null; verified: boolean; status: string; on_provision: { supports: number; conflicts: number; unclear: number } | null }
export interface LibraryDoc extends LibraryCard {
  my_stars?: number | null;
  claims?: Claim[]; doc_pages?: { title: string; pages: number[]; parts: { page: number; markdown: string }[] }[]; clarify?: import('../clarify').ClarifyItem[]; image_pages?: number[]; suggestions?: import('../ref-suggestions').RefSuggestion[]; review?: ReviewInfo; can_delete?: boolean; doc_date?: { label: string; date: string } | null; verification?: Verification; doc_marks: Mark[]; pages: ({ page: number; text: string; structured?: string | null; structured_source?: 'TEXT' | 'VISION' | 'AI' | null; figures?: { k: number | string; url: string | null }[]; summary: string | null; marks: Mark[] } & Omit<Partial<PageMeta>, 'summary'>)[] }

const K002 = '소액 부동산 담보대출 빠른 처리 팁 (SYNTHETIC)\n1억원 이하 부동산 담보대출은 현장 실사를 생략하고 감정평가서만으로 처리한다. 실사 보고서는 나중에 작성해도 된다. 감정평가서는 심사역이 보관한다. 실사는 영업일 기준 3일 안에 마친다.';
export const MOCK_LIBRARY: LibraryDoc[] = [
  {
    rating: { avg: 4.5, count: 6 }, my_stars: 4,
    doc_id: 'doc_K002', title: '소액 부동산 담보대출 빠른 처리 팁', document_type: 'KNOWHOW', lifecycle: 'PUBLISHED', business_path: ['여신', '담보'], tags: ['실무사례', '담보'],
    summary: '1억원 이하 부동산 담보대출을 빠르게 처리하는 요령입니다. 현장 실사를 생략하고 감정평가서만으로 처리하며, 실사 보고서는 사후에 작성한다고 안내합니다.',
    authority_status: 'UNVERIFIED', freshness: 'CURRENT', effective_from: null, uploaded_at: '2026-11-16T12:30:00Z', updated_at: '2026-11-16T12:31:00Z', mark_count: 2,
    related: [{ doc_id: 'doc_F001', title: '기업여신 심사규정', relation: 'CONFLICTS', reason: '기업여신 심사규정 제14조제1항' }],
    doc_marks: [],
    pages: [
      { page: 0, text: K002, summary: '금액 기준으로 현장 실사를 생략하는 처리 요령과 보고서 사후 작성을 안내합니다.', marks: [
        { page: 0, start: K002.indexOf('1억원'), end: K002.indexOf('처리한다.') + 5, severity: 'HIGH', kind: 'CONFLICT', original: '1억원 이하 부동산 담보대출은 현장 실사를 생략하고 감정평가서만으로 처리한다.', revision: '1억원 이하 부동산 담보대출도 현장 실사를 반드시 실시하여야 한다.', reason: '규정은 담보가 부동산이면 금액과 관계없이 현장 실사를 반드시 하도록 정하고 있습니다.', basis: { provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:14/PARAGRAPH:1', label: '기업여신 심사규정 제14조제1항', text: '① 담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다.', effective_from: '2026-11-01' }, fix: '근거 조문에 맞게 수정: "담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다."' },
        { page: 0, start: K002.indexOf('실사 보고서'), end: K002.indexOf('된다.') + 3, severity: 'MEDIUM', kind: 'INSUFFICIENT', original: '실사 보고서는 나중에 작성해도 된다.', revision: null, reason: '보고서 작성 시점에 대한 기준을 조문에서 찾지 못했습니다.', fix: '근거 조문을 명시하거나 담당 부서 확인' },
        { page: 0, start: K002.indexOf('감정평가서는'), end: K002.indexOf('보관한다.') + 5, severity: 'MEDIUM', kind: 'BASIS_MISMATCH', original: '감정평가서는 심사역이 보관한다.', revision: null, fix: '근거로 든 조항과 다른 내용으로 보입니다. 해당 부분을 다시 확인하세요.', reason: '인용한 조항이 다른 주제를 다룹니다.', basis: { provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:14/PARAGRAPH:1', label: '기업여신 심사규정 제14조제1항', text: '① 담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다.' } },
        { page: 0, start: K002.indexOf('실사는 영업일'), end: K002.length, severity: 'MEDIUM', kind: 'INSUFFICIENT', original: '실사는 영업일 기준 3일 안에 마친다.', revision: null, reason: '같은 주제 조문은 있으나 기한 기준이 없습니다.', basis: { provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:14/PARAGRAPH:1', label: '기업여신 심사규정 제14조제1항', text: '① 담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다.' } },
      ] },
    ],
  },
  {
    doc_id: 'doc_F001', title: '기업여신 심사규정', document_type: 'REGULATION', lifecycle: 'PUBLISHED', business_path: ['여신'], tags: ['공식규정'],
    version_no: 2, version_count: 2,
    summary: '기업여신 심사 절차와 승인 기준을 정합니다. 3억원 이상은 본부 승인, 부동산 담보는 금액과 관계없이 현장 실사를 해야 합니다.',
    authority_status: 'VERIFIED', freshness: 'CURRENT', effective_from: '2026-11-01', uploaded_at: '2026-11-16T10:50:00Z', updated_at: '2026-11-16T11:13:00Z', mark_count: 0, upcoming: { doc_id: 'doc_F001_v2', version_no: 3, effective_from: '2026-12-01' },
    related: [{ doc_id: 'doc_K002', title: '소액 부동산 담보대출 빠른 처리 팁', relation: 'CONFLICTS', reason: '기업여신 심사규정 제14조제1항' }],
    doc_marks: [], pages: [{ page: 0, text: '제12조(승인 기준) ② 담보가액이 3억원 이상인 경우 본부 승인을 받아야 한다.\n\n제14조(현장 실사) ① 담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다.', summary: '부동산 담보의 현장 실사 의무를 정합니다.', marks: [] }],
  },
];

// 이전 판은 상세에서 열 수 있지만 보관함에는 대표 판만 표시한다.
MOCK_LIBRARY.push({ ...MOCK_LIBRARY[1]!, doc_id: 'doc_F001_v2', version_no: 3, effective_from: '2026-12-01', upcoming: null });
MOCK_LIBRARY.push({ ...MOCK_LIBRARY[0]!, doc_id: 'doc_KREV', title: '외국환 실무 메모 2', summary: '해외송금 증빙 없는 송금 한도(미화 5천달러)와 확인 순서를 정리한 메모입니다.', rating: undefined, my_stars: null, freshness: 'REVIEW_REQUIRED', mark_count: 0, freshness_reason: { law_id: 'SYN-FX-001', law_name: '외국환업무 취급규정', cited_revision: '2026-11-01', current_revision: '2026-12-01', effective_from: '2026-12-01', provisions: ['SYN-FX-001@2026-11-01/ARTICLE:5/PARAGRAPH:1'], at: '2026-11-22T09:00:00Z', open_change_requests: 1,
  changes: [{ provision_id: 'SYN-FX-001@2026-11-01/ARTICLE:5/PARAGRAPH:1', label: '제5조제1항', kind: 'MODIFIED', old_text: '건당 미화 5천달러 이하', new_text: '건당 미화 3천달러 이하', cited_text: '건당 5천달러 이하 송금은 증빙 없이 처리한다.' }] } });
MOCK_LIBRARY.push({ ...MOCK_LIBRARY[1]!, doc_id: 'doc_F001_old', version_no: 1, freshness: 'SUPERSEDED', effective_from: '2025-01-01', updated_at: '2025-01-01T00:00:00Z', superseded_by: 'doc_F001', summary: '개정 전 승인 기준: 5억원 이상 본부 승인.', pages: [{ page: 0, text: '제12조(승인 기준) ② 담보가액이 5억원 이상인 경우 본부 승인을 받아야 한다.', summary: '개정 전 승인 기준입니다.', marks: [] }] });

/** 가이드 스트리밍 (SSE): 진행 문구를 onProgress로, 마지막에 결과. 서버가 스트림을 못 주면 JSON으로 받는다 */
export async function streamGuide(question: string, onProgress: (text: string) => void): Promise<Guide> {
  if (MOCK) {
    for (const t of ['질문에 개인정보가 있는지 확인하는 중입니다', '관련 규정·노하우를 검색하는 중입니다', '근거 문서 3건으로 가이드를 작성하는 중입니다', '단계마다 출처를 확인하는 중입니다']) {
      onProgress(t); await new Promise((r) => setTimeout(r, 450));
    }
    return MOCK_GUIDE;
  }
  const s = getSession();
  const r = await fetch(`${API}/v1/guides`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
    body: JSON.stringify({ question }),
  });
  if (r.status === 401) expired();
  if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`);
  if (!r.headers.get('content-type')?.includes('text/event-stream') || !r.body) return (await r.json()) as Guide;
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null') as { text?: string; message?: string } | Guide;
      if (event === 'progress') onProgress((data as { text: string }).text);
      else if (event === 'result') return data as Guide;
      else if (event === 'error') throw new ApiError(502, (data as { message: string }).message);
    }
  }
  throw new ApiError(502, '응답이 중간에 끊겼습니다');
}

// ---------- 올린 사람용 사유 목록 (사용자 지시 11/17) ----------
export interface Issue { finding_id?: string; step: string; step_label: string; severity: 'HIGH' | 'MEDIUM' | 'LOW'; code: string; user_message: string; fix_hint?: string; location?: { page?: number; bbox?: number[][]; excerpt?: string } }
/** AgentCore explain_findings 결과 (yoyo0704). 판정은 바꾸지 않고 사실을 설명만 한다 */
export interface Explanation { summary: string; items: { finding_id: string; page?: number; where: string; problem: string; reason: string; risk: '높음' | '중간' | '낮음'; fix: string }[]; next_action?: string; model?: string; generated_at?: string }
export interface Issues { doc_id: string; lifecycle: string; items: Issue[]; page_images: number[]; explanation?: Explanation | null }
export const MOCK_ISSUES: Issues = { doc_id: 'doc_MOCK', lifecycle: 'BLOCKED', page_images: [],
  explanation: { summary: 'PDF 안에 콘텐츠 출처 서명(C2PA) 첨부가 있어 보안 검사에서 차단되었습니다. 문서 작성 도구가 자동으로 넣은 것으로 보이며 위험은 낮지만, 첨부를 뺀 PDF로 다시 올려야 등록됩니다.',
    items: [{ finding_id: 'f1', where: '파일 전체(PDF 첨부)', problem: '첨부 파일 1개(Content Credentials, application/c2pa, 2KB)', reason: '첨부 파일은 내용을 검사할 수 없어 보안 정책상 등록하지 않습니다.', risk: '낮음', fix: "PDF 뷰어에서 '인쇄 → PDF로 저장'으로 다시 저장해 올려 주세요." }],
    next_action: '다시 저장한 PDF를 새로 등록하세요.', model: 'mock' },
  items: [
  { step: 'FILE_STRUCTURE', step_label: '파일 구조 검사', severity: 'HIGH', code: 'PDF_EMBEDDED_FILE', user_message: 'PDF 안에 첨부 파일 1개(대출내역.xlsx)가 들어 있어 보안상 등록할 수 없습니다.', fix_hint: "첨부 파일을 지운 뒤 '인쇄 → PDF로 저장'으로 새로 만든 PDF를 올려 주세요." },
  { step: 'KNOWHOW', step_label: '노하우 검증', severity: 'LOW', code: 'KNOWHOW_EXTERNAL_SKIPPED', user_message: '확인하지 못함: 외부 법령 원문을 불러오지 못해 대조하지 않았습니다. 승인자가 직접 확인해 주세요.' },
  { step: 'PII_SCAN', step_label: '개인정보 가림', severity: 'MEDIUM', code: 'PII_UNCERTAIN_ACCOUNT', user_message: '2쪽에서 계좌번호 1건을 가렸습니다. 그중 1건은 실제 계좌번호인지 확인이 필요합니다.', fix_hint: '계좌번호가 아니라면 검토 화면에서 확인해 주세요.', location: { page: 2, excerpt: '…참조번호 [계좌번호]로 접수한다…' } },
] };

/** 인증이 필요한 이미지(마스킹된 쪽) → blob URL */
export async function apiBlobUrl(path: string): Promise<string> {
  if (MOCK) throw new ApiError(404, 'mock 이미지 없음');
  const s = getSession();
  const r = await fetch(`${API}${path}`, { headers: s ? { authorization: `Bearer ${s.token}` } : {} });
  if (r.status === 401) expired();
  if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`);
  return URL.createObjectURL(await r.blob());
}

/** 본문 일자 한 줄: 종류별 가장 늦은 날짜, 시행 → 개정 → 제정 → 작성 → 발행 → 기준 순 최대 3개. 예 "시행 2026-12-01 · 개정 2026-11-01" */
export function dateLine(ds: DocDate[]): string {
  const order = ['시행', '개정', '제정', '작성', '발행', '기준'];
  const latest = new Map<string, string>();
  for (const d of ds) if (!latest.has(d.kind) || d.date > latest.get(d.kind)!) latest.set(d.kind, d.date);
  return order.filter((k) => latest.has(k)).slice(0, 3).map((k) => `${k} ${latest.get(k)}`).join(' · ');
}

/** 버전 관리 (사용자 요청 11/17). 바뀐 곳은 legal-parser diffDocuments: 규정은 조·항 단위, 그 밖은 줄 단위 */
export interface DocChange { kind: 'ADDED' | 'REMOVED' | 'CHANGED'; where: string; old_page: number | null; new_page: number | null; old_text: string; new_text: string; numbers_changed?: { old: string[]; new: string[] } }
export interface VersionDiff { previous: { doc_id: string; title: string; version_no: number }; count: number; changes: DocChange[] }
export interface VersionItem { doc_id: string; title: string; version_no: number; lifecycle: string; freshness: string; updated_at: string; current: boolean; effective_from?: string | null }
export interface VersionCandidates { linked: { doc_id: string; title: string; version_no: number } | null; version_no?: number; items: { doc_id: string; title: string; score: number; reason: string }[] }

/** 결재자가 이 문서를 열어 봤는지 (사용자 결정 11/18: 열어 보기 전 승인 잠금). 탭 단위 기록, 서버 기록 아님 */
const VIEWED = 'hanaeum.viewed';
export function viewedDocs(): Record<string, boolean> { try { return JSON.parse(sessionStorage.getItem(VIEWED) ?? '{}') as Record<string, boolean>; } catch { return {}; } }
export function markViewed(id: string) { try { sessionStorage.setItem(VIEWED, JSON.stringify({ ...viewedDocs(), [id]: true })); } catch { /* 저장소 차단 */ } }
