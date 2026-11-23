'use client';
import { readable } from '../lib/readable';
import { PageThumb } from '../page-thumb';
import { PageHeader } from '../page-header';
// 03 AI 업무 가이드: 승인 문서만 근거로 단계별 가이드. 단계마다 근거 조문·시행일. 참고용 고지.
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError, streamGuide, type Evidence, type Guide } from '../lib/api';

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
      .then((x) => setG(fixSources(x)))
      .catch((e: ApiError) => setErr(e.status === 401 ? '로그인한 뒤 다시 시도하세요.' : '가이드를 만들지 못했습니다. 잠시 뒤 다시 시도하세요.'))
      .finally(() => setBusy(false));
  }, [q]);

  const docs = g ? [...new Map(g.steps.flatMap((s) => s.sources).map((e) => [e.doc_id || e.provision, e])).values()] : [];
  // 근거 0건이거나 게시·승인 요청 거절이면 '확인이 더 필요한 부분'을 맨 위에 (엔드유저 ⑧ 11/20: 근거 1건이어도 거절이 아래에 묻힘)
  const top = !!g?.uncertainty && (!docs.length || (/게시|승인/.test(g.uncertainty) && /할 수 없|불가/.test(g.uncertainty)));
  async function useful() {
    const top = docs.find((d) => d.doc_id);
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
          {/* 근거 0건 + 확인 필요 문구(게시·승인 요청 거절 등)면 그 문구를 맨 위에 (엔드유저 데모 06 ⑧ 11/20) */}
          {top ? <div className="notice" role="status" style={{ display: 'block' }}>
            <p style={{ margin: 0, whiteSpace: 'pre-line' }}><GText s={g.uncertainty} /></p>
            {/게시|승인/.test(g.uncertainty) && !g.uncertainty.includes('게시 요청') && <p className="note" style={{ marginBottom: 0 }}>가이드는 문서를 게시하거나 승인할 수 없습니다. 본인 문서는 등록 &gt; 검토 화면에서 [검토 마치고 게시 요청]을 누르면 승인자에게 갑니다.</p>}
          </div> : <p className="notice" style={{ color: 'var(--ink)' }}>
            {docs.length ? `검증된 문서 ${docs.length}건을 근거로 AI가 작성한 참고용 가이드입니다. 최종 판단은 근거 규정을 직접 확인한 뒤 하세요.` : '근거가 되는 승인 문서를 찾지 못해 가이드를 만들지 않았습니다. 질문을 바꾸거나 담당 부서에 문의하세요.'}
          </p>}
          {g.query_masked && <p className="mock">질문에 있던 개인정보를 가린 뒤 처리했습니다.</p>}
          {g.status === 'NO_EVIDENCE' || !docs.length ? !docs.length ? null : <p className="note">열람할 수 있는 승인 문서에서 근거를 찾지 못했습니다. 질문을 바꾸거나 담당 부서에 문의하세요.</p> : (
            <>{(g.sections?.length ? g.sections : [{ title: '', note: '', steps: g.steps, fallback: '', source_note: '' }]).map((sec, k) => { const list = sec.steps; const brief = !!g.sections?.length; return (
              <section key={k} className="guide-section" aria-label={sec.title || '가이드'}>
                {sec.title && <h2 className="section"><GText s={sec.title} /></h2>}
                {sec.note && <p className="note"><GText s={sec.note} /></p>}
                {list.length > 0 && <ol className="steps">
              {list.map((s, i) => (
                <li key={i}>
                  <p style={{ margin: 0 }}><GText s={s.text} /></p>
                  {!brief && s.sources.map((e) => (
                    <p key={e.doc_id || e.provision} className="meta" style={{ margin: '4px 0 0' }}>
                      <PageThumb docId={e.doc_id} page={e.page} />
                      근거{(e as { figure?: boolean }).figure ? '(그림 기준)' : ''}: {e.provision ?? e.title}{e.effective_from ? `, ${e.effective_from} 시행` : ''}{e.freshness === 'REVIEW_REQUIRED' ? ' (재검토 중)' : ''}
                    </p>
                  ))}
                </li>
              ))}
                </ol>}
                {sec.fallback && <p className="note"><GText s={sec.fallback} /></p>}
                {sec.source_note && <p className="meta guide-source"><GText s={sec.source_note} />{list[0]?.sources[0]?.doc_id && <> · <a href={`/library?id=${encodeURIComponent(list[0].sources[0].doc_id)}${list[0].sources[0].page ? `&page=${list[0].sources[0].page}` : ''}`}>원문 보기</a></>}</p>}
              </section>); })}</>
          )}
          {g.uncertainty && !top && <><h2 className="section">확인이 더 필요한 부분</h2><p className="flag" style={{ display: 'block', padding: '8px 12px', fontWeight: 400 }}><GText s={g.uncertainty} /></p></>}
          <div className="actions">
            <button className="btn" onClick={() => router.push(`/search?q=${encodeURIComponent(q)}`)}>근거 문서 보기</button>
            <button className="btn" onClick={useful} disabled={thanks || docs.length === 0}>{thanks ? '의견을 남겼습니다' : '도움이 됐어요'}</button>
          </div>
          <p className="meta" style={{ marginTop: 16 }}>AI 생성 안내입니다. 근거 문서를 확인해 주세요.</p>
        </>
      )}
      </div><aside className="support-panel"><h2 className="section">근거 출처</h2>{docs.length ? <ul className="source-list">{docs.map((d) => <li key={d.doc_id || d.provision}>{d.doc_id ? <a href={`/library?id=${encodeURIComponent(d.doc_id)}`}>{d.title}</a> : d.title}<p className="note">{d.provision}{d.effective_from && <> · <span className="num">{d.effective_from}</span> 시행</>}</p></li>)}</ul> : <p className="note">질문하면 승인된 문서의 근거가 여기에 표시됩니다.</p>}</aside></div>
    </>
  );
}

/** 조문 직접 인용 source는 doc_id·title이 법령 ID(SYN-LOAN-001@…)로 온다 (엔드유저 11/23, AI팀에 요청).
 *  같은 응답에 같은 법령 문서가 있으면 그 문서로, 없으면 링크 없는 '근거 규정 제n조'로 */
function fixSources(g: Guide): Guide {
  const all = [...(g.evidence ?? []), ...g.steps.flatMap((s) => s.sources), ...(g.sections ?? []).flatMap((s) => s.steps.flatMap((t) => t.sources))];
  const law = (id = '') => id.split('@')[0];
  const byLaw = new Map(all.filter((e) => e.doc_id.startsWith('doc_') && e.provision_id).map((e) => [law(e.provision_id), e]));
  const fix = (e: Evidence): Evidence => {
    if (e.doc_id.startsWith('doc_')) return e;
    const d = byLaw.get(law(e.doc_id));
    return { ...e, doc_id: d?.doc_id ?? '', title: d?.title ?? '근거 규정', provision: `${d?.provision?.replace(/\s*제\d.*$/, '') ?? '근거 규정'} ${e.provision ?? ''}`.trim(), page: undefined };
  };
  const steps = (l: Guide['steps']) => l.map((s) => ({ ...s, sources: s.sources.map(fix) }));
  return { ...g, steps: steps(g.steps), sections: g.sections?.map((s) => ({ ...s, steps: steps(s.steps) })) };
}

function GText({ s }: { s: string }) {
  return <>{readable(s).split(/\*\*(.+?)\*\*/g).map((t, i) => (i % 2 ? <strong key={i}>{t}</strong> : t))}</>;
}

export default function GuidePage() {
  return <Suspense fallback={<p className="note">불러오는 중입니다.</p>}><GuideView /></Suspense>;
}
