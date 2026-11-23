'use client';
// 항목별 확인 (사용자 요청·Fable 권고 11/18): 개인정보·비밀값 항목을 하나씩 '그대로 사용(사유)' 또는 수정.
// 처리한 항목은 초록, 모두 처리해야 게시 요청. 서버는 명시한 finding_ids 만 바꾼다(문서 단위 '완료' 없음)
import { useState } from 'react';
import { api, ApiError } from './lib/api';
import { PageView } from './issues';

export interface ReviewItem { finding_id: string; code: string; page: number | null; message: string; fix_hint: string | null; acknowledged: boolean; reason: string | null }
const KIND: Record<string, string> = { PII_IMAGE_REVIEW: '그림 속 개인정보 가림 확인', PII_IN_FIGURE: '그림 속 개인정보', PII_GUARDRAIL: '본문 개인정보', SECRET_MASKED: '비밀값(비밀번호·키) 가림' };
// 종류별 사유 (QA nit 11/20: 비밀값 묶음에 '그림에 개인정보 없음'이 보임)
const CHIPS = (code: string) => code === 'SECRET_MASKED' ? ['가림 확인함', '예시용 가짜 값'] : TEXT_CODES.has(code) ? ['가림 확인함', '공용 대표 정보'] : ['그림에 개인정보 없음', '가림 확인함', '공용 대표 정보'];
const TEXT_CODES = new Set(['PII_GUARDRAIL', 'SECRET_MASKED']); // 글자 항목은 위키에서 고칠 수 있음

export function ReviewItems({ docId, items, canFix, onAcked, onEdit }: { docId: string; items: ReviewItem[]; canFix: boolean; onAcked: (ids: string[], reason: string) => void; onEdit: () => void }) {
  const [reason, setReason] = useState<Record<string, string>>({});
  const [view, setView] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  if (!items.length) return null;
  const done = items.filter((i) => i.acknowledged).length;
  // 같은 종류는 한 묶음으로 (사용자 피드백 11/20: 쪽마다 반복돼 33건, 아래 확인 창이 안 보임). 하나씩은 '항목별로 보기'에서
  const kinds = [...new Set(items.map((i) => i.code))];
  async function ack(ids: string[], key: string) {
    const r = (reason[key] ?? '').trim();
    if (!r) { setMsg('그대로 사용하는 사유를 적거나 고르세요.'); return; }
    setBusy(true); setMsg('');
    try { const x = await api<{ acked: string[] }>('POST', `/v1/documents/${encodeURIComponent(docId)}/findings/ack`, { finding_ids: ids, reason: r }); onAcked(x.acked, r); }
    catch (e) { setMsg((e as ApiError).message); }
    setBusy(false);
  }
  const reasonUi = (k: string, code: string) => (
    <div className="actions" style={{ marginTop: 6 }}>
      {CHIPS(code).map((c) => <button key={c} type="button" className={`btn chip-btn${reason[k] === c ? ' solid' : ''}`} onClick={() => setReason((x) => ({ ...x, [k]: c }))}>{c}</button>)}
      <input className="field" aria-label="그대로 사용 사유" placeholder="또는 사유 직접 입력" maxLength={200} value={reason[k] ?? ''} onChange={(e) => setReason((x) => ({ ...x, [k]: e.target.value }))} />
    </div>
  );
  return (
    <section aria-labelledby="rv-items-h" className="fix-list review-items" id="review-items">
      <h2 className="section" id="rv-items-h">개인정보 확인 <b className="num">{done}/{items.length}</b></h2>
      <p className="note">AI가 가린 개인정보·비밀값을 항목마다 확인하세요. 문제가 없으면 '그대로 사용'(사유), 고쳐야 하면 '수정하기'. 모두 확인해야 게시를 요청할 수 있습니다.</p>
      {kinds.map((code) => {
        const its = items.filter((i) => i.code === code);
        const open = its.filter((i) => !i.acknowledged);
        const pgs = [...new Set(its.map((i) => i.page).filter((x): x is number => !!x))].sort((x, y) => x - y);
        const key = `kind:${code}`;
        return (
          <div key={code} className="rv-page">
            <h3 className="lbl">{KIND[code] ?? code} {its.length}건{pgs.length > 0 && <span className="note"> · {pgs.length > 8 ? `${pgs.slice(0, 8).join('·')}… 쪽` : `${pgs.join('·')}쪽`}</span>} <span className="note">{its.length - open.length}/{its.length} 확인</span></h3>
            {open.length > 0 && canFix && <div className="bulk-ack">{open.length > 1 && <p className="note" style={{ margin: 0 }}>남은 {open.length}건을 같은 사유로 한 번에 확인할 수 있습니다.</p>}{reasonUi(key, code)}
              <div className="actions"><button type="button" className="btn solid" disabled={busy} onClick={() => ack(open.map((i) => i.finding_id), key)}>{open.length}건 그대로 사용</button>{TEXT_CODES.has(code) && <button type="button" className="btn" onClick={onEdit}>수정하기(위키)</button>}</div></div>}
            <details><summary className="note">항목별로 보기 ({its.length}건)</summary>
            <ol className="fixes">{its.map((i) => (
              <li key={i.finding_id} className={`fix${i.acknowledged ? ' done' : ''}`}>
                <p className="fix-head">{i.page ? `${i.page}쪽` : '쪽 정보 없음'}{i.acknowledged ? ` · 확인함 (${i.reason ?? ''})` : ''}</p>
                <p>{i.message}</p>
                {!i.acknowledged && canFix && <>
                  {reasonUi(i.finding_id, i.code)}
                  <div className="actions">
                    <button type="button" className="btn" disabled={busy} onClick={() => ack([i.finding_id], i.finding_id)}>이 항목만 그대로 사용</button>
                    {!TEXT_CODES.has(i.code) && <span className="note">그림은 원본 파일을 고쳐 다시 올려야 합니다.</span>}
                    {i.page && <button type="button" className="btn" aria-expanded={view === i.finding_id} onClick={() => setView(view === i.finding_id ? null : i.finding_id)}>{i.page}쪽 위치 보기</button>}
                  </div>
                </>}
                {view === i.finding_id && i.page && <PageView docId={docId} page={i.page} items={[]} onClose={() => setView(null)} />}
              </li>
            ))}</ol></details>
          </div>
        );
      })}
      {msg && <p className="error" role="alert">{msg}</p>}
    </section>
  );
}
