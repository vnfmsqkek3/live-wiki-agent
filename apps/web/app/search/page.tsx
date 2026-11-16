'use client';
// 02 검색 결과: 권한이 적용된 적합도순. 행마다 인장, 근거 조문, 시행일, 평점(신뢰와 분리)
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError, type SearchItem } from '../lib/api';
import { FreshnessFlag, Seal } from '../seal';

const FILTERS = [['', '전체'], ['체크리스트', '체크리스트'], ['실무사례', '실무사례'], ['공식규정', '공식 규정']] as const;

function Results() {
  const router = useRouter();
  const sp = useSearchParams();
  const q = sp.get('q') ?? '';
  const tag = sp.get('tags') ?? '';
  const [input, setInput] = useState(q);
  const [items, setItems] = useState<SearchItem[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!q && !tag) { setItems([]); return; }
    setItems(null); setErr('');
    api<{ items: SearchItem[] }>('GET', `/v1/search?q=${encodeURIComponent(q || tag)}${tag ? `&tags=${encodeURIComponent(tag)}` : ''}`)
      .then((r) => setItems(r.items))
      .catch((e: ApiError) => { setErr(e.status === 401 ? '로그인한 뒤 다시 검색하세요.' : e.message); setItems([]); });
  }, [q, tag]);
  const nav = (nq: string, nt: string) => router.push(`/search?q=${encodeURIComponent(nq)}${nt ? `&tags=${encodeURIComponent(nt)}` : ''}`);
  return (
    <>
      <form role="search" onSubmit={(e) => { e.preventDefault(); nav(input.trim(), tag); }}>
        <input className="field lg" type="search" aria-label="검색어" placeholder="찾을 기준이나 업무" value={input} onChange={(e) => setInput(e.target.value)} />
      </form>
      <div className="filter" role="group" aria-label="문서 종류">
        {FILTERS.map(([v, l]) => <button key={l} aria-pressed={tag === v} onClick={() => nav(q, v)}>{l}</button>)}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {items === null ? <p className="note">찾는 중입니다.</p> : items.length === 0 && !err ? (
        <p className="note">{q || tag ? '열람 권한이 있는 승인 문서 중에 맞는 결과가 없습니다. 다른 표현으로 찾아보세요.' : '찾을 기준이나 업무를 입력하세요.'}</p>
      ) : (
        <>
          <p className="note">열람 권한이 있는 승인 문서 {items.length}건, 관련도 높은 순</p>
          <ul className="ledger">
            {items.map((i) => (
              <li className="entry" key={i.doc_id}>
                <Seal i={i} />
                <h3 className="doc-title"><a className="card-link" href={`/library?id=${encodeURIComponent(i.doc_id)}`}>{i.title}</a></h3>
                <p className="quote">{i.snippet}</p>
                <FreshnessFlag freshness={i.freshness} />
                <dl>
                  {i.basis && <><dt>근거</dt><dd>{i.basis}</dd></>}
                  {i.effective_from && <><dt>시행일</dt><dd>{i.effective_from}</dd></>}
                  {i.business_path && i.business_path.length > 0 && <><dt>업무</dt><dd>{i.business_path.join(' › ')}</dd></>}
                  {i.team && <><dt>작성</dt><dd>{i.team}</dd></>}
                  {i.stars !== undefined && <><dt>평점</dt><dd>{i.stars.toFixed(1)} / 5</dd></>}
                  <dt>찾은 이유</dt><dd>{i.reason}</dd>
                </dl>
              </li>
            ))}
          </ul>
          {items.length > 0 && <div className="actions"><button className="btn solid" onClick={() => router.push(`/guide?q=${encodeURIComponent(q || tag)}`)}>이 내용으로 업무 가이드 만들기</button></div>}
        </>
      )}
    </>
  );
}

export default function SearchPage() {
  return <><h1 className="title">검색</h1><Suspense fallback={<p className="note">불러오는 중입니다.</p>}><Results /></Suspense></>;
}
