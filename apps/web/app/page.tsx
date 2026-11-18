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
  type T = { doc_id: string; title?: string; own?: boolean };
  const [todo, setTodo] = useState<{ approvals: T[] | null; mismatch: T[] | null } | null>(null);
  const [panel, setPanel] = useState<'approvals' | 'mismatch' | 'mine' | null>(null); // 누른 칸의 내용만 (사용자 요청 11/18)
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
        api<{ items: T[] }>('GET', '/v1/approvals?status=PENDING').then((r) => r.items).catch(() => null),
        api<{ items: T[] }>('GET', '/v1/review-queue').then((r) => r.items).catch(() => null),
      ]).then(([approvals, mismatch]) => setTodo({ approvals, mismatch }));
    }
  }, []);
  const isAuthor = !!s; // 규칙 1: 로그인한 누구나 올리고 고친다
  const STATE: Record<string, string> = { QUARANTINED: '분석 중', IN_REVIEW: '게시 요청 전', PENDING_APPROVAL: '승인 대기·게시 중', BLOCKED: '차단·반려', DELETED: '폐기' };
  const go = (query: string) => router.push(`/search?q=${encodeURIComponent(query)}`);
  return (
    <div className="home-layout">
      <section className="home-search" aria-labelledby="home-title">
        <span className="eyebrow">Hanaeum Wiki · 업무 지식</span>
        <h1 className="title" id="home-title">업무의 기준을 찾는 곳</h1>
        <p className="home-description">규정과 실무 노하우를, 확인된 근거와 함께.</p>
        {isAuthor && <div className="hero-actions"><Link className="btn" href="/upload" prefetch={false}><Icon name="upload" />새 문서 올리기</Link></div>}
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
        <div className="todo-tiles" role="tablist" aria-label="내 할 일">
          {todo && <button type="button" role="tab" aria-selected={panel === 'approvals'} className="todo-tile" onClick={() => setPanel(panel === 'approvals' ? null : 'approvals')}><b className="num">{todo.approvals?.length ?? '–'}</b><span>결재 대기</span></button>}
          {todo && <button type="button" role="tab" aria-selected={panel === 'mismatch'} className="todo-tile" onClick={() => setPanel(panel === 'mismatch' ? null : 'mismatch')}><b className="num">{todo.mismatch?.length ?? '–'}</b><span>출처 확인 필요</span></button>}
          {isAuthor && <button type="button" role="tab" aria-selected={panel === 'mine'} className="todo-tile" onClick={() => setPanel(panel === 'mine' ? null : 'mine')}><b className="num">{mine.length}</b><span>내 문서 진행 중</span></button>}
        </div>
        {panel && <div className="todo-panel" role="tabpanel">
          {panel === 'approvals' && (todo?.approvals?.length ? <ul className="todo-list">{todo.approvals.map((x) => <li key={x.doc_id}><Link href={`/library?id=${encodeURIComponent(x.doc_id)}&from=admin`} prefetch={false}>{x.title ?? '제목 없는 문서'}</Link>{x.own && <span className="kind-tag own">본인 문서</span>}</li>)}</ul> : <p className="note">결재할 문서가 없습니다. 게시 요청을 한 문서만 여기에 옵니다.</p>)}
          {panel === 'approvals' && <Link className="btn" href="/admin" prefetch={false}>결재함에서 결재하기</Link>}
          {panel === 'mismatch' && (todo?.mismatch?.length ? <ul className="todo-list">{todo.mismatch.map((x) => <li key={x.doc_id}><Link href={`/library?id=${encodeURIComponent(x.doc_id)}&from=admin`} prefetch={false}>{x.title ?? '제목 없는 문서'}</Link></li>)}</ul> : <p className="note">출처 확인이 필요한 문서가 없습니다.</p>)}
          {panel === 'mine' && (mine.length ? <ul className="todo-list">{mine.map((i) => <li key={i.doc_id}><Link href={i.lifecycle === 'IN_REVIEW' || i.lifecycle === 'QUARANTINED' ? `/review?id=${encodeURIComponent(i.doc_id)}` : `/library?id=${encodeURIComponent(i.doc_id)}`} prefetch={false}>{i.title}</Link><span className="note"> · {STATE[i.lifecycle] ?? i.lifecycle}{i.lifecycle === 'IN_REVIEW' ? ' — 검토 화면에서 게시 요청을 눌러야 결재함에 갑니다' : ''}</span></li>)}</ul> : <p className="note">진행 중인 내 문서가 없습니다.</p>)}
        </div>}
      </section>}
      {fail && <p className="error" role="alert">문서 목록을 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.</p>}
      {items.length > 0 && <section className="home-recent" aria-labelledby="recent-title">
        <div className="section-heading"><h2 className="section" id="recent-title">최근 게시된 문서</h2><Link href="/library">문서보관함 전체 보기 <Icon name="arrow" /></Link></div>
        <PaginatedList label="최근 게시된 문서" pageSize={3} className="ledger card-grid">
          {items.map((i) => <li className="entry" key={i.doc_id}>
            <Seal i={{ authority_status: i.authority_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', document_type: i.document_type ?? 'KNOWHOW', lifecycle: i.lifecycle, freshness: i.freshness, mark_count: i.mark_count }} />
            <h3 className="doc-title"><Link className="card-link" prefetch={false} href={`/library?id=${encodeURIComponent(i.doc_id)}`}>{i.title}</Link></h3>
            <div className="meta">{i.business_path.join(' › ') || '업무 미분류'} · 변경 <span className="num">{i.updated_at.slice(0, 10)}</span></div>
            <FreshnessFlag freshness={i.freshness} />
            {i.summary && <p className="note card-summary">{i.summary}</p>}
          </li>)}
        </PaginatedList>
      </section>}
    </div>
  );
}
