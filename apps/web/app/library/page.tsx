'use client';
// 문서보관함: 카드 목록(요약·연관·태그) → 상세(전체 내용을 한 장씩) → 페이지 하단에 요약과 고칠 곳.
// 밑줄은 서버(buildMarks)가 찾은 위치만 긋는다. 화면에서 새로 판단하지 않는다.
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError, type LibraryCard, type LibraryDoc, type Mark } from '../lib/api';
import { FreshnessFlag, Seal } from '../seal';

const TYPES = [['', '전체'], ['REGULATION', '규정'], ['KNOWHOW', '노하우'], ['MANUAL', '매뉴얼']] as const;
const REL: Record<LibraryCard['related'][number]['relation'], string> = { CITES: '근거 규정', CITED_BY: '이 규정을 근거로 쓴 문서', CONFLICTS: '충돌', SIMILAR: '비슷한 문서' };
const KIND: Record<Mark['kind'], string> = {
  CONFLICT: '규정과 충돌', OUTDATED: '개정 전 규정 인용', INSUFFICIENT: '근거 확인 안 됨',
  REGISTRY_MISMATCH: '공식 원본과 다름', PII_UNCERTAIN: '개인정보 확인 필요', INJECTION: '의심스러운 지시문',
};

function List() {
  const router = useRouter();
  const sp = useSearchParams();
  const type = sp.get('type') ?? '';
  const business = sp.get('business') ?? '';
  const [items, setItems] = useState<LibraryCard[] | null>(null);
  const [businesses, setBusinesses] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const qs = (t: string, b: string) => new URLSearchParams([...(t ? [['type', t]] : []), ...(b ? [['business', b]] : [])]).toString();
  useEffect(() => {
    setItems(null); setErr('');
    api<{ items: LibraryCard[] }>('GET', `/v1/library?${qs(type, business)}`)
      .then((r) => { setItems(r.items); if (!business) setBusinesses([...new Set(r.items.map((i) => i.business_path[0]).filter((x): x is string => !!x))].sort()); })
      .catch((e: ApiError) => { setErr(e.status === 401 ? '로그인한 뒤 다시 열어 주세요.' : e.message); setItems([]); });
  }, [type, business]);
  const go = (t: string, b: string) => router.push(`/library${qs(t, b) ? `?${qs(t, b)}` : ''}`);
  return (
    <>
      <div className="filter" role="group" aria-label="문서 종류">
        {TYPES.map(([v, l]) => <button key={l} aria-pressed={type === v} onClick={() => go(v, business)}>{l}</button>)}
      </div>
      {businesses.length > 1 && (
        <label className="lbl">업무
          <select className="field" value={business} onChange={(e) => go(type, e.target.value)}>
            <option value="">전체 업무</option>
            {businesses.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {items === null ? <p className="note">불러오는 중입니다.</p> : items.length === 0 && !err ? (
        <p className="note">볼 수 있는 문서가 없습니다. 문서를 등록하거나 다른 종류를 골라 보세요.</p>
      ) : (
        <ul className="ledger">
          {items.map((d) => (
            <li className="entry" key={d.doc_id}>
              <Seal i={{ authority_status: d.authority_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', document_type: d.document_type ?? 'KNOWHOW' }} />
              <h3 className="doc-title"><Link href={`/library?id=${encodeURIComponent(d.doc_id)}`} className="card-link">{d.title}</Link></h3>
              <p>{d.summary ?? <span className="note">요약이 아직 없습니다.</span>}</p>
              <FreshnessFlag freshness={d.freshness} />
              <dl>
                {d.business_path.length > 0 && <><dt>업무</dt><dd>{d.business_path.join(' › ')}</dd></>}
                {d.tags.length > 0 && <><dt>태그</dt><dd>{d.tags.join(', ')}</dd></>}
                {d.related.length > 0 && <><dt>연관</dt><dd>{d.related.map((r) => `${r.title} (${REL[r.relation]})`).join(', ')}</dd></>}
                {d.mark_count > 0 && <><dt>고칠 곳</dt><dd className="danger-text">{d.mark_count}곳</dd></>}
                {d.lifecycle !== 'PUBLISHED' && <><dt>상태</dt><dd>게시 전 (내 문서)</dd></>}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** 텍스트에 밑줄을 긋는다. 겹치는 구간은 앞 밑줄을 우선한다 */
function Marked({ text, marks, active, onPick }: { text: string; marks: { m: Mark; n: number }[]; active: number; onPick: (n: number) => void }) {
  const spans = marks.filter((x) => x.m.start !== null && x.m.end !== null).sort((a, b) => a.m.start! - b.m.start!);
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const { m, n } of spans) {
    const s = Math.max(m.start!, at);
    if (s >= m.end!) continue;
    out.push(text.slice(at, s));
    out.push(
      <mark key={n} className={`hl${active === n ? ' on' : ''}`} onClick={() => onPick(n)}>
        {text.slice(s, m.end!)}<sup>{n}</sup>
      </mark>,
    );
    at = m.end!;
  }
  out.push(text.slice(at));
  return <div className="page-text">{out}</div>;
}

function Fix({ m, n, on }: { m: Mark; n?: number; on?: boolean }) {
  return (
    <li className={`fix${on ? ' on' : ''}`} id={n ? `mark-${n}` : undefined}>
      <p className="fix-head">{n && <b className="fix-n">{n}</b>}{KIND[m.kind]}{m.severity === 'HIGH' && <span className="danger-text"> · 수정 필요</span>}</p>
      <p>{m.reason}</p>
      {m.basis && (
        <blockquote className="basis">
          <cite>{m.basis.label}{m.basis.effective_from && ` · ${m.basis.effective_from} 시행`}</cite>
          <p>{m.basis.text}</p>
        </blockquote>
      )}
      {m.fix && <p><strong>고칠 내용</strong> {m.fix}</p>}
    </li>
  );
}

function Detail({ id }: { id: string }) {
  const [d, setD] = useState<LibraryDoc | null>(null);
  const [err, setErr] = useState('');
  const [p, setP] = useState(0);
  const [active, setActive] = useState(0);
  useEffect(() => {
    api<LibraryDoc>('GET', `/v1/library/${encodeURIComponent(id)}`)
      .then(setD)
      .catch((e: ApiError) => setErr(e.status === 404 ? '문서를 찾을 수 없거나 볼 권한이 없습니다.' : e.message));
  }, [id]);
  if (err) return <><p className="error" role="alert">{err}</p><Link href="/library">보관함으로 돌아가기</Link></>;
  if (!d) return <p className="note">불러오는 중입니다.</p>;
  const page = d.pages[p];
  const numbered = (page?.marks ?? []).map((m, i) => ({ m, n: i + 1 }));
  const go = (i: number) => { setP(i); setActive(0); };
  return (
    <>
      <p><Link href="/library">보관함</Link></p>
      <h2 className="doc-title lg">{d.title}</h2>
      <Seal i={{ authority_status: d.authority_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', document_type: d.document_type ?? 'KNOWHOW' }} />
      <FreshnessFlag freshness={d.freshness} />
      {d.summary && <p className="lead">{d.summary}</p>}
      <dl className="meta-grid">
        {d.business_path.length > 0 && <><dt>업무</dt><dd>{d.business_path.join(' › ')}</dd></>}
        {d.effective_from && <><dt>시행일</dt><dd>{d.effective_from}</dd></>}
        {d.tags.length > 0 && <><dt>태그</dt><dd>{d.tags.join(', ')}</dd></>}
        {d.related.length > 0 && <><dt>연관</dt><dd>{d.related.map((r) => (
          <span key={r.doc_id} className="rel"><Link href={`/library?id=${encodeURIComponent(r.doc_id)}`}>{r.title}</Link> · {REL[r.relation]} ({r.reason})</span>
        ))}</dd></>}
      </dl>

      {d.doc_marks.length > 0 && (
        <section aria-labelledby="doc-marks">
          <h3 className="section" id="doc-marks">본문에서 위치를 찾지 못한 항목</h3>
          <ul className="fixes">{d.doc_marks.map((m, i) => <Fix key={i} m={m} />)}</ul>
        </section>
      )}

      {!page ? <p className="note">표시할 본문이 없습니다. 개인정보를 가린 본문이 아직 만들어지지 않았습니다.</p> : (
        <section aria-label={`${p + 1}쪽`}>
          <div className="pager">
            <button className="btn" disabled={p === 0} onClick={() => go(p - 1)}>이전 쪽</button>
            <span aria-live="polite">{p + 1} / {d.pages.length}쪽</span>
            <button className="btn" disabled={p === d.pages.length - 1} onClick={() => go(p + 1)}>다음 쪽</button>
          </div>
          <div className="sheet page">
            <Marked text={page.text} marks={numbered} active={active} onPick={(n) => { setActive(n); document.getElementById(`mark-${n}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }} />
          </div>
          <h3 className="section">이 쪽 요약</h3>
          <p>{page.summary ?? <span className="note">요약이 아직 없습니다.</span>}</p>
          <h3 className="section">고칠 곳 {numbered.length > 0 && <span className="danger-text">{numbered.length}곳</span>}</h3>
          {numbered.length === 0 ? <p className="note">이 쪽에서 찾은 문제가 없습니다.</p> : (
            <ul className="fixes">{numbered.map(({ m, n }) => <Fix key={n} m={m} n={n} on={active === n} />)}</ul>
          )}
        </section>
      )}
    </>
  );
}

function View() {
  const id = useSearchParams().get('id');
  return id ? <Detail key={id} id={id} /> : <List />;
}

export default function LibraryPage() {
  return <><h1 className="title">문서보관함</h1><Suspense fallback={<p className="note">불러오는 중입니다.</p>}><View /></Suspense></>;
}
