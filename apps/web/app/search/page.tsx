'use client';
// 02 검색 결과: 태그 필터, 결과 건수, "적합도순 · 권한 적용", 신뢰 배지, 근거 링크
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError, type SearchItem } from '../lib/api';
import { TrustBadges } from '../badges';

const FILTERS = [['', '전체'], ['체크리스트', '체크리스트'], ['실무사례', '실무사례'], ['공식규정', '공식규정']] as const;

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
      .catch((e: ApiError) => { setErr(e.status === 401 ? '로그인이 필요합니다' : e.message); setItems([]); });
  }, [q, tag]);
  const nav = (nq: string, nt: string) => router.push(`/search?q=${encodeURIComponent(nq)}${nt ? `&tags=${encodeURIComponent(nt)}` : ''}`);
  return (
    <>
      <form role="search" className="row" onSubmit={(e) => { e.preventDefault(); nav(input.trim(), tag); }}>
        <input className="grow" type="search" aria-label="검색어" value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="primary">검색</button>
      </form>
      <div className="row" style={{ margin: '12px 0' }} role="group" aria-label="태그 필터">
        {FILTERS.map(([v, l]) => <button key={l} className="chip" aria-pressed={tag === v} onClick={() => nav(q, v)}>{l}</button>)}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {items === null ? <p className="muted">검색 중…</p> : (
        <>
          <p className="muted">{items.length}건 · 적합도순 · 권한 적용</p>
          {items.map((i) => (
            <article className="card" key={i.doc_id}>
              <TrustBadges i={i} />
              <h3 style={{ margin: '6px 0' }}>{i.title}</h3>
              <p style={{ margin: '0 0 6px' }}>{i.snippet}</p>
              {i.citation && <div className="muted">근거: {i.citation}</div>}
              <div className="muted">추천 근거: {i.reason} · ★ {i.stars.toFixed(1)}</div>
            </article>
          ))}
          {items.length > 0 && <button className="primary" disabled title="11/19 가이드 Agent 연동 예정">AI 업무 가이드 생성</button>}
        </>
      )}
    </>
  );
}

export default function SearchPage() {
  return <><h1>검색</h1><Suspense fallback={<p className="muted">불러오는 중…</p>}><Results /></Suspense></>;
}
