'use client';
// 01 사용자 홈: 검색이 주 동작. 아래는 최근 게시된 문서(실제 게시 기록). 조회수 집계가 없으므로 '많이 본' 표현은 쓰지 않는다
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, MOCK, type LibraryCard } from './lib/api';
import { FreshnessFlag, Seal } from './seal';

const TAGS = ['체크리스트', '실무사례', '공식규정', '여신'];

export default function Home() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<LibraryCard[]>([]);
  useEffect(() => { api<{ items: LibraryCard[] }>('GET', '/v1/library').then((r) => setItems(r.items.filter((i) => i.lifecycle === 'PUBLISHED').slice(0, 5))).catch(() => setItems([])); }, []);
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

      <h2 className="section">최근 게시된 문서</h2>
      {items.length === 0 ? <p className="note">아직 볼 수 있는 게시 문서가 없습니다.</p> : (
        <ul className="ledger">
          {items.map((i) => (
            <li className="entry" key={i.doc_id}>
              <Seal i={{ authority_status: i.authority_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', document_type: i.document_type ?? 'KNOWHOW' }} />
              <h3 className="doc-title"><Link className="card-link" href={`/library?id=${encodeURIComponent(i.doc_id)}`}>{i.title}</Link></h3>
              <div className="meta">{i.business_path.join(' › ') || '업무 미분류'} · 변경 {i.updated_at.slice(0, 10)}</div>
              <FreshnessFlag freshness={i.freshness} />
              {i.summary && <p className="note" style={{ margin: '8px 0 0' }}>{i.summary}</p>}
            </li>
          ))}
        </ul>
      )}
      <div className="actions"><Link href="/library" className="btn">문서보관함 전체 보기</Link></div>
    </>
  );
}
