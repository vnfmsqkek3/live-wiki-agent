'use client';
import { PaginatedList } from './paginated-list';
// 01 사용자 홈: 검색이 주 동작. 아래는 최근 게시된 문서(실제 게시 기록). 조회수 집계가 없으므로 '많이 본' 표현은 쓰지 않는다
import Link from 'next/link';
import { Icon } from './icons';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, getSession, MOCK, type LibraryCard, type Session } from './lib/api';
import { isAdmin } from './lib/roles';
import { FreshnessFlag, Seal } from './seal';

export default function Home() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<LibraryCard[]>([]);
  const [mine, setMine] = useState<LibraryCard[]>([]);
  const [todo, setTodo] = useState<{ approvals: number | null; mismatch: number | null } | null>(null);
  const [s, setS] = useState<Session | undefined>();
  const [fail, setFail] = useState(false);
  useEffect(() => {
    const cur = getSession();
    setS(cur);
    const g = cur?.groups ?? [];
    // 목록 API는 권한 내 게시 문서 + 본인 문서. 게시 전 문서는 본인 것만 온다
    api<{ items: LibraryCard[] }>('GET', '/v1/library').then((r) => {
      const pub = r.items.filter((i) => i.lifecycle === 'PUBLISHED');
      setItems(pub);
      setMine(r.items.filter((i) => i.lifecycle !== 'PUBLISHED'));
    }).catch(() => { setItems([]); setFail(true); });
    if (isAdmin(g)) {
      Promise.all([
        api<{ items: unknown[] }>('GET', '/v1/approvals?status=PENDING').then((r) => r.items.length).catch(() => null),
        api<{ items: unknown[] }>('GET', '/v1/review-queue').then((r) => r.items.length).catch(() => null),
      ]).then(([approvals, mismatch]) => setTodo({ approvals, mismatch }));
    }
  }, []);
  const isAuthor = !!s; // 규칙 1: 로그인한 누구나 올리고 고친다
  const STATE: Record<string, string> = { QUARANTINED: '분석 중', IN_REVIEW: '내 검토 대기', PENDING_APPROVAL: '승인 대기·게시 중', BLOCKED: '차단·반려', DELETED: '폐기' };
  const go = (query: string) => router.push(`/search?q=${encodeURIComponent(query)}`);
  return (
    <div className="home-layout">
      <section className="home-search" aria-labelledby="home-title">
        <span className="eyebrow">Hanaeum Wiki · 업무 지식</span>
        <h1 className="title" id="home-title">업무의 기준을 찾는 곳</h1>
        <p className="home-description">규정과 실무 노하우를, 확인된 근거와 함께.</p>
        <form className="hero-search" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) go(q.trim()); }}>
          <input className="field lg" type="search" aria-label="검색어" placeholder="예: 담보 3억원 이상 승인 절차" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn solid" type="submit"><Icon name="search" />검색</button>
        </form>
        <p className="note search-help">승인된 문서의 근거 조문과 시행일을 함께 확인하세요.</p>
        {MOCK && <p className="note demo-note">서버에 연결되지 않아 하나은행(가상 데이터) 예시를 보여주고 있습니다.</p>}
      </section>
      {(todo || (isAuthor && mine.length > 0)) && <section className="home-todo" aria-label="할 일 요약">
        <h2 className="section">내 할 일</h2>
        {/* 큰 숫자 칸 (Fable 재배치안 11/18): 누르면 그 화면으로. 실제 건수만 쓴다 */}
        <div className="todo-tiles">
          {todo && <Link className="todo-tile" href="/admin#pending-h"><b className="num">{todo.approvals ?? '–'}</b><span>결재 대기</span></Link>}
          {todo && <Link className="todo-tile" href="/admin#source-h"><b className="num">{todo.mismatch ?? '–'}</b><span>출처 확인 필요</span></Link>}
          {isAuthor && mine.length > 0 && <a className="todo-tile" href="#mine" onClick={() => { const el = document.getElementById('mine') as HTMLDetailsElement | null; if (el) el.open = true; }}><b className="num">{mine.length}</b><span>내 문서 진행 중</span></a>}
          {isAuthor && <Link className="todo-tile add" href="/upload"><Icon name="upload" /><span>새 문서 올리기</span></Link>}
        </div>
        {isAuthor && mine.length > 0 && <details className="mine-summary" id="mine"><summary>내가 올린 문서 <b className="num">{mine.length}</b>건 진행 중</summary><PaginatedList label="내가 올린 문서" pageKey="mine_page" className="mine-list">{mine.map((i) => <li key={i.doc_id}><Link href={['IN_REVIEW', 'PENDING_APPROVAL', 'QUARANTINED'].includes(i.lifecycle) ? `/review?id=${encodeURIComponent(i.doc_id)}` : `/library?id=${encodeURIComponent(i.doc_id)}`}>{i.title}</Link> · {STATE[i.lifecycle] ?? '상태 확인 필요'} · <span className="num">{i.uploaded_at.slice(0, 10)}</span></li>)}</PaginatedList></details>}
      </section>}
      {fail && <p className="error" role="alert">문서 목록을 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.</p>}
      {items.length > 0 && <section className="home-recent" aria-labelledby="recent-title">
        <div className="section-heading"><h2 className="section" id="recent-title">최근 게시된 문서</h2><Link href="/library">문서보관함 전체 보기 <Icon name="arrow" /></Link></div>
        <PaginatedList label="최근 게시된 문서" pageSize={3} className="ledger card-grid">
          {items.map((i) => <li className="entry" key={i.doc_id}>
            <Seal i={{ authority_status: i.authority_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', document_type: i.document_type ?? 'KNOWHOW', lifecycle: i.lifecycle, freshness: i.freshness, mark_count: i.mark_count }} />
            <h3 className="doc-title"><Link className="card-link" href={`/library?id=${encodeURIComponent(i.doc_id)}`}>{i.title}</Link></h3>
            <div className="meta">{i.business_path.join(' › ') || '업무 미분류'} · 변경 <span className="num">{i.updated_at.slice(0, 10)}</span></div>
            <FreshnessFlag freshness={i.freshness} />
            {i.summary && <p className="note card-summary">{i.summary}</p>}
          </li>)}
        </PaginatedList>
      </section>}
    </div>
  );
}
