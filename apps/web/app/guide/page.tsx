'use client';
import { PageThumb } from '../page-thumb';
import { PageHeader } from '../page-header';
// 03 AI 업무 가이드: 승인 문서만 근거로 단계별 가이드. 단계마다 근거 조문·시행일. 참고용 고지.
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError, streamGuide, type Guide } from '../lib/api';

function GuideView() {
  const router = useRouter();
  const q = useSearchParams().get('q') ?? '';
  const [input, setInput] = useState(q);
  const [g, setG] = useState<Guide | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [thanks, setThanks] = useState(false);
  const [said, setSaid] = useState<string[]>([]);

  useEffect(() => {
    if (!q) return;
    setBusy(true); setErr(''); setG(null); setThanks(false); setSaid([]);
    streamGuide(q, (t) => setSaid((x) => [...x, t]))
      .then(setG)
      .catch((e: ApiError) => setErr(e.status === 401 ? '로그인한 뒤 다시 시도하세요.' : '가이드를 만들지 못했습니다. 잠시 뒤 다시 시도하세요.'))
      .finally(() => setBusy(false));
  }, [q]);

  const docs = g ? [...new Map(g.steps.flatMap((s) => s.sources).map((e) => [e.doc_id, e])).values()] : [];
  async function useful() {
    const top = docs[0];
    if (!top) return;
    try { await api('POST', '/v1/feedback', { doc_id: top.doc_id, useful: true }); setThanks(true); } catch { setThanks(true); }
  }

  return (
    <>
      <PageHeader title="업무 가이드" description="업무 상황을 질문하시면 승인된 문서를 근거로 절차를 안내합니다." action={<button className="btn solid" type="submit" form="guide-form">가이드 만들기</button>} />
      <div className="layout-a guide-layout"><div className="primary"><form id="guide-form" onSubmit={(e) => { e.preventDefault(); if (input.trim()) router.push(`/guide?q=${encodeURIComponent(input.trim())}`); }}>
        <input className="field lg" type="search" aria-label="질문" placeholder="예: 담보 4억원 기업여신은 누가 승인하나요?" value={input} onChange={(e) => setInput(e.target.value)} maxLength={1000} />
        <p className="note" style={{ marginTop: 8 }}>개인정보는 입력하지 마세요. 입력하더라도 AI에 전달하기 전에 가립니다.</p>

      </form>
      {busy && (
        <ol className="live-steps" aria-live="polite">
          {(said.length ? said : ['요청을 보내는 중입니다']).map((t, i, a) => <li key={i} className={i === a.length - 1 ? 'now' : 'past'}>{t}{i === a.length - 1 ? '…' : ''}</li>)}
        </ol>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {g && (
        <>
          <p className="notice" style={{ color: 'var(--ink)' }}>
            검증된 문서 {docs.length}건을 근거로 AI가 작성한 참고용 가이드입니다. 최종 판단은 근거 규정을 직접 확인한 뒤 하세요.
          </p>
          {g.query_masked && <p className="mock">질문에 있던 개인정보를 가린 뒤 처리했습니다.</p>}
          {g.status === 'NO_EVIDENCE' ? <p className="note">열람할 수 있는 승인 문서에서 근거를 찾지 못했습니다. 질문을 바꾸거나 담당 부서에 문의하세요.</p> : (
            <>{(g.sections?.length ? g.sections : [{ title: '', note: '', steps: g.steps, fallback: '', source_note: '' }]).map((sec, k) => { const list = sec.steps; const brief = !!g.sections?.length; return (
              <section key={k} className="guide-section" aria-label={sec.title || '가이드'}>
                {sec.title && <h2 className="section"><GText s={sec.title} /></h2>}
                {sec.note && <p className="note"><GText s={sec.note} /></p>}
                {list.length > 0 && <ol className="steps">
              {list.map((s, i) => (
                <li key={i}>
                  <p style={{ margin: 0 }}><GText s={s.text} /></p>
                  {!brief && s.sources.map((e) => (
                    <p key={e.doc_id} className="meta" style={{ margin: '4px 0 0' }}>
                      <PageThumb docId={e.doc_id} page={e.page} />
                      근거{(e as { figure?: boolean }).figure ? '(그림 기준)' : ''}: {e.provision ?? e.title}{e.effective_from ? `, ${e.effective_from} 시행` : ''}{e.freshness === 'REVIEW_REQUIRED' ? ' (재검토 중)' : ''}
                    </p>
                  ))}
                </li>
              ))}
                </ol>}
                {sec.fallback && <p className="note"><GText s={sec.fallback} /></p>}
                {sec.source_note && <p className="meta guide-source"><GText s={sec.source_note} />{list[0]?.sources[0] && <> · <a href={`/library?id=${encodeURIComponent(list[0].sources[0].doc_id)}${list[0].sources[0].page ? `&page=${list[0].sources[0].page}` : ''}`}>원문 보기</a></>}</p>}
              </section>); })}</>
          )}
          {g.uncertainty && <><h2 className="section">확인이 더 필요한 부분</h2><p className="flag" style={{ display: 'block', padding: '8px 12px', fontWeight: 400 }}><GText s={g.uncertainty} /></p></>}
          <div className="actions">
            <button className="btn" onClick={() => router.push(`/search?q=${encodeURIComponent(q)}`)}>근거 문서 보기</button>
            <button className="btn" onClick={useful} disabled={thanks || docs.length === 0}>{thanks ? '의견을 남겼습니다' : '도움이 됐어요'}</button>
          </div>
          <p className="meta" style={{ marginTop: 16 }}>AI 생성 안내입니다. 근거 문서를 확인해 주세요.</p>
        </>
      )}
      </div><aside className="support-panel"><h2 className="section">근거 출처</h2>{docs.length ? <ul className="source-list">{docs.map((d) => <li key={d.doc_id}><a href={`/library?id=${encodeURIComponent(d.doc_id)}`}>{d.title}</a><p className="note">{d.provision}{d.effective_from && <> · <span className="num">{d.effective_from}</span> 시행</>}</p></li>)}</ul> : <p className="note">질문하면 승인된 문서의 근거가 여기에 표시됩니다.</p>}</aside></div>
    </>
  );
}

// 가이드 문장 표시용 (엔드유저 11/20): '**굵게**'는 굵게, 내부 코드·조문 경로는 읽는 말로. 원문 근거는 바꾸지 않는다
const CODE: Record<string, string> = { REVIEW_REQUIRED: '재검토 중', NOT_FOUND_VERIFIED: '검증된 문서에서 찾지 못함', SUPERSEDED: '개정 전 판', CURRENT: '현행', VERIFIED: '검증됨', UNVERIFIED: '미검증' };
const UNIT: Record<string, string> = { ARTICLE: '조', PARAGRAPH: '항', ITEM: '호', SUBITEM: '목' };
const readable = (s: string) => s
  .replace(/[\w-]+@[\d-]+\//g, '')
  .replace(/ARTICLE:[\w-]+(?:\/(?:PARAGRAPH|ITEM|SUBITEM):[\w-]+)*/g, (p) => p.split('/').map((x) => { const [k, v] = x.split(':'); return `제${v}${UNIT[k!]}`; }).join(''))
  .replace(/\b[A-Z][A-Z_]{5,}\b/g, (c) => CODE[c] ?? c);
function GText({ s }: { s: string }) {
  return <>{readable(s).split(/\*\*(.+?)\*\*/g).map((t, i) => (i % 2 ? <strong key={i}>{t}</strong> : t))}</>;
}

export default function GuidePage() {
  return <Suspense fallback={<p className="note">불러오는 중입니다.</p>}><GuideView /></Suspense>;
}
