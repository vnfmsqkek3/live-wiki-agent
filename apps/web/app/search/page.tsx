'use client';
// 02 검색 결과: 권한이 적용된 적합도순. 행마다 인장, 근거 조문, 시행일, 평점(신뢰와 분리)
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError, type LibraryCard, type SearchItem } from '../lib/api';
import { FreshnessFlag, Seal } from '../seal';

// 문서 종류로 거른다 (태그는 AI가 붙인 자유 문구라 필터로 쓰면 0건이 되기 쉽다)
const FILTERS = [['', '전체'], ['REGULATION', '규정'], ['KNOWHOW', '노하우'], ['MANUAL', '매뉴얼']] as const;

function Results() {
  const router = useRouter();
  const sp = useSearchParams();
  const q = sp.get('q') ?? '';
  const type = sp.get('type') ?? '';
  const [input, setInput] = useState(q);
  const [items, setItems] = useState<SearchItem[] | null>(null);
  const [recent, setRecent] = useState<LibraryCard[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setInput(q); }, [q]);
  useEffect(() => {
    setErr('');
    // 검색어가 없으면 최근 게시된 문서를 보여 준다 (빈 화면 대신)
    if (!q) {
      setItems([]); setRecent(null);
      api<{ items: LibraryCard[] }>('GET', `/v1/library${type ? `?type=${type}` : ''}`)
        .then((r) => setRecent(r.items.filter((i) => i.lifecycle === 'PUBLISHED')))
        .catch((e: ApiError) => { setErr(e.message); setRecent([]); });
      return;
    }
    setItems(null);
    api<{ items: SearchItem[] }>('GET', `/v1/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}`)
      .then((r) => setItems(r.items))
      .catch((e: ApiError) => { setErr(e.status === 401 ? '로그인한 뒤 다시 검색하세요.' : e.message); setItems([]); });
  }, [q, type]);
  const nav = (nq: string, nt: string) => router.push(`/search?q=${encodeURIComponent(nq)}${nt ? `&type=${nt}` : ''}`);
  return (
    <>
      <form role="search" onSubmit={(e) => { e.preventDefault(); nav(input.trim(), type); }}>
        <input className="field lg" type="search" aria-label="검색어" placeholder="찾을 기준이나 업무 (비우면 전체 문서)" value={input}
          onChange={(e) => { setInput(e.target.value); if (!e.target.value.trim() && q) router.replace(`/search${type ? `?type=${type}` : ''}`); }} />
      </form>
      <div className="filter" role="group" aria-label="문서 종류">
        {FILTERS.map(([v, l]) => <button key={l} aria-pressed={type === v} onClick={() => nav(q, v)}>{l}</button>)}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {!q ? (
        recent === null ? <p className="note">불러오는 중입니다.</p> : recent.length === 0 ? <p className="note">볼 수 있는 게시 문서가 아직 없습니다.</p> : (
          <>
            <p className="note">전체 게시 문서 {recent.length}건 (최근 변경 순). 검색어를 넣으면 관련도 순으로 좁혀집니다.</p>
            <ul className="ledger">
              {recent.map((i) => (
                <li className="entry" key={i.doc_id}>
                  <Seal i={{ authority_status: i.authority_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', document_type: i.document_type ?? 'KNOWHOW' }} />
                  <h3 className="doc-title"><a className="card-link" href={`/library?id=${encodeURIComponent(i.doc_id)}`}>{i.title}</a></h3>
                  {i.summary && <p className="note" style={{ margin: 0 }}>{i.summary}</p>}
                </li>
              ))}
            </ul>
          </>
        )
      ) : items === null ? <p className="note">찾는 중입니다.</p> : items.length === 0 && !err ? (
        <p className="note">열람 권한이 있는 승인 문서 중에 맞는 결과가 없습니다. 다른 표현으로 찾거나 종류를 '전체'로 바꿔 보세요.</p>
      ) : (
        <>
          <p className="note">열람 권한이 있는 승인 문서 {items.length}건, 관련도 높은 순</p>
          <ul className="ledger">
            {items.map((i, n) => (
              <li className="entry" key={`${i.doc_id}-${n}`}>
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
          {items.length > 0 && <div className="actions"><button className="btn solid" onClick={() => router.push(`/guide?q=${encodeURIComponent(q)}`)}>이 내용으로 업무 가이드 만들기</button></div>}
        </>
      )}
    </>
  );
}

export default function SearchPage() {
  return <><h1 className="title">검색</h1><Suspense fallback={<p className="note">불러오는 중입니다.</p>}><Results /></Suspense></>;
}
