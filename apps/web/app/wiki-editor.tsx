'use client';
// 위키 수정 (사용자 결정 11/17 규칙 1): 정리본 마크다운을 고쳐 저장하면 AI 가 다시 검사한다.
// 게시 문서 → 새 버전, 내 검토 중 문서 → 그 자리에서 다시 분석. 저장 뒤 '고칠 것' 화면으로 간다
import { useState } from 'react';
import { api, ApiError } from './lib/api';

export function WikiEditor({ docId, initial, onCancel, note }: { docId: string; initial: string; onCancel: () => void; note?: string }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setBusy(true); setErr('');
    try {
      const r = await api<{ doc_id: string }>('POST', `/v1/documents/${encodeURIComponent(docId)}/edit`, { markdown: text });
      location.href = `/review?id=${encodeURIComponent(r.doc_id)}`;
    } catch (e) { setErr((e as ApiError).message); setBusy(false); }
  }
  return (
    <section className="wiki-editor" aria-labelledby="wiki-edit-h">
      <h2 className="section" id="wiki-edit-h">위키에서 고치기</h2>
      <p className="note">{note ?? '저장하면 새 버전이 만들어지고 AI가 다시 검사합니다. 원래 문서는 승인될 때까지 그대로 보입니다.'} 제목은 ##, 목록은 1. 또는 - 로 씁니다.</p>
      <label className="lbl" htmlFor="wiki-md">본문 (마크다운)</label>
      <textarea id="wiki-md" className="field wiki-md" value={text} onChange={(e) => setText(e.target.value)} rows={18} spellCheck={false} />
      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="btn solid" onClick={save} disabled={busy || !text.trim() || text === initial}>{busy ? '저장하는 중' : '저장하고 검사 받기'}</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>취소</button>
      </div>
    </section>
  );
}
