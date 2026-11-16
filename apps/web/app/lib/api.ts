'use client';
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
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
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
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: { message: string } };
  if (r.status === 401) expired();
  if (!r.ok) throw new ApiError(r.status, j.error?.message ?? `HTTP ${r.status}`);
  return j as T;
}

// ---------- 합성 mock (하나은행 가상 데이터 · SYNTHETIC) ----------
export interface SearchItem {
  doc_id: string; title: string; snippet: string; team?: string; updated?: string; stars?: number; business_path?: string[];
  tags: string[]; authority_status: 'VERIFIED' | 'UNVERIFIED'; freshness: 'CURRENT' | 'REVIEW_REQUIRED' | 'SUPERSEDED';
  document_type: 'REGULATION' | 'KNOWHOW' | 'MANUAL';
  basis?: string; effective_from?: string; reason: string;
}
export const MOCK_ITEMS: SearchItem[] = [
  { doc_id: 'doc_F001', title: '기업여신 심사규정 v1', snippet: '제12조(승인 기준) ② 담보가액이 3억원 이상인 경우 본부 승인을 받아야 한다.', team: '여신정책부', updated: '2026-11-01', stars: 4.6, tags: ['공식규정', '여신'], authority_status: 'VERIFIED', freshness: 'CURRENT', document_type: 'REGULATION', basis: '기업여신 심사규정 제12조제2항', effective_from: '2026-11-01', reason: '찾는 내용과 조문이 직접 일치합니다' },
  { doc_id: 'doc_K001', title: '담보평가 실무 체크리스트', snippet: '감정평가서를 받은 뒤 3영업일 안에 담보 적정성 검토 결과를 등록한다.', team: '여신심사1팀', updated: '2026-10-21', stars: 4.4, tags: ['체크리스트', '여신'], authority_status: 'VERIFIED', freshness: 'CURRENT', document_type: 'KNOWHOW', basis: '기업여신 심사규정 제12조', effective_from: '2026-11-01', reason: '같은 업무 담당자가 자주 찾고, 근거 규정이 최신입니다' },
  { doc_id: 'doc_K003', title: '소액 담보 처리 팁 (2025)', snippet: '5억원 미만은 지점 전결로 처리할 수 있다.', team: '여신심사2팀', updated: '2025-06-02', stars: 4.8, tags: ['실무사례'], authority_status: 'VERIFIED', freshness: 'REVIEW_REQUIRED', document_type: 'KNOWHOW', basis: '기업여신 심사규정 제12조 (2025-01-01 개정 전)', effective_from: '2025-01-01', reason: '평점은 높지만 근거 규정이 개정되었습니다' },
];

function mock(method: string, path: string, body?: unknown): unknown {
  if (path.startsWith('/v1/search')) {
    const u = new URL(path, 'http://x');
    const tag = u.searchParams.get('tags');
    return { items: MOCK_ITEMS.filter((i) => !tag || i.tags.includes(tag)) }; // ponytail: mock은 질의 무관 전체 반환
  }
  if (/\/v1\/library\/.+\/external-laws/.test(path)) return { items: [{ law_name: '개인정보 보호법', clause: '제15조제1항', result: { source: '국가법령정보센터 (AgentCore Browser)', url: 'https://www.law.go.kr', fetched_at: '2026-11-17T02:00:00Z', from_cache: false, effective_from: '2026-09-11', note: '외부 공식 사이트 원문 참고용', clause: { path: 'ARTICLE:15/PARAGRAPH:1', text: '① 개인정보처리자는 다음 각 호의 어느 하나에 해당하는 경우에는 개인정보를 수집할 수 있으며…' } } }] };
  if (path.startsWith('/v1/library/')) {
    const d = MOCK_LIBRARY.find((x) => x.doc_id === decodeURIComponent(path.slice('/v1/library/'.length)));
    if (!d) throw new ApiError(404, 'document not found');
    return d;
  }
  if (path.startsWith('/v1/library')) {
    const u = new URL(path, 'http://x');
    const type = u.searchParams.get('type');
    const business = u.searchParams.get('business');
    return { items: MOCK_LIBRARY.filter((d) => (!type || d.document_type === type) && (!business || d.business_path.includes(business))) };
  }
  if (path === '/v1/documents/upload-url') return { doc_id: 'doc_MOCK', url: 'mock://upload' };
  if (path === '/v1/approvals?status=APPROVED' || path === '/v1/approvals?status=USED')
    return { items: path.endsWith('APPROVED') ? [{ approval_id: 'apr_STUCK', doc_id: 'doc_STUCK', title: '보안 테스트 문서', lifecycle: 'PENDING_APPROVAL', workflow_failure: { step: 'Promote', error: 'UnclassifiedDocument' } }] : [] };
  if (path === '/v1/approvals?status=PENDING')
    return { items: [
      { approval_id: 'apr_K001', doc_id: 'doc_K001', title: '담보평가 실무 체크리스트', detail: '작성자가 개인정보 마스킹을 확인했습니다.', stage: 2 },
    ] };
  if (path === '/v1/review-queue')
    return { items: [{ doc_id: 'doc_F003', title: '기업여신 심사규정 (출처 미확인 사본)', dept: '여신', findings: [{ message: '공식 원본과 내용 불일치 (조문 1개: ARTICLE:12/PARAGRAPH:1, 원본 5억원 · 업로드본 3억원). 위조 확정 아님, 출처 검토 필요', evidence_ref: 'SYN-LOAN-001@2026-11-01' }] }] };
  if (/\/v1\/documents\/.+\/source-review/.test(path)) return { lifecycle: 'BLOCKED' };
  if (/\/v1\/approvals\/.+\/decision/.test(path)) return { status: (body as { decision: string }).decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
  if (/\/v1\/documents\/.+\/analyze/.test(path)) { mockTick = 0; return { workflow_id: 'wf_MOCK' }; }
  if (/\/v1\/documents\/.+\/progress/.test(path)) return mockProgress();
  if (/\/v1\/documents\/.+\/issues/.test(path)) return MOCK_ISSUES;
  if (/\/v1\/documents\/.+\/review/.test(path)) return MOCK_REVIEW;
  if (/\/v1\/documents\/.+\/classification/.test(path)) return { document_type: (body as { document_type: string }).document_type };
  if (/\/v1\/documents\/.+\/submit/.test(path)) return { approval_id: 'apr_MOCK' };
  if (path === '/v1/guides') return MOCK_GUIDE;
  if (path === '/v1/feedback') return { ok: true };
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
export interface Finding { finding_id: string; step: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; code: string; message: string; evidence_ref: string }
export interface Review {
  doc_id: string; title?: string; lifecycle: string; trust_gate_result?: 'PASS' | 'REVIEW_REQUIRED' | 'QUARANTINED';
  authority_status: string;
  classification?: { document_type: 'REGULATION' | 'KNOWHOW' | 'MANUAL'; confidence: number; rationale: string; source?: 'MODEL' | 'HUMAN' };
  findings: Finding[]; masked_preview?: string;
  knowhow_validation?: KnowhowValidation;
  workflow_failure?: { step: string; error: string };
}
export interface KnowhowValidation {
  verdict: 'SUPPORTED' | 'CONFLICT' | 'OUTDATED' | 'INSUFFICIENT';
  items: { statement: string; provision_id: string; label: string; relation: 'SUPPORTS' | 'CONFLICTS' | 'UNRELATED' | 'INSUFFICIENT'; reason: string; quote: string; verified_quote: boolean }[];
  outdated: { cited: string; current: string; label: string }[];
  model?: string;
}
const MOCK_REVIEW: Review = {
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
    { finding_id: 'f2', step: 'PII_SCAN', severity: 'MEDIUM', code: 'PII_UNCERTAIN_ACCOUNT', message: '계좌번호 1건 가림 (그중 1건은 개인정보인지 확인 필요)', evidence_ref: 'page:2' },
    { finding_id: 'f3', step: 'OCR', severity: 'MEDIUM', code: 'OCR_LOW_CONFIDENCE', message: '인식 신뢰도가 낮은 페이지 (평균 0.86)', evidence_ref: 'page:3' },
  ],
  masked_preview: '1. 감정평가서를 받은 뒤 3영업일 안에 담보 적정성 검토 결과를 등록한다.\n2. 담당자 연락처 [전화번호]로 평가 일정을 확인한다.\n3. 입금 계좌 [계좌번호]는 고객 확인 후 기재한다.',
};

export interface Evidence { doc_id: string; title: string; snippet: string; provision?: string; effective_from?: string; authority_status: string; freshness: string }
export interface Guide { status: 'OK' | 'NO_EVIDENCE'; query_masked: boolean; model: string; evidence: Evidence[]; steps: { text: string; sources: Evidence[] }[]; dropped_steps: number; uncertainty: string }
const MOCK_GUIDE: Guide = {
  status: 'OK', query_masked: false, model: 'us.anthropic.claude-sonnet-4-6', dropped_steps: 0,
  evidence: [],
  steps: [
    { text: '담보가액이 3억원 이상이면 본부 승인을 받아야 하므로, 담보 4억원 건은 본부 승인 대상입니다.', sources: [{ doc_id: 'doc_F001', title: '기업여신 심사규정 v1', snippet: '', provision: '기업여신 심사규정 제12조제2항', effective_from: '2026-11-01', authority_status: 'VERIFIED', freshness: 'CURRENT' }] },
    { text: '감정평가서를 받은 뒤 3영업일 안에 담보 적정성 검토 결과를 등록합니다.', sources: [{ doc_id: 'doc_K001', title: '담보평가 실무 체크리스트', snippet: '', provision: '기업여신 심사규정 제12조', effective_from: '2026-11-01', authority_status: 'VERIFIED', freshness: 'CURRENT' }] },
  ],
  uncertainty: '"5억원 미만은 지점 전결" 팁은 개정 전 규정을 근거로 하고 있어 재검토 중입니다. 현행 기준은 3억원 이상 본부 승인입니다.',
};

// ---------- 문서보관함 (let522mj 요청 2220) ----------
export interface Mark {
  page: number | null; start: number | null; end: number | null; severity: 'HIGH' | 'MEDIUM' | 'LOW';
  kind: 'CONFLICT' | 'OUTDATED' | 'INSUFFICIENT' | 'REGISTRY_MISMATCH' | 'PII_UNCERTAIN' | 'INJECTION';
  reason: string; basis?: { provision_id: string; label: string; text: string; effective_from?: string }; fix?: string;
}
export interface LibraryCard {
  doc_id: string; title: string; document_type?: 'REGULATION' | 'KNOWHOW' | 'MANUAL'; lifecycle: string;
  business_path: string[]; tags: string[]; summary: string | null; authority_status: 'VERIFIED' | 'UNVERIFIED' | 'REJECTED';
  freshness: 'CURRENT' | 'REVIEW_REQUIRED' | 'SUPERSEDED'; effective_from: string | null; uploaded_at: string; updated_at: string; mark_count: number;
  freshness_reason?: { law_id: string; law_name: string; cited_revision: string; current_revision: string; effective_from: string; provisions: string[]; at: string } | null;
  related: { doc_id: string; title: string; relation: 'CITES' | 'CITED_BY' | 'CONFLICTS' | 'SIMILAR'; reason: string }[];
}
export interface Verification {
  method: string; basis: { what: string; label: string; result: string; quote?: string; effective_from?: string }[];
  checks: { trust_gate: string | null; verdict: string | null; checked_at: string | null };
  approved_by: string | null; approved_at: string | null; approval_reason: string | null;
}
export interface ExternalLaw { law_name: string; clause?: string; error?: string;
  result?: { source: string; url: string; fetched_at: string; from_cache: boolean; effective_from?: string; promulgation?: string; note: string; clause?: { path: string; text: string } | null } | null }
export interface LibraryDoc extends LibraryCard { doc_date?: { label: string; date: string } | null; verification?: Verification; doc_marks: Mark[]; pages: { page: number; text: string; summary: string | null; marks: Mark[] }[] }

const K002 = '소액 부동산 담보대출 빠른 처리 팁 (SYNTHETIC)\n1억원 이하 부동산 담보대출은 현장 실사를 생략하고 감정평가서만으로 처리한다. 실사 보고서는 나중에 작성해도 된다.';
export const MOCK_LIBRARY: LibraryDoc[] = [
  {
    doc_id: 'doc_K002', title: '소액 부동산 담보대출 빠른 처리 팁', document_type: 'KNOWHOW', lifecycle: 'PUBLISHED', business_path: ['여신', '담보'], tags: ['실무사례', '담보'],
    summary: '1억원 이하 부동산 담보대출을 빠르게 처리하는 요령입니다. 현장 실사를 생략하고 감정평가서만으로 처리하며, 실사 보고서는 사후에 작성한다고 안내합니다.',
    authority_status: 'UNVERIFIED', freshness: 'CURRENT', effective_from: null, uploaded_at: '2026-11-16T12:30:00Z', updated_at: '2026-11-16T12:31:00Z', mark_count: 2,
    related: [{ doc_id: 'doc_F001', title: '기업여신 심사규정', relation: 'CONFLICTS', reason: '기업여신 심사규정 제14조제1항' }],
    doc_marks: [],
    pages: [
      { page: 0, text: K002, summary: '금액 기준으로 현장 실사를 생략하는 처리 요령과 보고서 사후 작성을 안내합니다.', marks: [
        { page: 0, start: K002.indexOf('1억원'), end: K002.indexOf('처리한다.') + 5, severity: 'HIGH', kind: 'CONFLICT', reason: '규정은 담보가 부동산이면 금액과 관계없이 현장 실사를 반드시 하도록 정하고 있습니다.', basis: { provision_id: 'SYN-LOAN-001@2026-11-01/ARTICLE:14/PARAGRAPH:1', label: '기업여신 심사규정 제14조제1항', text: '① 담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다.', effective_from: '2026-11-01' }, fix: '근거 조문에 맞게 수정: "담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다."' },
        { page: 0, start: K002.indexOf('실사 보고서'), end: K002.length, severity: 'MEDIUM', kind: 'INSUFFICIENT', reason: '보고서 작성 시점에 대한 기준을 조문에서 찾지 못했습니다.', fix: '근거 조문을 명시하거나 담당 부서 확인' },
      ] },
    ],
  },
  {
    doc_id: 'doc_F001', title: '기업여신 심사규정', document_type: 'REGULATION', lifecycle: 'PUBLISHED', business_path: ['여신'], tags: ['공식규정'],
    summary: '기업여신 심사 절차와 승인 기준을 정합니다. 5억원 이상은 본부 승인, 부동산 담보는 금액과 관계없이 현장 실사를 해야 합니다.',
    authority_status: 'VERIFIED', freshness: 'CURRENT', effective_from: '2026-11-01', uploaded_at: '2026-11-16T10:50:00Z', updated_at: '2026-11-16T11:13:00Z', mark_count: 0,
    related: [{ doc_id: 'doc_K002', title: '소액 부동산 담보대출 빠른 처리 팁', relation: 'CONFLICTS', reason: '기업여신 심사규정 제14조제1항' }],
    doc_marks: [], pages: [{ page: 0, text: '제14조(현장 실사) ① 담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다.', summary: '부동산 담보의 현장 실사 의무를 정합니다.', marks: [] }],
  },
];

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
