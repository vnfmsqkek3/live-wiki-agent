// 문서보관함 (let522mj 요청 2220, 데이터 계약 v0). 카드·연관성은 저장된 결과만으로 조합한다 (모델 호출 없음).
// 밑줄(marks)은 let522mj buildMarks(@hanaeum/regulation-server)가 페이지·글자 위치로 바꾼다 (Deps.marks). 없으면 빈 목록.
import { docDates, primaryDate, type DocDate } from '@hanaeum/legal-parser';
import type { DocumentRecord } from './contracts.ts';

export type Relation = 'CITES' | 'CITED_BY' | 'CONFLICTS' | 'SIMILAR';
export interface Related { doc_id: string; title: string; relation: Relation; reason: string; document_type?: string }
export interface Mark {
  /** pages 배열 인덱스. 위치를 못 찾으면 null → 문서 단위 표시 */
  page: number | null; start: number | null; end: number | null; severity: 'HIGH' | 'MEDIUM' | 'LOW';
  kind: 'CONFLICT' | 'OUTDATED' | 'INSUFFICIENT' | 'REGISTRY_MISMATCH' | 'PII_UNCERTAIN' | 'INJECTION';
  reason: string; basis?: { provision_id: string; label: string; text: string; effective_from: string }; fix?: string;
}
export interface Page { page: number; text: string }

const lawOf = (provision_id: string) => provision_id.split('@')[0]!;
const revOf = (provision_id: string) => provision_id.split('@')[1]?.split('/')[0];

/** 밑줄 후보 수 (목록용). 모델 판단은 인용 원문 대조 통과분만 센다 */
export function markCount(d: DocumentRecord) {
  const kv = d.knowhow_validation;
  const judged = (kv?.items ?? []).filter((j) => j.verified_quote && (j.relation === 'CONFLICTS' || j.relation === 'INSUFFICIENT')).length;
  const found = d.findings.filter((f) => f.code === 'REGISTRY_MISMATCH' || f.code.startsWith('PII_UNCERTAIN') || f.step === 'INJECTION_SCAN').length;
  return judged + (kv?.outdated.length ?? 0) + found;
}

/** 연관 문서: 노하우 판정 근거 규정(CITES·CONFLICTS), 규정을 근거로 쓴 노하우(CITED_BY). 열람 가능한 문서(visible)만 */
export function related(d: DocumentRecord, visible: DocumentRecord[]): Related[] {
  const out = new Map<string, Related>();
  const typeOf = (id: string) => { const x = visible.find((v) => v.doc_id === id); return x?.document_type ?? x?.classification?.document_type; };
  const add = (r: Related) => { if (r.doc_id !== d.doc_id && (!out.has(r.doc_id) || r.relation === 'CONFLICTS')) out.set(r.doc_id, { ...r, ...(typeOf(r.doc_id) ? { document_type: typeOf(r.doc_id) } : {}) }); };
  for (const j of d.knowhow_validation?.items ?? []) {
    if (!j.verified_quote || (j.relation !== 'SUPPORTS' && j.relation !== 'SUPPLEMENTS' && j.relation !== 'CONFLICTS')) continue;
    // 인용한 개정판과 같은 문서 우선 (같은 규정의 시행 전 개정판으로 잘못 연결 방지)
    const regs = visible.filter((x) => x.law_id === lawOf(j.provision_id) && x.lifecycle === 'PUBLISHED');
    const reg = regs.find((x) => x.revision_id === revOf(j.provision_id)) ?? regs[0];
    if (reg) add({ doc_id: reg.doc_id, title: reg.title, relation: j.relation === 'CONFLICTS' ? 'CONFLICTS' : 'CITES', reason: j.label });
  }
  // 매뉴얼·노하우 본문이 직접 인용한 규정 (citations)
  for (const c of d.citations ?? []) {
    const regs = visible.filter((x) => x.law_id === lawOf(c.provision_id) && x.lifecycle === 'PUBLISHED');
    const reg = regs.find((x) => x.revision_id === revOf(c.provision_id)) ?? regs[0];
    if (reg) add({ doc_id: reg.doc_id, title: reg.title, relation: 'CITES', reason: c.evidence_span });
  }
  if (d.law_id) for (const k of visible) {
    const hit = k.knowhow_validation?.items.find((j) => j.verified_quote && lawOf(j.provision_id) === d.law_id && (j.relation === 'SUPPORTS' || j.relation === 'SUPPLEMENTS' || j.relation === 'CONFLICTS'));
    if (hit) add({ doc_id: k.doc_id, title: k.title, relation: hit.relation === 'CONFLICTS' ? 'CONFLICTS' : 'CITED_BY', reason: hit.label });
    else {
      const c = (k.citations ?? []).find((x) => lawOf(x.provision_id) === d.law_id);
      if (c) add({ doc_id: k.doc_id, title: k.title, relation: 'CITED_BY', reason: c.evidence_span });
    }
  }
  return [...out.values()];
}

export function card(d: DocumentRecord, visible: DocumentRecord[]) {
  return {
    doc_id: d.doc_id, title: d.title, document_type: d.document_type ?? d.classification?.document_type, lifecycle: d.lifecycle, dept: d.dept,
    business_path: d.classification?.business_path ?? [], tags: d.classification?.tags ?? [], summary: d.summary ?? null,
    authority_status: d.authority_status, freshness: d.freshness, effective_from: d.effective_from ?? null,
    uploaded_at: d.created_at, updated_at: d.updated_at, freshness_reason: d.freshness_reason ?? null,
    mark_count: markCount(d), related: related(d, visible),
    doc_dates: d.doc_dates ?? [], version_no: d.version_no ?? null, superseded_by: d.superseded_by ?? null,
  };
}

/** 검색·보관함 세부 필터 (사용자 요청 11/17). search_wiki 인자와 같은 이름 */
export interface DetailFilter { business?: string; dept?: string; date_from?: string; date_to?: string; authority_status?: string; freshness?: string }
const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** 쿼리 문자열 → 검증된 세부 필터. 형식이 틀린 값은 버린다 */
export function detailFilter(get: (k: string) => string | undefined): DetailFilter {
  const v = (k: string, ok: (x: string) => boolean) => { const x = get(k)?.trim().slice(0, 40); return x && ok(x) ? x : undefined; };
  const f: DetailFilter = {
    business: v('business', () => true), dept: v('dept', () => true),
    date_from: v('date_from', (x) => YMD.test(x)), date_to: v('date_to', (x) => YMD.test(x)),
    authority_status: v('authority_status', (x) => ['VERIFIED', 'UNVERIFIED'].includes(x)), freshness: v('freshness', (x) => ['CURRENT', 'REVIEW_REQUIRED'].includes(x)),
  };
  return Object.fromEntries(Object.entries(f).filter(([, x]) => x)) as DetailFilter;
}

export function matches(d: DocumentRecord, f: { type?: string; tag?: string; q?: string } & DetailFilter) {
  const c = d.classification;
  const date = d.doc_date?.date;
  return (!f.type || (d.document_type ?? c?.document_type) === f.type)
    && (!f.dept || d.dept === f.dept)
    && (!f.authority_status || d.authority_status === f.authority_status)
    && (!f.freshness || d.freshness === f.freshness)
    && (!f.date_from || (!!date && date >= f.date_from))
    && (!f.date_to || (!!date && date <= f.date_to))
    && (!f.business || (c?.business_path ?? [])[0] === f.business || (c?.business_path ?? []).includes(f.business))
    && (!f.tag || (c?.tags ?? []).includes(f.tag))
    && (!f.q || `${d.title} ${d.summary ?? ''}`.toLowerCase().includes(f.q.toLowerCase()));
}

/** 본문에 적힌 문서 자체 일자 (시행·개정·제정·작성·발행·기준, legal-parser). 업로드 시각과 다르다.
 *  Classify가 저장한 doc_dates가 없으면(이전 문서) 쪽 본문에서 바로 찾는다. 대표 일자는 시행 > 개정 > … 순 */
export function docDatesOf(d: DocumentRecord, pages: Page[]) {
  const dates = d.doc_dates ?? docDates(pages.map((p) => p.text)).map((x) => ({ ...x, page: pages[x.page]?.page ?? x.page }));
  const main = d.doc_date ?? primaryDate(dates as DocDate[]);
  return { doc_dates: dates, doc_date: main ? { label: `${main.kind}일`, date: main.date } : null };
}

/** 상세 '검증 정보': 누가·언제 승인했는지, 무엇과 비교해 검증했는지 */
export function verification(d: DocumentRecord, approval?: { approver_sub?: string; approver_name?: string; decided_at?: string; reason?: string }) {
  const type = d.document_type ?? d.classification?.document_type;
  const kv = d.knowhow_validation;
  const basis: { what: string; label: string; result: string; quote?: string; effective_from?: string }[] = [];
  let method: string;
  if (type === 'REGULATION') {
    method = '공식 원본(Trusted Registry)과 파일 해시 대조';
    const mismatch = d.findings.find((f) => f.code === 'REGISTRY_MISMATCH');
    basis.push({ what: '공식 원본', label: `${d.law_name ?? d.title}${d.revision_id ? ` (${d.revision_id} 시행본)` : ''}${d.registry_doc_no ? ` · 문서번호 ${d.registry_doc_no}` : ''}`,
      result: d.authority_status === 'VERIFIED' ? '공식 원본과 일치' : mismatch ? '공식 원본과 다름' : '공식 원본 목록에 없음', ...(d.effective_from ? { effective_from: d.effective_from } : {}) });
  } else if (type === 'KNOWHOW') {
    method = kv ? '노하우 문장을 근거 규정 조문과 비교(AI 판정 + 인용 원문 대조) 후 사람 승인' : '근거 규정 비교 없이 사람 승인';
    const REL: Record<string, string> = { SUPPORTS: '근거 확인됨(규정과 일치)', SUPPLEMENTS: '규정 범위 안의 실무 보완', CONFLICTS: '규정과 어긋남', UNRELATED: '관련 없음', INSUFFICIENT: '관련 조문 확인 필요' };
    for (const j of kv?.items ?? []) if (j.relation !== 'UNRELATED') basis.push({ what: '근거 조문', label: j.label, result: `${REL[j.relation] ?? j.relation}${j.verified_quote ? '' : ' (인용 원문 확인 안 됨)'}`, ...(j.quote ? { quote: j.quote } : {}) });
    for (const o of kv?.outdated ?? []) basis.push({ what: '개정 전 인용', label: o.label, result: '현행 조문으로 재검토 필요' });
  } else {
    method = '규정 대조 대상이 아닌 문서(매뉴얼 등): 자동 보안·개인정보 검사 후 사람 승인';
  }
  return {
    method, basis,
    checks: { trust_gate: d.trust_gate_result ?? null, verdict: kv?.verdict ?? null, checked_at: kv?.checked_at ?? null },
    approved_by: approval ? (approval.approver_name || `관리자 계정(${(approval.approver_sub ?? '').slice(0, 8)})`) : null,
    approved_at: approval?.decided_at ?? null, approval_reason: approval?.reason ?? null,
  };
}

/** 내용이 비슷한 다른 문서 (검색으로 찾음). 유형마다 최대 2건, 이미 연결된 문서·자기 자신 제외 → 매뉴얼·규정·노하우 상호 보완 */
export function similar(d: DocumentRecord, hits: { doc_id: string; title: string; document_type?: string }[], visible: DocumentRecord[], already: Related[]): Related[] {
  const seen = new Set([d.doc_id, ...already.map((r) => r.doc_id)]);
  const per: Record<string, number> = {};
  const NAME: Record<string, string> = { REGULATION: '규정', KNOWHOW: '노하우', MANUAL: '매뉴얼' };
  const out: Related[] = [];
  for (const h of hits) {
    const v = visible.find((x) => x.doc_id === h.doc_id && x.lifecycle === 'PUBLISHED');
    const t = v?.document_type ?? v?.classification?.document_type ?? h.document_type ?? 'KNOWHOW';
    if (!v || seen.has(h.doc_id) || (per[t] ?? 0) >= 2) continue;
    seen.add(h.doc_id); per[t] = (per[t] ?? 0) + 1;
    out.push({ doc_id: h.doc_id, title: v.title, relation: 'SIMILAR', reason: `내용이 비슷한 ${NAME[t] ?? t}`, document_type: t });
  }
  return out;
}

/** 제목·요약 일치로 찾은 게시 문서를 검색 결과 항목 형태로 */
export function keywordItem(d: DocumentRecord) {
  return {
    doc_id: d.doc_id, title: d.title, snippet: d.summary ?? '', document_type: d.document_type ?? d.classification?.document_type,
    authority_status: d.authority_status, freshness: d.freshness, effective_from: d.effective_from,
    basis: undefined, tags: d.classification?.tags ?? [], business_path: d.classification?.business_path ?? [],
    search_status: 'FOUND', reason: '제목·요약에 검색어가 들어 있습니다',
  };
}

// ---- 한 문서 = 한 묶음 (사용자 지적 11/17 "공식규정이 여러 문서로 쪼개져 보인다", let522mj 요청) ----
const typeOf = (d: DocumentRecord) => d.document_type ?? d.classification?.document_type;
/** 묶음 키: 작성자가 연결한 series_id, 공식 규정은 Registry law_id(공식 근거라 자동), 그 밖은 문서 자신 */
export const seriesKey = (d: DocumentRecord) => d.series_id ?? (typeOf(d) === 'REGULATION' && d.law_id ? `LAW#${d.law_id}` : d.doc_id);
const day = (s?: string) => (s ? String(s).slice(0, 10) : '');
/** 묶음 안 버전 순서(오래된 것 → 새것): 규정은 시행일·개정 ID, 그 밖은 version_no·등록일. version_no가 없으면 순서대로 매긴다 */
export function orderVersions(series: DocumentRecord[]) {
  const key = (d: DocumentRecord) => typeOf(d) === 'REGULATION' ? `${day(d.effective_from) || day(d.revision_id)}|${d.revision_id ?? ''}` : `${String(d.version_no ?? 1).padStart(4, '0')}|${d.created_at}`;
  return [...series].sort((a, b) => key(a).localeCompare(key(b))).map((d, i) => ({ d, version_no: d.version_no ?? i + 1 }));
}
/** 대표 버전: 오늘 시행 중인 게시본(시행일 ≤ 오늘, 대체·종료 안 됨). 없으면 가장 새 게시본, 그것도 없으면 가장 새 것 */
export function representative(series: DocumentRecord[], today = new Date().toISOString().slice(0, 10)) {
  const ord = orderVersions(series).map((x) => x.d);
  const pub = ord.filter((d) => d.lifecycle === 'PUBLISHED' && d.freshness !== 'SUPERSEDED');
  // 시행일이 없으면 개정 ID(날짜 형식)를 시행일로 본다 (Registry revision_id = 'YYYY-MM-DD')
  const from = (d: DocumentRecord) => day(d.effective_from) || (/^\d{4}-\d{2}-\d{2}/.test(d.revision_id ?? '') ? day(d.revision_id) : '');
  const inForce = pub.filter((d) => (!from(d) || from(d) <= today) && (!d.effective_to || day(d.effective_to) >= today));
  return inForce.at(-1) ?? pub.at(-1) ?? ord.at(-1)!;
}
export function groupSeries(docs: DocumentRecord[]) {
  const by = new Map<string, DocumentRecord[]>();
  for (const d of docs) (by.get(seriesKey(d)) ?? by.set(seriesKey(d), []).get(seriesKey(d))!).push(d);
  return by;
}
