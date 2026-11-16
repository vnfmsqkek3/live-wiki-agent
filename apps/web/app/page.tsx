'use client';
// 01 사용자 홈: 검색창 + 자주 찾는 태그 + 추천 Wiki 카드
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, MOCK, type SearchItem } from './lib/api';
import { TrustBadges } from './badges';

const TAGS = ['체크리스트', '실무사례', '공식규정', '여신'];

export default function Home() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SearchItem[]>([]);
  useEffect(() => { api<{ items: SearchItem[] }>('GET', '/v1/search?q=' + encodeURIComponent('추천')).then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  const go = (query: string, tag?: string) => router.push(`/search?q=${encodeURIComponent(query)}${tag ? `&tags=${encodeURIComponent(tag)}` : ''}`);
  return (
    <>
      <h1>무엇을 찾으세요?</h1>
      {MOCK && <p className="banner b-warn">합성 mock 데이터 (API 미연결)</p>}
      <form role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) go(q.trim()); }} className="row">
        <input className="grow" type="search" aria-label="검색어" placeholder="예: 담보 승인 기준" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" type="submit">검색</button>
      </form>
      <h2>자주 찾는 태그</h2>
      <div className="row">{TAGS.map((t) => <button key={t} className="chip" onClick={() => go(t, t)}>#{t}</button>)}<Link href="/search" className="muted">전체 보기</Link></div>
      <h2>추천 Wiki</h2>
      {items.map((i) => (
        <article className="card" key={i.doc_id}>
          <TrustBadges i={i} />
          <h3 style={{ margin: '6px 0' }}>{i.title}</h3>
          <div className="muted">{i.team} · {i.date} · ★ {i.stars.toFixed(1)}</div>
          <p className="muted" style={{ margin: '6px 0 0' }}>추천 이유: {i.reason}</p>
        </article>
      ))}
      <Link href="/search" className="btn">검색 결과 보기</Link>
    </>
  );
}
