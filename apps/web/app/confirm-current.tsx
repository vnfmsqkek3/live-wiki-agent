'use client';
// 재검토 문서 '변경 없이 유효' (규정 결재자): 본문은 그대로 현행(CURRENT)으로 되돌리고, 열린 영향 초안은 서버가 닫는다. 문서 상세·변경 영향 화면 공용
import { useState } from 'react';
import { api, ApiError } from './lib/api';

export function ConfirmCurrent({ docId, onDone }: { docId: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(false);
  async function confirm() {
    setBusy(true); setMsg('');
    try {
      await api('POST', `/v1/documents/${encodeURIComponent(docId)}/freshness/confirm`, { reason });
      setDone(true); onDone?.();
    } catch (e) {
      const x = e as ApiError;
      setMsg(x.status === 403 ? '권한이 없습니다. 규정 결재자 계정이어야 하고, 본인이 올린 문서는 운영자 계정만 확인할 수 있습니다.' : x.status === 409 ? '이미 현행으로 바뀌었거나 재검토 대상이 아닙니다. 새로고침해 주세요.' : x.message);
    }
    setBusy(false);
  }
  if (done) return <p className="notice" role="status">변경 없이 유효로 확인했습니다. 문서는 현행으로 표시되고, 이 문서의 열린 수정 초안은 닫혔습니다.</p>;
  if (!open) return <button type="button" className="btn" onClick={() => setOpen(true)}>변경 없이 유효로 확인하기</button>;
  return (
    <div className="change-req" role="group" aria-label="변경 없이 유효 확인">
      <label className="lbl" htmlFor={`cc-${docId}`}>개정 후에도 그대로 맞는 이유 (필수)</label>
      <input id={`cc-${docId}`} className="field" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 개정은 보고서 작성 시점만 바뀌었고 이 문서는 그 부분을 다루지 않음" />
      <div className="actions"><button type="button" className="btn solid" disabled={busy || !reason.trim()} onClick={confirm}>확인</button><button type="button" className="btn" onClick={() => setOpen(false)}>닫기</button></div>
      {msg && <p className="error" role="alert">{msg}</p>}
    </div>
  );
}
