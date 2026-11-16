'use client';
// 03 AI 업무 가이드: 승인 문서만 근거로 단계별 가이드. 단계마다 근거 조문·시행일. 참고용 고지.
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError, type Guide } from '../lib/api';

/** 화면 대화 ID: 탭 단위로 유지 → 후속 질문 맥락(AgentCore Memory). '새 대화'로 초기화 */
const CONV_KEY = 'hanaeum.guide.conversation';
function conversationId() {
  try { let v = sessionStorage.getItem(CONV_KEY); if (!v) { v = crypto.randomUUID(); sessionStorage.setItem(CONV_KEY, v); } return v; } catch { return undefined; }
}
function newConversation() { try { sessionStorage.removeItem(CONV_KEY); } catch { /* 저장소 차단 시 무시 */ } }

function GuideView() {
  const router = useRouter();
  const q = useSearchParams().get('q') ?? '';
  const [input, setInput] = useState(q);
  const [g, setG] = useState<Guide | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    if (!q) return;
    setBusy(true); setErr(''); setG(null); setThanks(false);
    api<Guide>('POST', '/v1/guides', { question: q, conversation_id: conversationId() })
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
      <h1 className="title">업무 가이드</h1>
      <form onSubmit={(e) => { e.preventDefault(); if (input.trim()) router.push(`/guide?q=${encodeURIComponent(input.trim())}`); }}>
        <input className="field lg" type="search" aria-label="질문" placeholder="예: 담보 4억원 기업여신은 누가 승인하나요?" value={input} onChange={(e) => setInput(e.target.value)} maxLength={1000} />
        <p className="note" style={{ marginTop: 8 }}>개인정보는 입력하지 마세요. 입력하더라도 AI에 전달하기 전에 가립니다.</p>
      </form>
      {busy && <p className="note" aria-live="polite">승인된 문서에서 근거를 찾고 가이드를 쓰는 중입니다.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {g && (
        <>
          <p className="notice" style={{ borderLeftColor: 'var(--ledger)', color: 'var(--ink)' }}>
            검증된 문서 {docs.length}건을 근거로 AI가 작성한 참고용 가이드입니다. 최종 판단은 근거 규정을 직접 확인한 뒤 하세요.
          </p>
          {g.query_masked && <p className="mock">질문에 있던 개인정보를 가린 뒤 처리했습니다.</p>}
          {g.status === 'NO_EVIDENCE' ? <p className="note">열람할 수 있는 승인 문서에서 근거를 찾지 못했습니다. 질문을 바꾸거나 담당 부서에 문의하세요.</p> : (
            <ol className="steps">
              {g.steps.map((s, i) => (
                <li key={i}>
                  <p style={{ margin: 0 }}>{s.text}</p>
                  {s.sources.map((e) => (
                    <p key={e.doc_id} className="meta" style={{ margin: '4px 0 0' }}>
                      근거: {e.provision ?? e.title}{e.effective_from ? `, ${e.effective_from} 시행` : ''}{e.freshness === 'REVIEW_REQUIRED' ? ' (재검토 중)' : ''}
                    </p>
                  ))}
                </li>
              ))}
            </ol>
          )}
          {g.uncertainty && <><h2 className="section">확인이 더 필요한 부분</h2><p className="flag" style={{ display: 'block', padding: '8px 12px', fontWeight: 400 }}>{g.uncertainty}</p></>}
          <div className="actions">
            <button className="btn" onClick={() => router.push(`/search?q=${encodeURIComponent(q)}`)}>근거 문서 보기</button>
            <button className="btn" onClick={useful} disabled={thanks || docs.length === 0}>{thanks ? '의견을 남겼습니다' : '도움이 됐어요'}</button>
            <button className="btn" onClick={() => { newConversation(); setInput(''); router.push('/guide'); }}>새 대화</button>
          </div>
          <p className="meta" style={{ marginTop: 16 }}>작성 모델: {g.model}</p>
        </>
      )}
    </>
  );
}

export default function GuidePage() {
  return <Suspense fallback={<p className="note">불러오는 중입니다.</p>}><GuideView /></Suspense>;
}
