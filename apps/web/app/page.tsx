'use client';
// 01 사용자 홈: 검색이 주 동작. 추천은 신뢰 인장과 함께 장부 행으로.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, MOCK, type SearchItem } from './lib/api';
import { FreshnessFlag, Seal } from './seal';

const TAGS = ['체크리스트', '실무사례', '공식규정', '여신'];

export default function Home() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SearchItem[]>([]);
  useEffect(() => { api<{ items: SearchItem[] }>('GET', '/v1/search?q=' + encodeURIComponent('추천')).then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  const go = (query: string, tag?: string) => router.push(`/search?q=${encodeURIComponent(query)}${tag ? `&tags=${encodeURIComponent(tag)}` : ''}`);
  return (
    <>
      {MOCK && <p className="mock">서버에 연결되지 않아 하나은행(가상 데이터) 예시를 보여주고 있습니다.</p>}
      <h1 className="title">어떤 기준을 확인하시겠어요?</h1>
      <form role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) go(q.trim()); }}>
        <input className="field lg" type="search" aria-label="검색어" placeholder="예: 담보 3억원 이상 승인 절차" value={q} onChange={(e) => setQ(e.target.value)} />
        <p className="note" style={{ marginTop: 8 }}>승인된 문서만 검색되며, 결과마다 근거 조문과 시행일을 함께 보여줍니다.</p>
      </form>

      <h2 className="section">자주 찾는 주제</h2>
      <ul className="tags">{TAGS.map((t) => <li key={t}><button onClick={() => go(t, t)}>{t}</button></li>)}</ul>

      <h2 className="section">이번 주 많이 본 문서</h2>
      <ul className="ledger">
        {items.map((i) => (
          <li className="entry" key={i.doc_id}>
            <Seal i={i} />
            <h3 className="doc-title">{i.title}</h3>
            <div className="meta">{i.team}, {i.updated} 수정</div>
            <FreshnessFlag freshness={i.freshness} />
            <p className="note" style={{ margin: '8px 0 0' }}>{i.reason}</p>
          </li>
        ))}
      </ul>
      <div className="actions"><Link href="/search" className="btn">전체 문서 검색</Link></div>
    </>
  );
}
