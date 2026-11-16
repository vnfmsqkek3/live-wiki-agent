'use client';
// 문서보관함: 카드 목록(요약·연관·태그) → 상세(전체 내용을 한 장씩) → 페이지 하단에 요약과 고칠 곳.
// 밑줄은 서버(buildMarks)가 찾은 위치만 긋는다. 화면에서 새로 판단하지 않는다.
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError, type ExternalLaw, type LibraryCard, type LibraryDoc, type Mark } from '../lib/api';
import { FreshnessFlag, Seal } from '../seal';

const TYPES = [['', '전체'], ['REGULATION', '규정'], ['KNOWHOW', '노하우'], ['MANUAL', '매뉴얼']] as const;
/** ISO 시각 → 'YYYY-MM-DD' (한국 시간) */
const day = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const REL: Record<LibraryCard['related'][number]['relation'], string> = { CITES: '근거로 인용한 규정', CITED_BY: '이 규정을 근거로 쓴 문서', CONFLICTS: '충돌', SIMILAR: '내용이 비슷함' };
const TYPE_NAME = { REGULATION: '규정', KNOWHOW: '실무 노하우', MANUAL: '매뉴얼' } as const;
const KIND: Record<Mark['kind'], string> = {
  CONFLICT: '규정과 충돌', OUTDATED: '개정 전 규정 인용', INSUFFICIENT: '근거 확인 안 됨',
  REGISTRY_MISMATCH: '공식 원본과 다름', PII_UNCERTAIN: '개인정보 확인 필요', INJECTION: '의심스러운 지시문',
  CONFIRMED: '근거 확인됨', SUPPLEMENT: '실무 보완(참고)',
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
                {d.effective_from && <><dt>시행일</dt><dd>{d.effective_from}</dd></>}
                <dt>등록일</dt><dd>{day(d.uploaded_at)}</dd>
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
      <p className="fix-head">{n && <b className="fix-n">{n}</b>}{m.label ?? KIND[m.kind]}{m.severity === 'HIGH' && <span className="danger-text"> · 수정 필요</span>}</p>
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

/** 본문이 인용한 외부 법령의 최신 공식본 (AgentCore Browser, 참고용·미검증). 첫 조회는 20초 남짓이라 따로 불러온다 */
function ExternalLaws({ id }: { id: string }) {
  const [items, setItems] = useState<ExternalLaw[] | null>(null);
  useEffect(() => { api<{ items: ExternalLaw[] }>('GET', `/v1/library/${encodeURIComponent(id)}/external-laws`).then((r) => setItems(r.items)).catch(() => setItems([])); }, [id]);
  if (items === null) return <p className="note" aria-live="polite">본문이 인용한 법령을 국가법령정보센터에서 확인하는 중입니다…</p>;
  if (!items.length) return null;
  return (
    <section aria-labelledby="ext-h">
      <h3 className="section" id="ext-h">외부 법령 최신본 참고 <span className="note">(미검증)</span></h3>
      <ul className="fixes">
        {items.map((x) => (
          <li key={x.law_name + (x.clause ?? '')} className="fix">
            <p className="fix-head">「{x.law_name}」{x.clause ? ` ${x.clause}` : ''}{x.result?.effective_from && ` · ${x.result.effective_from} 시행본`}</p>
            {x.error || !x.result ? <p className="note">공식 사이트에서 가져오지 못했습니다. 잠시 뒤 다시 열어 보세요.</p> : (
              <>
                {x.result.clause?.text ? <blockquote className="basis"><p>{x.result.clause.text}</p></blockquote> : <p className="note">요청한 조문을 찾지 못했습니다.</p>}
                <p className="meta">출처 {x.result.source} · 조회 {new Date(x.result.fetched_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}{x.result.from_cache ? ' (1일 보관본)' : ''} · <a href={x.result.url} target="_blank" rel="noopener noreferrer">원문 보기</a></p>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="meta">공식 사이트 원문을 참고로 보여 줍니다. 공식 규정 등록·승인 전에는 검증 근거로 쓰지 않습니다.</p>
    </section>
  );
}

function Detail({ id }: { id: string }) {
  const [d, setD] = useState<LibraryDoc | null>(null);
  const [err, setErr] = useState('');
  const [p, setP] = useState(0);
  const [active, setActive] = useState(0);
  useEffect(() => {
    api<LibraryDoc>('GET', `/v1/library/${encodeURIComponent(id)}`)
      .then((x) => {
        setD(x);
        // 다른 유형의 비슷한 문서는 검색이 필요해 따로 불러와 붙인다
        api<{ items: LibraryDoc['related'] }>('GET', `/v1/library/${encodeURIComponent(id)}/similar`)
          .then((r) => setD((cur) => (cur ? { ...cur, related: [...cur.related, ...r.items.filter((s) => !cur.related.some((c) => c.doc_id === s.doc_id))] } : cur)))
          .catch(() => {});
      })
      .catch((e: ApiError) => setErr(e.status === 404 ? '문서를 찾을 수 없거나 볼 권한이 없습니다.' : e.message));
  }, [id]);
  if (err) return <><p className="error" role="alert">{err}</p><Link href="/library">보관함으로 돌아가기</Link></>;
  if (!d) return <p className="note">불러오는 중입니다.</p>;
  const page = d.pages[p];
  // LOW(근거 확인됨·실무 보완)는 고칠 곳이 아니라 참고. 밑줄은 고칠 곳만 긋는다
  const numbered = (page?.marks ?? []).filter((m) => m.severity !== 'LOW').map((m, i) => ({ m, n: i + 1 }));
  const notes = (page?.marks ?? []).filter((m) => m.severity === 'LOW');
  const go = (i: number) => { setP(i); setActive(0); };
  return (
    <>
      <p><Link href="/library">보관함</Link></p>
      <h2 className="doc-title lg">{d.title}</h2>
      <Seal i={{ authority_status: d.authority_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', document_type: d.document_type ?? 'KNOWHOW' }} />
      <FreshnessFlag freshness={d.freshness} />
      {d.freshness_reason && (
        <p className="notice" role="status">
          근거 규정 「{d.freshness_reason.law_name}」이 {d.freshness_reason.effective_from} 시행 개정판으로 바뀌었습니다.
          이 문서는 {d.freshness_reason.cited_revision} 판을 근거로 승인되어, 현행 조문과 맞는지 다시 검토해야 합니다.
          게시는 유지되며 수정 승인 전까지 자동으로 바뀌지 않습니다.
        </p>
      )}
      {d.summary && <p className="lead">{d.summary}</p>}
      <dl className="meta-grid">
        {d.business_path.length > 0 && <><dt>업무</dt><dd>{d.business_path.join(' › ')}</dd></>}
        {d.effective_from && <><dt>시행일</dt><dd>{d.effective_from}</dd></>}
        {d.doc_date && <><dt>문서 {d.doc_date.label}</dt><dd>{d.doc_date.date} (본문 표기)</dd></>}
        <dt>등록일</dt><dd>{day(d.uploaded_at)}</dd>
        {d.updated_at.slice(0, 10) !== d.uploaded_at.slice(0, 10) && <><dt>최근 변경</dt><dd>{day(d.updated_at)}</dd></>}
        {d.tags.length > 0 && <><dt>태그</dt><dd>{d.tags.join(', ')}</dd></>}

      </dl>

      {d.verification && (
        <section aria-labelledby="verify-h">
          <h3 className="section" id="verify-h">검증 정보</h3>
          <dl className="meta-grid">
            <dt>검증한 사람</dt><dd>{d.verification.approved_by ?? '아직 승인 전'}</dd>
            <dt>검증 시각</dt><dd>{d.verification.approved_at ? new Date(d.verification.approved_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-'}</dd>
            {d.verification.approval_reason && <><dt>승인 의견</dt><dd>{d.verification.approval_reason}</dd></>}
            <dt>검증 방법</dt><dd>{d.verification.method}</dd>
          </dl>
          {d.verification.basis.length > 0 && (
            <>
              <p className="note" style={{ margin: '10px 0 4px' }}>비교한 대상</p>
              <ul className="fixes">
                {d.verification.basis.map((b, i) => (
                  <li key={i} className="fix">
                    <p className="fix-head">{b.what} · {b.label}{b.effective_from && ` · ${b.effective_from} 시행`}</p>
                    <p>{b.result}</p>
                    {b.quote && <blockquote className="basis"><p>{b.quote}</p></blockquote>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {d.related.length > 0 && (
        <section aria-labelledby="rel-h">
          <h3 className="section" id="rel-h">함께 보면 좋은 문서</h3>
          {(['REGULATION', 'KNOWHOW', 'MANUAL'] as const).map((t) => {
            const rs = d.related.filter((r) => (r.document_type ?? 'KNOWHOW') === t);
            if (!rs.length) return null;
            return (
              <div key={t} style={{ marginBottom: 10 }}>
                <p className="note" style={{ margin: '6px 0 2px' }}>{TYPE_NAME[t]}</p>
                <ul className="fixes">{rs.map((r) => (
                  <li key={r.doc_id} className={`fix${r.relation === 'CONFLICTS' ? ' sev-HIGH' : ''}`}>
                    <p style={{ margin: 0 }}><Link href={`/library?id=${encodeURIComponent(r.doc_id)}`}>{r.title}</Link></p>
                    <p className="meta" style={{ margin: 0 }}>{REL[r.relation]} · {r.reason}</p>
                  </li>
                ))}</ul>
              </div>
            );
          })}
        </section>
      )}
      <ExternalLaws id={d.doc_id} />

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
          {notes.length > 0 && (
            <>
              <h3 className="section">참고: 확인된 근거·실무 보완 <span className="note">{notes.length}건</span></h3>
              <ul className="fixes">{notes.map((m, i) => <Fix key={`n${i}`} m={m} />)}</ul>
            </>
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
