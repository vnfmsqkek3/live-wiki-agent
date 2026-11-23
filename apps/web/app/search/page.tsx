'use client';
import { PaginatedList } from '../paginated-list';
import { PageHeader } from '../page-header';
// 02 검색 결과: 권한이 적용된 적합도순. 행마다 인장, 근거 조문, 시행일, 평점(신뢰와 분리)
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError, type LibraryCard, type SearchItem } from '../lib/api';
import { FreshnessFlag, Popularity, Scheduled, Seal } from '../seal';
import { PageThumb } from '../page-thumb';
import { ModeTabs } from '../mode-tabs';

/** 첫 화면 예시 질문 (데모 01·05 포함). 누르면 바로 검색 */
const EXAMPLES = ['담보평가 시 확인 절차는?', '제12조제2항제3호가목', '해외송금 증빙 한도', '고액 현금 인출 기준', '개인정보 보관 기간'];
const TYPE_LABEL: Record<string, string> = { REGULATION: '규정', KNOWHOW: '노하우', MANUAL: '매뉴얼' };
const DETAIL_LABEL: Record<string, string> = { business: '업무', dept: '부서', date_from: '일자부터', date_to: '일자까지', authority_status: '검증', freshness: '최신성' };
const VALUE_LABEL: Record<string, string> = { VERIFIED: '검증됨', UNVERIFIED: '미검증', CURRENT: '현행', REVIEW_REQUIRED: '재검토 필요' };

// 문서 종류로 거른다 (태그는 AI가 붙인 자유 문구라 필터로 쓰면 0건이 되기 쉽다)
const FILTERS = [['', '전체'], ['REGULATION', '규정'], ['KNOWHOW', '노하우'], ['MANUAL', '매뉴얼']] as const;

/** 세부 필터 (사용자 요청 11/17). 주소 쿼리 그대로 /v1/search·/v1/library에 넘긴다 */
const DETAIL = ['business', 'dept', 'date_from', 'date_to', 'authority_status', 'freshness'] as const;
type Detail = Partial<Record<(typeof DETAIL)[number], string>>;

function DetailFilters({ value, options, onApply }: { value: Detail; options: { business: string[]; dept: string[] }; onApply: (d: Detail) => void }) {
  const [d, setD] = useState<Detail>(value);
  useEffect(() => { setD(value); }, [value]);
  const n = DETAIL.filter((k) => value[k]).length;
  const set = (k: keyof Detail) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value || undefined }));
  return (
    <details className="detail-filter">
      <summary>세부 필터{n > 0 && <span className="note"> {n}개 적용</span>}</summary>
      <div className="filter-grid">
        <label className="lbl">업무<select className="field" value={d.business ?? ''} onChange={set('business')}><option value="">전체</option>{options.business.map((b) => <option key={b}>{b}</option>)}</select></label>
        <label className="lbl">부서<select className="field" value={d.dept ?? ''} onChange={set('dept')}><option value="">전체</option>{options.dept.map((b) => <option key={b}>{b}</option>)}</select></label>
        <label className="lbl">문서 일자 시작<input className="field" type="date" value={d.date_from ?? ''} onChange={set('date_from')} /></label>
        <label className="lbl">문서 일자 끝<input className="field" type="date" value={d.date_to ?? ''} onChange={set('date_to')} /></label>
        <label className="lbl">검증 상태<select className="field" value={d.authority_status ?? ''} onChange={set('authority_status')}><option value="">전체</option><option value="VERIFIED">검증됨</option><option value="UNVERIFIED">미검증</option></select></label>
        <label className="lbl">최신성<select className="field" value={d.freshness ?? ''} onChange={set('freshness')}><option value="">전체</option><option value="CURRENT">현행</option><option value="REVIEW_REQUIRED">재검토 필요</option></select></label>
      </div>
      <p className="note">문서 일자는 본문에 적힌 시행·개정·작성일입니다. 일자가 없는 문서는 기간을 정하면 빠집니다.</p>
      <div className="actions"><button type="button" className="btn solid" onClick={() => onApply(d)}>필터 적용</button>{n > 0 && <button type="button" className="btn" onClick={() => onApply({})}>초기화</button>}</div>
    </details>
  );
}

/** 조각 표시용 정리 (Fable 권고 11/18): 원문(snippet)은 그대로 두고 화면에서만 줄인다.
 *  그림 설명(원문 아님)은 머리표·'screenshot:' 을 떼고 '표기:' 값만(없으면 묘사 첫 문장), '의도:'(AI 추정)는 숨김 */
type Match = NonNullable<SearchItem['matches']>[number];
function showMatch(m: Match): { badge?: string; text: string } {
  const head = /^\[(그림 설명 · 원문 아님|그림 기준 · AI 정리)\]\s*/.exec(m.snippet);
  // 표 조각은 '|' 원문 대신 행마다 '칸 · 칸'으로 (11/18 dev 시험: 검색 결과에 마크다운 표 원문)
  const untable = (t: string) => t.split('\n').filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => (/^\s*\|.*\|\s*$/.test(l) ? l.replace(/^\s*\||\|\s*$/g, '').split('|').map((x) => x.trim() || '—').join(' · ') : l)).join(' / ');
  if (!head && m.quotable !== false && m.evidence_kind !== 'FIGURE') { const t = m.snippet.replace(/^#{1,6}\s+/gm, ''); return { text: /\|.*\|/.test(t) ? untable(t) : t }; } // '#' 제목 기호 제거 (엔드유저 11/20)
  const body = m.snippet.replace(/^\[[^\]]*\]\s*/, '');
  if (m.evidence_kind === 'FIGURE' || head?.[1] === '그림 기준 · AI 정리') return { badge: '그림 기준 · AI 정리', text: body };
  const parts = body.split(/\s+\/\s+(?=(?:표기|의도):)/);
  const label = parts.find((x) => x.startsWith('표기:'))?.replace(/^표기:\s*/, '');
  const first = (parts[0] ?? body).replace(/^[a-z_]+:\s*/i, '').split(/(?<=[.다])\s+/)[0] ?? '';
  return { badge: '그림 · 원문 아님', text: label || first };
}
function MatchItem({ m, docId }: { m: Match; docId: string }) {
  const v = showMatch(m);
  return <li className={m.page ? 'with-thumb' : undefined}>
    <PageThumb docId={docId} page={m.page} />
    {(m.basis || v.badge || m.page) && <p className="match-basis">{v.badge && <span className="fig-badge">{v.badge}</span>}{m.page && v.badge ? ` ${m.page}쪽` : ''}{m.page_context ? ` · ${m.page_context}` : ''}{m.basis && !v.badge ? m.basis : ''}</p>}
    <blockquote className={m.basis && !v.badge ? undefined : 'clamp'}>{v.text}</blockquote>
  </li>;
}
/** 기본은 앞 limit 개만, 나머지는 접기. 원문 조각을 그림 조각보다 앞에. 규정은 '조문', 그 밖은 '곳' */
// weak: related(참고) 결과는 '일치'가 아니라 '비슷한' 조문 (총괄 11/20: '주택청약 해지' → 펀드 철회가 '일치한 조문'으로 보임)
function SearchMatches({ item, limit = 2, weak = false }: { item: SearchItem; limit?: number; weak?: boolean }) {
  const all = item.matches?.length ? item.matches : [{ basis: item.basis, snippet: item.snippet }];
  const isFig = (m: Match) => m.quotable === false || m.evidence_kind === 'FIGURE' || /^\[그림/.test(m.snippet);
  const matches = [...all.filter((m) => !isFig(m)), ...all.filter(isFig)];
  const reg = item.document_type === 'REGULATION';
  const rest = matches.slice(limit);
  return <div className="search-matches">
    {weak ? <p className="note">{reg ? `비슷한 조문(참고) ${matches.length}건` : `비슷한 곳(참고) ${matches.length}곳`}</p>
      : matches.length > 1 && <p className="note">{reg ? `이 문서에서 일치한 조문 ${matches.length}건` : `이 문서에서 일치한 곳 ${matches.length}곳`}</p>}
    <ul>{matches.slice(0, limit).map((m, n) => <MatchItem key={n} m={m} docId={item.doc_id} />)}</ul>
    {rest.length > 0 && <details className="more-matches"><summary>나머지 {rest.length}{reg ? '건' : '곳'} 더 보기</summary>
      <ul>{rest.map((m, n) => <MatchItem key={n} m={m} docId={item.doc_id} />)}</ul></details>}
  </div>;
}

function Results() {
  const router = useRouter();
  const sp = useSearchParams();
  const q = sp.get('q') ?? '';
  const type = sp.get('type') ?? '';
  const detail: Detail = Object.fromEntries(DETAIL.map((k) => [k, sp.get(k) ?? undefined]).filter(([, v]) => v));
  const dq = DETAIL.filter((k) => detail[k]).map((k) => `&${k}=${encodeURIComponent(detail[k]!)}`).join('');
  const [options, setOptions] = useState<{ business: string[]; dept: string[] }>({ business: [], dept: [] });
  useEffect(() => {
    // 필터 선택지: 볼 수 있는 게시 문서의 업무(1단계)·부서
    api<{ items: (LibraryCard & { dept?: string })[] }>('GET', '/v1/library').then((r) => setOptions({
      business: [...new Set(r.items.map((i) => i.business_path[0]).filter((x): x is string => !!x))].sort(),
      dept: [...new Set(r.items.map((i) => i.dept).filter((x): x is string => !!x && x !== 'all'))].sort(),
    })).catch(() => {});
  }, []);
  const [input, setInput] = useState(q);
  const [items, setItems] = useState<SearchItem[] | null>(null);
  const [related, setRelated] = useState<SearchItem[]>([]);
  const [rewritten, setRewritten] = useState<{ core: string; alternates: string[] } | null>(null);
  const raw = sp.get('raw') === '1'; // '원래 질의로 찾기'
  const [recent, setRecent] = useState<LibraryCard[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setInput(q); }, [q]);
  useEffect(() => {
    setErr('');
    // 검색어가 없으면 최근 게시된 문서를 보여 준다 (빈 화면 대신)
    if (!q) {
      setItems([]); setRecent(null);
      api<{ items: LibraryCard[] }>('GET', `/v1/library?${type ? `type=${type}` : ''}${dq}`)
        .then((r) => setRecent(r.items.filter((i) => i.lifecycle === 'PUBLISHED')))
        .catch((e: ApiError) => { setErr(e.message); setRecent([]); });
      return;
    }
    setItems(null);
    setRelated([]);
    setRewritten(null);
    let live = true; // 검색어가 바뀐 뒤 늦게 온 이전 응답은 버린다
    api<{ items: SearchItem[]; related?: SearchItem[]; rewritten?: { core: string; alternates: string[] } }>('GET', `/v1/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}${dq}${raw ? '&raw=1' : ''}`)
      .then((r) => { if (!live) return; setItems(r.items); setRelated(r.related ?? []); setRewritten(r.rewritten ?? null); })
      .catch((e: ApiError) => { if (!live) return; setErr(e.status === 401 ? '로그인한 뒤 다시 검색하세요.' : e.message); setItems([]); });
    return () => { live = false; };
  }, [q, type, dq, raw]);
  const nav = (nq: string, nt: string, nd: Detail = detail) =>
    router.push(`/search?q=${encodeURIComponent(nq)}${nt ? `&type=${nt}` : ''}${DETAIL.filter((k) => nd[k]).map((k) => `&${k}=${encodeURIComponent(nd[k]!)}`).join('')}`);
  return (
    <>
      <ModeTabs now="search" q={q} />
      <form className="search-row" role="search" onSubmit={(e) => { e.preventDefault(); nav(input.trim(), type); }}>
        <input className="field lg" type="search" aria-label="검색어" placeholder="찾을 기준이나 업무 (비우면 전체 문서)" value={input}
          onChange={(e) => { setInput(e.target.value); if (!e.target.value.trim() && q) router.replace(`/search?${type ? `type=${type}` : ''}${dq}`); }} />
        <div className="actions"><button className="btn solid" type="submit">검색</button></div>
      </form>
      {!q && <div className="examples"><p className="note">이렇게 물어보세요</p><div className="chips">{EXAMPLES.map((x) => <button key={x} type="button" className="chip ex" onClick={() => { setInput(x); nav(x, type); }}>{x}</button>)}</div></div>}
      <div className="filter-row"><div className="filter" role="group" aria-label="문서 종류">
        {FILTERS.map(([v, l]) => <button key={l} aria-pressed={type === v} onClick={() => nav(q, v)}>{l}</button>)}
      </div>
      <DetailFilters value={detail} options={options} onApply={(d) => nav(q, type, d)} /></div>
      {DETAIL.some((k) => detail[k]) && <div className="chips on-filters" aria-label="켜진 필터">{DETAIL.filter((k) => detail[k]).map((k) => <button key={k} type="button" className="chip" aria-label={`${DETAIL_LABEL[k]} 필터 해제`} onClick={() => nav(q, type, { ...detail, [k]: undefined })}>{DETAIL_LABEL[k]}: {VALUE_LABEL[detail[k]!] ?? detail[k]} ×</button>)}</div>}
      {err && <p className="error" role="alert">{err}</p>}
      {!q ? (
        recent === null ? <p className="note">불러오는 중입니다.</p> : recent.length === 0 ? <p className="note">볼 수 있는 게시 문서가 아직 없습니다.</p> : (
          <>
            {([['최근 게시', recent.slice(0, 6)], ['자주 찾는 규정', recent.filter((i) => i.document_type === 'REGULATION').sort((a, b) => (b.rating?.count ?? 0) - (a.rating?.count ?? 0)).slice(0, 4)]] as const).filter(([, l]) => l.length).map(([h, l]) => <section key={h} aria-label={h}>
            <h2 className="section">{h}</h2>
            <ul className="ledger card-grid result-list">
              {l.map((i) => (
                <li className="entry" key={i.doc_id}>
                  <Seal i={{ authority_status: i.authority_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', document_type: i.document_type ?? 'KNOWHOW', lifecycle: i.lifecycle, freshness: i.freshness, mark_count: i.mark_count }} />
                  <h3 className="doc-title"><a className="card-link" href={`/library?id=${encodeURIComponent(i.doc_id)}`}>{i.title}</a><Scheduled date={i.effective_from} /></h3>
                  <FreshnessFlag freshness={i.freshness} />
                  {(i.version_count ?? 1) > 1 && <p className="note">전체 {i.version_count}개 판 · 오늘 시행 중인 판</p>}
                  {i.summary && <p className="card-summary">{i.summary}</p>}
                </li>
              ))}
            </ul></section>)}
            <p className="note"><a href="/library">전체 게시 문서 {recent.length}건 보기 →</a></p>
          </>
        )
      ) : items === null ? <p className="note">찾는 중입니다.</p> : <>{rewritten && (
        <div className="rewritten" aria-live="polite">
          {rewritten.core.trim() !== q.trim() && <p>이 검색어로 찾았습니다: <strong>{rewritten.core}</strong></p>}
          {rewritten.core.trim() === q.trim() && rewritten.alternates.length > 0 && <p>이렇게도 찾아보세요</p>}
          <div className="chips">
            {rewritten.alternates.map((a) => <button key={a} type="button" className="chip" onClick={() => { setInput(a); nav(a, type); }}>{a}</button>)}
            {rewritten.core.trim() !== q.trim() && <button type="button" className="btn" onClick={() => router.push(`/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}${dq}&raw=1`)}>원래 질의로 찾기</button>}
          </div>
        </div>
      )}{ items.length === 0 && related.length === 0 && !err ? (
        <div className="notice" role="status" style={{ display: 'block' }}><p style={{ margin: 0 }}><strong>맞는 승인 문서가 없습니다.</strong> 이렇게 바꿔 보세요.</p>
          <ul><li>짧은 낱말로: '해외송금 한도'</li><li>조문 번호로: '제12조제2항'</li>{type && <li><button type="button" className="linklike" onClick={() => nav(q, '')}>문서 종류를 '전체'로</button></li>}<li><a href={`/guide?q=${encodeURIComponent(q)}`}>업무 가이드에 물어보기</a></li></ul></div>
      ) : (
        <>
          {items.length ? <p className="note">열람 권한이 있는 승인 문서 {items.length}건, 관련도 높은 순</p> : (() => {
            // 직접 정한 조문이 없음을 먼저 밝힌다 (let522mj 제안 11/18: related 만 있으면 '대상이 다르다'를 알 수 있게)
            const r0 = related[0]; const b = r0?.matches?.find((m) => m.basis)?.basis ?? r0?.basis;
            return <p className="notice" role="status"><strong>'{q}'을(를) 직접 정한 조문·문서는 없습니다.</strong>{r0 ? <> 비슷한 내용으로 {b ? <>「{b}」</> : <>「{r0.title}」</>}이(가) 있지만 대상이 다를 수 있으니 아래에서 확인하세요.</> : ''}</p>;
          })()}
          <PaginatedList label="검색 결과" pageKey="page" className="ledger result-list">
            {items.map((i, n) => (
              <li className="entry" key={`${i.doc_id}-${n}`}>
                <Seal i={{ ...i, freshness: i.freshness }} />
                <span className="kind-tag">{TYPE_LABEL[i.document_type] ?? '문서'}</span>
                <h3 className="doc-title"><a className="card-link" href={`/library?id=${encodeURIComponent(i.doc_id)}`}>{i.title}</a><Scheduled date={i.effective_from} /></h3>
                <FreshnessFlag freshness={i.freshness} />
                <dl>
                  {i.effective_from && <><dt>시행일</dt><dd><span className="num">{i.effective_from}</span></dd></>}
                  {i.business_path && i.business_path.length > 0 && <><dt>업무</dt><dd>{i.business_path.join(' › ')}</dd></>}
                  {i.team && <><dt>작성</dt><dd>{i.team}</dd></>}
                  {i.rating && <><dt>평점</dt><dd><Popularity r={i.rating} /></dd></>}
                  <dt>찾은 이유</dt><dd>{i.reason}</dd>
                </dl>
                <SearchMatches item={i} />
                <a href={`/library?id=${encodeURIComponent(i.doc_id)}`}>문서 보기 →</a>
              </li>
            ))}
          </PaginatedList>
          {items.length > 0 && <div className="actions"><button className="btn solid" onClick={() => router.push(`/guide?q=${encodeURIComponent(q)}`)}>이 내용으로 업무 가이드 만들기</button></div>}
          {related.length > 0 && (
            <section aria-labelledby="rel-h" className="weak-results">
              <h2 className="section" id="rel-h">관련 있을 수 있는 문서 <span className="note">정확한 근거로 확인되지는 않음</span></h2>
              <PaginatedList label="관련 있을 수 있는 문서" pageKey="related_page" className="ledger result-list">
                {related.map((i, n) => (
                  <li className="entry" key={`w-${i.doc_id}-${n}`}>
                    <Seal i={{ ...i, freshness: i.freshness }} />
                    <h3 className="doc-title"><a className="card-link" href={`/library?id=${encodeURIComponent(i.doc_id)}`}>{i.title}</a><Scheduled date={i.effective_from} /></h3>
                                        <dl><dt>찾은 이유</dt><dd>{i.reason}</dd></dl>
                    <SearchMatches item={i} limit={1} weak />
                    <a href={`/library?id=${encodeURIComponent(i.doc_id)}`}>문서 보기 →</a>
                  </li>
                ))}
              </PaginatedList>
            </section>
          )}
        </>
      )}</>}
    </>
  );
}

export default function SearchPage() {
  return <><PageHeader title="검색" description="승인된 규정·노하우에서 기준을 찾고, 근거와 시행일을 함께 확인하세요." /><Suspense fallback={<p className="note">불러오는 중입니다.</p>}><Results /></Suspense></>;
}
