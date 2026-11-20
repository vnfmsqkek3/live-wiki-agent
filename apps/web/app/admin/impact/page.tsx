'use client';
// 관리 > 규정 변경 영향: 규정을 고르면 직전 개정본과 비교해 바뀐 조문과, 그 조문을 근거로 쓴 노하우·위험도를 보여 준다 (graph trace_impact)
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '../../lib/api';
import { PageHeader } from '../../page-header';

interface Change { path: string; kind: string; old_text: string; new_text: string; numbers_changed?: unknown[] }
interface Impacted { doc_id: string; title: string; relation: 'DIRECT' | 'INDIRECT'; risk: 'HIGH' | 'MEDIUM'; evidence: { cited_provision_id: string; evidence_span: string; change: { path: string; kind: string; old_text: string; new_text: string } }[] }
interface Draft { id: string; doc_id: string; before: string; after: string | null; verdict: string; ai_reason: string; path: string }
interface Report { old_revision: string; new_revision: string; changes: Change[]; impacted: Impacted[] }
const KIND: Record<string, string> = { ADDED: '신설', REMOVED: '삭제', DELETED: '삭제', MODIFIED: '변경' };
/** ARTICLE:12/PARAGRAPH:1 → 제12조제1항 */
const clause = (p: string) => p.split('/').map((x) => { const [k, n] = x.split(':'); return k === 'ARTICLE' ? `제${n}조` : k === 'PARAGRAPH' ? `제${n}항` : k === 'ITEM' ? `제${n}호` : n; }).join('');

/** 영향 노하우의 수정 초안: 결재함 '위키 수정 요청'으로 들어가고, 사람이 반영·승인해야 게시된다 (자동 게시 없음) */
function DraftButton({ law, docId }: { law: string; docId: string }) {
  const [items, setItems] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function make() {
    setBusy(true); setMsg('');
    try { setItems((await api<{ items: Draft[] }>('POST', '/v1/admin/impact/draft', { law, doc_id: docId })).items); }
    catch (e) { const x = e as ApiError; setMsg(x.status === 404 ? '이 문서는 이번 개정의 영향 대상이 아닙니다.' : x.status === 403 ? '규정 결재자 계정만 초안을 만들 수 있습니다.' : x.message); }
    setBusy(false);
  }
  if (!items) return <><button type="button" className="btn" disabled={busy} onClick={make}>{busy ? 'AI가 초안을 만드는 중' : '수정 초안 만들기'}</button>{msg && <p className="error" role="alert">{msg}</p>}</>;
  return (
    <div className="fix-list" role="region" aria-label="수정 초안">
      <p className="notice" role="status">초안 {items.length}건을 결재함 위키 수정 요청에 올렸습니다. 자동으로 게시되지 않으며, 결재자가 반영하고 승인해야 바뀝니다.</p>
      <ol className="fixes">{items.map((d) => (
        <li key={d.id} className="fix">
          <p className="fix-head">{clause(d.path)} 기준</p>
          <p><del>{d.before}</del></p>
          {d.after ? <p><ins>{d.after}</ins></p> : <p className="danger-text">초안 없음 (사람 작성 필요)</p>}
          <p className="note">AI 의견: {d.ai_reason}</p>
        </li>
      ))}</ol>
      <Link className="btn solid" href="/admin">결재함에서 반영하기</Link>
    </div>
  );
}

export default function Impact() {
  const [laws, setLaws] = useState<{ law_name: string; versions: number }[] | null>(null);
  const [law, setLaw] = useState('');
  const [r, setR] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<{ items: { law_name: string; versions: number }[] }>('GET', '/v1/admin/impact/laws').then((x) => setLaws(x.items))
      .catch((e: ApiError) => { setErr(e.status === 403 ? '규정 결재자 계정만 볼 수 있습니다.' : e.message); setLaws([]); });
  }, []);
  const run = (name: string) => {
    setLaw(name); setR(null); setErr(''); setBusy(true);
    api<Report>('GET', `/v1/admin/impact?law=${encodeURIComponent(name)}`).then(setR).catch((e: ApiError) => setErr(e.message)).finally(() => setBusy(false));
  };
  return (
    <>
      <PageHeader title="규정 변경 영향" description="규정을 고르면 직전 개정본과 비교해 바뀐 조문, 그 조문을 근거로 쓴 노하우와 위험도를 보여 줍니다." action={<Link className="btn" href="/admin">관리로 돌아가기</Link>} />
      {laws === null ? <p className="note">규정 목록을 불러오는 중입니다.</p> : laws.length === 0 && !err ? <p className="note">게시된 규정이 없습니다. 규정을 올리고 승인하면 여기에서 고를 수 있습니다.</p> : (
        <div className="chips impact-laws" role="group" aria-label="규정 고르기">
          {laws.map((l) => <button key={l.law_name} type="button" className="chip" aria-pressed={law === l.law_name} onClick={() => run(l.law_name)}>{l.law_name}{l.versions > 1 ? ` · 개정본 ${l.versions}` : ''}</button>)}
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {busy && <p className="note">바뀐 조문과 영향받는 노하우를 찾는 중입니다.</p>}
      {r && (
        <div className="impact">
          <section aria-labelledby="chg-h">
            <h2 className="section" id="chg-h">바뀐 조문 {r.changes.length}곳 <span className="note">{r.old_revision} → {r.new_revision}</span></h2>
            {r.changes.length === 0 ? <p className="note">두 개정본 사이에 바뀐 조문이 없습니다.</p> : (
              <ul className="ledger">{r.changes.map((c) => (
                <li className="entry" key={c.path}>
                  <h3 className="doc-title">{clause(c.path)} · {KIND[c.kind] ?? c.kind}</h3>
                  <dl className="meta-grid">{c.old_text && <><dt>개정 전</dt><dd>{c.old_text}</dd></>}{c.new_text && <><dt>개정 후</dt><dd>{c.new_text}</dd></>}</dl>
                </li>
              ))}</ul>
            )}
          </section>
          <section aria-labelledby="imp-h">
            <h2 className="section" id="imp-h">영향받는 노하우 {r.impacted.length}건</h2>
            {r.impacted.length === 0 ? <p className="note">바뀐 조문을 근거로 쓴 승인 노하우가 없습니다.</p> : (
              <ul className="ledger">{r.impacted.map((i) => (
                <li className="entry" key={i.doc_id}>
                  <span className={`run-status ${i.risk === 'HIGH' ? 'bad' : 'wait'}`}>위험도 {i.risk === 'HIGH' ? '높음' : '보통'}</span>
                  <h3 className="doc-title"><Link href={`/library?id=${encodeURIComponent(i.doc_id)}&from=admin`}>{i.title}</Link></h3>
                  <p className="meta">{i.relation === 'DIRECT' ? '바뀐 조문을 직접 인용' : '바뀐 조문을 참조하는 조문을 인용'} · 재검토 필요</p>
                  <ul>{i.evidence.map((e, n) => <li key={n}><strong>{clause(e.change.path)}</strong> 근거: “{e.evidence_span}”</li>)}</ul>
                  <DraftButton law={law} docId={i.doc_id} />
                </li>
              ))}</ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}
