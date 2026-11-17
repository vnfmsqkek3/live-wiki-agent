// /v1/search: let522mj search_wiki를 같은 프로세스에서 호출한다 (ACL·현재 상태 재검증은 Tool이 actor로 강제).
// ponytail: 사용자 Gateway가 생기면 가이드 Agent처럼 사용자 토큰으로 Gateway 호출로 바꿀 수 있다 (계약 동일)
import type { Actor } from './contracts.ts';
import type { DetailFilter } from './library.ts';

export interface SearchHit {
  doc_id: string; title: string; snippet: string; provision?: string; effective_from: string;
  authority_status: string; freshness: string; search_status: string; document_type: string; business_path?: string[]; tags?: string[];
  /** 근거가 나온 쪽 (1부터, let522mj). 그림 썸네일용 */
  page?: number;
  quotable?: boolean; evidence_kind?: 'FIGURE'; page_context?: string;
}
/** 질의 재구성 (let522mj search_wiki, 요청기록/20261117-1910 1장): 문장형 질의를 핵심 검색어 + 대안 ≤2로 */
export interface Rewritten { core: string; alternates: string[] }
export type SearchWiki = (args: Record<string, unknown>, actor: { sub: string; groups: string[]; dept?: string }) => Promise<{ items?: SearchHit[]; related?: SearchHit[]; rewritten?: Rewritten }>;

/** 화면 검색 항목. 이유는 결과 상태로만 설명한다 (모델 생성 아님) */
export const toItem = (h: SearchHit) => ({
  doc_id: h.doc_id, title: h.title, snippet: h.snippet, document_type: h.document_type,
  authority_status: h.authority_status, freshness: h.freshness, effective_from: h.effective_from || undefined,
  basis: h.provision, tags: h.tags ?? [], business_path: h.business_path ?? [], search_status: h.search_status, ...(h.page ? { page: h.page } : {}),
  // 가이드·화면이 그림 기준 근거를 구분하도록 버리지 않는다 (let522mj PR #42)
  quotable: h.quotable, ...(h.evidence_kind ? { evidence_kind: h.evidence_kind } : {}), ...(h.page_context ? { page_context: h.page_context } : {}),
  reason: h.search_status === 'HISTORICAL' ? '현재 시행 중이 아닌 과거 조문입니다'
    : h.freshness === 'REVIEW_REQUIRED' ? '근거 규정이 바뀌어 재검토 중인 문서입니다'
    : h.provision ? '찾는 내용과 조문이 일치합니다' : '찾는 내용과 관련된 승인 문서입니다',
});

/** 검색 결과 배열 + 재구성 질의 (배열에 붙여 기존 호출부 모양을 유지) */
export type SearchResult = (ReturnType<typeof toItem> & { weak?: true })[] & { rewritten?: Rewritten };

export function searchVia(searchWiki: SearchWiki) {
  return async (q: string, a: Actor, o: { tags: string[]; as_of?: string; index_groups?: string[]; rewrite?: boolean } & DetailFilter): Promise<SearchResult> => {
    const { tags, rewrite, ...rest } = o; // 세부 필터는 search_wiki 인자 이름 그대로 (값이 있는 것만)
    // rewrite=false: '원래 질의로 찾기'. 기본(생략)은 search_wiki가 재구성
    const r = await searchWiki({ query: q, top_k: 10, ...(tags.length ? { tags } : {}), ...(rewrite === false ? { rewrite: false } : {}), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v)) },
      { sub: a.sub, groups: a.groups, ...(a.dept ? { dept: a.dept } : {}) });
    // related: 재정렬 점수가 약해(0.10~0.30) 근거로 확인되지 않은 관련 문서 (let522mj PR #22). weak 표시로 뒤에 붙인다
    const out: SearchResult = [...(r.items ?? []).map(toItem), ...(r.related ?? []).map((h) => ({ ...toItem(h), weak: true as const, reason: '관련 있을 수 있지만 정확한 근거로 확인되지는 않았습니다' }))];
    // 핵심어가 원문과 같아도 다른 표현(alternates)은 추천 칩으로 쓴다. 둘 다 없으면 생략
    const alt = (r.rewritten?.alternates ?? []).filter((x) => x.trim() && x.trim() !== q.trim()).slice(0, 2);
    if (r.rewritten?.core && (r.rewritten.core.trim() !== q.trim() || alt.length)) out.rewritten = { core: r.rewritten.core, alternates: alt };
    return out;
  };
}

/** 검색 결과를 문서 단위로 묶는다 (search_wiki는 근거 인용용 조문 단위). 순서는 각 문서의 최고 순위,
 *  카드 안에는 맞은 조문(조문 표기·인용) 목록. 가이드 근거는 조문 단위 그대로 쓴다 (사용자 지적 11/17) */
export function groupByDoc<T extends { doc_id: string; basis?: string; snippet: string; page?: number }>(hits: T[]) {
  const by = new Map<string, T & { matches: { basis?: string; snippet: string; page?: number }[] }>();
  for (const h of hits) {
    const g = by.get(h.doc_id);
    if (g) { if (!g.matches.some((m) => m.basis === h.basis && m.snippet === h.snippet)) g.matches.push({ basis: h.basis, snippet: h.snippet, ...(h.page ? { page: h.page } : {}) }); }
    else by.set(h.doc_id, { ...h, matches: [{ basis: h.basis, snippet: h.snippet, ...(h.page ? { page: h.page } : {}) }] });
  }
  return [...by.values()];
}
