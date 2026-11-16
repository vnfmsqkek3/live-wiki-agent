'use client';
// 01 사용자 홈: 검색이 주 동작. 아래는 최근 게시된 문서(실제 게시 기록). 조회수 집계가 없으므로 '많이 본' 표현은 쓰지 않는다
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, getSession, MOCK, type LibraryCard, type Session } from './lib/api';
import { APPROVERS, ROLE_NAME } from './lib/roles';
import { FreshnessFlag, Seal } from './seal';

const TAGS = ['체크리스트', '실무사례', '공식규정', '여신'];

export default function Home() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<LibraryCard[]>([]);
  const [mine, setMine] = useState<LibraryCard[]>([]);
  const [todo, setTodo] = useState<{ approvals: number; mismatch: number } | null>(null);
  const [s, setS] = useState<Session | undefined>();
  useEffect(() => {
    const cur = getSession();
    setS(cur);
    const g = cur?.groups ?? [];
    // 목록 API는 권한 내 게시 문서 + 본인 문서. 게시 전 문서는 본인 것만 온다
    api<{ items: LibraryCard[] }>('GET', '/v1/library').then((r) => {
      setItems(r.items.filter((i) => i.lifecycle === 'PUBLISHED').slice(0, 5));
      setMine(r.items.filter((i) => i.lifecycle !== 'PUBLISHED'));
    }).catch(() => setItems([]));
    if (g.some((x) => APPROVERS.includes(x))) {
      Promise.all([
        api<{ items: unknown[] }>('GET', '/v1/approvals?status=PENDING').then((r) => r.items.length).catch(() => 0),
        api<{ items: unknown[] }>('GET', '/v1/review-queue').then((r) => r.items.length).catch(() => 0),
      ]).then(([approvals, mismatch]) => setTodo({ approvals, mismatch }));
    }
  }, []);
  const isAuthor = !!s?.groups.includes('AUTHOR');
  const STATE: Record<string, string> = { QUARANTINED: '분석 중', IN_REVIEW: '검토 대기', BLOCKED: '차단·반려', DELETED: '폐기' };
  const go = (query: string, tag?: string) => router.push(`/search?q=${encodeURIComponent(query)}${tag ? `&tags=${encodeURIComponent(tag)}` : ''}`);
  return (
    <>
      {MOCK && <p className="mock">서버에 연결되지 않아 하나은행(가상 데이터) 예시를 보여주고 있습니다.</p>}
      {s && <p className="note" style={{ margin: 0 }}>{s.groups.map((g) => ROLE_NAME[g] ?? g).join(', ')} 화면</p>}
      <h1 className="title">어떤 기준을 확인하시겠어요?</h1>
      <form role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) go(q.trim()); }}>
        <input className="field lg" type="search" aria-label="검색어" placeholder="예: 담보 3억원 이상 승인 절차" value={q} onChange={(e) => setQ(e.target.value)} />
        <p className="note" style={{ marginTop: 8 }}>승인된 문서만 검색되며, 결과마다 근거 조문과 시행일을 함께 보여줍니다.</p>
      </form>

      {todo && (
        <section aria-labelledby="todo">
          <h2 className="section" id="todo">처리할 일</h2>
          <ul className="counts" style={{ listStyle: 'none', padding: 0 }}>
            <li><strong>{todo.approvals}</strong>게시 승인 대기</li>
            <li><strong>{todo.mismatch}</strong>출처 확인 필요</li>
          </ul>
          <Link className="btn solid" href="/admin">승인 관리로 가기</Link>
        </section>
      )}

      {isAuthor && (
        <section aria-labelledby="mine">
          <h2 className="section" id="mine">내가 올린 문서</h2>
          {mine.length === 0 ? <p className="note">진행 중인 문서가 없습니다.</p> : (
            <ul className="ledger">
              {mine.map((i) => (
                <li className="entry" key={i.doc_id} style={{ paddingRight: 16 }}>
                  <h3 className="doc-title"><Link className="card-link" href={i.lifecycle === 'IN_REVIEW' ? `/review?id=${encodeURIComponent(i.doc_id)}` : `/library?id=${encodeURIComponent(i.doc_id)}`}>{i.title}</Link></h3>
                  <div className="meta">{STATE[i.lifecycle] ?? i.lifecycle} · 등록 {i.uploaded_at.slice(0, 10)}</div>
                </li>
              ))}
            </ul>
          )}
          <div className="actions"><Link className="btn solid" href="/upload">새 문서 등록</Link></div>
        </section>
      )}

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
