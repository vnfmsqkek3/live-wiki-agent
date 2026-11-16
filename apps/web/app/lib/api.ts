'use client';
// API·인증 클라이언트. NEXT_PUBLIC_API_URL이 없으면 합성 mock으로 동작한다 (11/17 공유 dev 연동 전).
// 버튼 노출은 편의일 뿐 권한은 서버가 강제한다 (01 §3.1).

const API = process.env.NEXT_PUBLIC_API_URL;
const REGION = process.env.NEXT_PUBLIC_AWS_REGION ?? 'us-east-1';
const CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
export const MOCK = !API;

export type Role = 'USER' | 'AUTHOR' | 'REG_APPROVER' | 'SECURITY_REVIEWER' | 'PLATFORM_OPERATOR';
export interface Session { token: string; groups: Role[]; username: string }

const KEY = 'hanaeum.session';
// ponytail: sessionStorage(탭 단위). XSS 노출면이 있으므로 prod 전 Cognito managed login + httpOnly 쿠키 검토
export function getSession(): Session | undefined {
  try { const s = sessionStorage.getItem(KEY); return s ? (JSON.parse(s) as Session) : undefined; } catch { return undefined; }
}
export function logout() { try { sessionStorage.removeItem(KEY); } catch { /* 저장소 차단 시 무시 */ } }

export async function login(username: string, password: string): Promise<Session> {
  let s: Session;
  if (MOCK || !CLIENT_ID) {
    const groups: Role[] = username.includes('approver') ? ['REG_APPROVER'] : username.includes('author') ? ['AUTHOR'] : ['USER'];
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
  if (!r.ok) throw new ApiError(r.status, j.error?.message ?? `HTTP ${r.status}`);
  return j as T;
}

// ---------- 합성 mock (한빛은행 · SYNTHETIC) ----------
export interface SearchItem {
  doc_id: string; title: string; snippet: string; team: string; updated: string; stars: number;
  tags: string[]; authority_status: 'VERIFIED' | 'UNVERIFIED'; freshness: 'CURRENT' | 'REVIEW_REQUIRED';
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
  if (path === '/v1/documents/upload-url') return { doc_id: 'doc_MOCK', url: 'mock://upload' };
  if (path === '/v1/approvals?status=PENDING')
    return { items: [
      { approval_id: 'apr_K001', doc_id: 'doc_K001', title: '담보평가 실무 체크리스트', detail: '작성자가 개인정보 마스킹을 확인했습니다.', stage: 2 },
    ] };
  if (path === '/v1/review-queue')
    return { items: [{ doc_id: 'doc_F003', title: '기업여신 심사규정 (출처 미확인 사본)', dept: '여신', findings: [{ message: '공식 원본과 내용 불일치 (조문 1개: ARTICLE:12/PARAGRAPH:1, 원본 5억원 · 업로드본 3억원). 위조 확정 아님, 출처 검토 필요', evidence_ref: 'SYN-LOAN-001@2026-11-01' }] }] };
  if (/\/v1\/documents\/.+\/source-review/.test(path)) return { lifecycle: 'BLOCKED' };
  if (/\/v1\/approvals\/.+\/decision/.test(path)) return { status: (body as { decision: string }).decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
  if (/\/v1\/documents\/.+\/analyze/.test(path)) return { workflow_id: 'wf_MOCK' };
  if (/\/v1\/documents\/.+\/review/.test(path)) return MOCK_REVIEW;
  if (/\/v1\/documents\/.+\/classification/.test(path)) return { document_type: (body as { document_type: string }).document_type };
  if (/\/v1\/documents\/.+\/submit/.test(path)) return { approval_id: 'apr_MOCK' };
  if (path === '/v1/guides') return MOCK_GUIDE;
  if (path === '/v1/feedback') return { ok: true };
  throw new ApiError(404, `mock 없음: ${method} ${path}`);
}

export async function uploadFile(url: string, file: File) {
  if (url.startsWith('mock://')) return;
  const r = await fetch(url, { method: 'PUT', body: file });
  if (!r.ok) throw new ApiError(r.status, '파일 업로드 실패');
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
