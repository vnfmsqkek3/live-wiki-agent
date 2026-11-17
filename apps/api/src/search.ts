// /v1/search: let522mj search_wiki를 같은 프로세스에서 호출한다 (ACL·현재 상태 재검증은 Tool이 actor로 강제).
// ponytail: 사용자 Gateway가 생기면 가이드 Agent처럼 사용자 토큰으로 Gateway 호출로 바꿀 수 있다 (계약 동일)
import type { Actor } from './contracts.ts';

export interface SearchHit {
  doc_id: string; title: string; snippet: string; provision?: string; effective_from: string;
  authority_status: string; freshness: string; search_status: string; document_type: string; business_path?: string[]; tags?: string[];
}
export type SearchWiki = (args: Record<string, unknown>, actor: { sub: string; groups: string[]; dept?: string }) => Promise<{ items?: SearchHit[] }>;

/** 화면 검색 항목. 이유는 결과 상태로만 설명한다 (모델 생성 아님) */
export const toItem = (h: SearchHit) => ({
  doc_id: h.doc_id, title: h.title, snippet: h.snippet, document_type: h.document_type,
  authority_status: h.authority_status, freshness: h.freshness, effective_from: h.effective_from || undefined,
  basis: h.provision, tags: h.tags ?? [], business_path: h.business_path ?? [], search_status: h.search_status,
  reason: h.search_status === 'HISTORICAL' ? '현재 시행 중이 아닌 과거 조문입니다'
    : h.freshness === 'REVIEW_REQUIRED' ? '근거 규정이 바뀌어 재검토 중인 문서입니다'
    : h.provision ? '찾는 내용과 조문이 일치합니다' : '찾는 내용과 관련된 승인 문서입니다',
});

export function searchVia(searchWiki: SearchWiki) {
  return async (q: string, a: Actor, o: { tags: string[]; as_of?: string; business?: string; index_groups?: string[] }) => {
    const r = await searchWiki({ query: q, top_k: 10, ...(o.tags.length ? { tags: o.tags } : {}), ...(o.business ? { business: o.business } : {}), ...(o.as_of ? { as_of: o.as_of } : {}), ...(o.index_groups ? { index_groups: o.index_groups } : {}) },
      { sub: a.sub, groups: a.groups, ...(a.dept ? { dept: a.dept } : {}) });
    return (r.items ?? []).map(toItem);
  };
}
