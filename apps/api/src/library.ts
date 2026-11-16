// 문서보관함 (let522mj 요청 2220, 데이터 계약 v0). 카드·연관성은 저장된 결과만으로 조합한다 (모델 호출 없음).
// 밑줄(marks)은 let522mj buildMarks(@hanaeum/regulation-server)가 페이지·글자 위치로 바꾼다 (Deps.marks). 없으면 빈 목록.
import type { DocumentRecord } from './contracts.ts';

export type Relation = 'CITES' | 'CITED_BY' | 'CONFLICTS' | 'SIMILAR';
export interface Related { doc_id: string; title: string; relation: Relation; reason: string }
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
  const add = (r: Related) => { if (r.doc_id !== d.doc_id && (!out.has(r.doc_id) || r.relation === 'CONFLICTS')) out.set(r.doc_id, r); };
  for (const j of d.knowhow_validation?.items ?? []) {
    if (!j.verified_quote || (j.relation !== 'SUPPORTS' && j.relation !== 'CONFLICTS')) continue;
    // 인용한 개정판과 같은 문서 우선 (같은 규정의 시행 전 개정판으로 잘못 연결 방지)
    const regs = visible.filter((x) => x.law_id === lawOf(j.provision_id) && x.lifecycle === 'PUBLISHED');
    const reg = regs.find((x) => x.revision_id === revOf(j.provision_id)) ?? regs[0];
    if (reg) add({ doc_id: reg.doc_id, title: reg.title, relation: j.relation === 'CONFLICTS' ? 'CONFLICTS' : 'CITES', reason: j.label });
  }
  if (d.law_id) for (const k of visible) {
    const hit = k.knowhow_validation?.items.find((j) => j.verified_quote && lawOf(j.provision_id) === d.law_id && (j.relation === 'SUPPORTS' || j.relation === 'CONFLICTS'));
    if (hit) add({ doc_id: k.doc_id, title: k.title, relation: hit.relation === 'CONFLICTS' ? 'CONFLICTS' : 'CITED_BY', reason: hit.label });
  }
  return [...out.values()];
}

export function card(d: DocumentRecord, visible: DocumentRecord[]) {
  return {
    doc_id: d.doc_id, title: d.title, document_type: d.document_type ?? d.classification?.document_type, lifecycle: d.lifecycle,
    business_path: d.classification?.business_path ?? [], tags: d.classification?.tags ?? [], summary: d.summary ?? null,
    authority_status: d.authority_status, freshness: d.freshness, effective_from: d.effective_from ?? null,
    uploaded_at: d.created_at, updated_at: d.updated_at, freshness_reason: d.freshness_reason ?? null,
    mark_count: markCount(d), related: related(d, visible),
  };
}

export function matches(d: DocumentRecord, f: { type?: string; business?: string; tag?: string; q?: string }) {
  const c = d.classification;
  return (!f.type || (d.document_type ?? c?.document_type) === f.type)
    && (!f.business || (c?.business_path ?? []).includes(f.business))
    && (!f.tag || (c?.tags ?? []).includes(f.tag))
    && (!f.q || `${d.title} ${d.summary ?? ''}`.toLowerCase().includes(f.q.toLowerCase()));
}

/** 본문에 적힌 문서 자체 일자 (개정일·시행일·작성일·제정일). 업로드 시각과 다르다 */
export function docDate(pages: Page[]): { label: string; date: string } | null {
  for (const p of pages) {
    const m = /(개정일|시행일|작성일|제정일|발행일)[^\d\n]{0,20}(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/.exec(p.text);
    if (m) return { label: m[1]!, date: `${m[2]}-${m[3]!.padStart(2, '0')}-${m[4]!.padStart(2, '0')}` };
  }
  return null;
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
    const REL: Record<string, string> = { SUPPORTS: '규정과 일치', CONFLICTS: '규정과 충돌', UNRELATED: '관련 없음', INSUFFICIENT: '판단 근거 부족' };
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
