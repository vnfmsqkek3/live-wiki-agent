'use client';
// 위키 수정 (사용자 결정 11/17 규칙 1): 정리본 마크다운을 고쳐 저장하면 AI 가 다시 검사한다.
// 게시 문서 → 새 버전, 내 검토 중 문서 → 그 자리에서 다시 분석. 저장 뒤 '고칠 것' 화면으로 간다.
// 11/18 사용자 요청: 넣은 줄로 바로 이동·강조(focus), 저장 전에 바뀐 줄을 보여 준다
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './lib/api';

/** 줄 단위 차이 (LCS). ponytail: O(n·m), 정리본은 수백~수천 줄이라 충분 — 더 커지면 Myers 로 */
export function lineDiff(a: string, b: string): { kind: 'add' | 'del'; text: string; line: number }[] | null {
  const x = a.split('\n'), y = b.split('\n');
  if (x.length * y.length > 4_000_000) return null; // 너무 큼: 생략
  const L = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: { kind: 'add' | 'del'; text: string; line: number }[] = [];
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { i++; j++; }
    else if (j < y.length && (i >= x.length || L[i]![j + 1]! >= L[i + 1]![j]!)) { out.push({ kind: 'add', text: y[j]!, line: j + 1 }); j++; }
    else { out.push({ kind: 'del', text: x[i]!, line: j + 1 }); i++; }
  }
  return out.filter((c) => c.text.trim());
}

export function WikiEditor({ docId, initial, base, focus, onCancel, note, onText }: { docId: string; initial: string; base?: string; focus?: string; onCancel: () => void; note?: string; onText?: (t: string) => void }) {
  const orig = base ?? initial;
  const [text, setText] = useState(initial);
  // 부모가 제안을 더 적용하면(initial 변경) 그 글로 바꾼다. 부모는 onText 로 지금 글을 받아 그 위에 적용한다 (11/18)
  useEffect(() => setText(initial), [initial]);
  useEffect(() => { onText?.(text); }, [text, onText]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const later = useDeferredValue(text); // 입력이 끊기지 않게 계산은 뒤로
  const diff = useMemo(() => lineDiff(orig, later), [orig, later]);
  // 넣은 줄로 이동: 그 줄을 선택하고 편집기 안·화면을 그 위치로 스크롤
  useEffect(() => {
    const el = ta.current; if (!el || !focus) return;
    const at = initial.lastIndexOf(focus); if (at < 0) return;
    el.focus({ preventScroll: true }); el.setSelectionRange(at, at + focus.length);
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.scrollTop = Math.max(0, initial.slice(0, at).split('\n').length * lh - el.clientHeight / 2);
    el.scrollIntoView({ block: 'center' });
  }, [focus, initial]);
  async function save() {
    setBusy(true); setErr('');
    try {
      const r = await api<{ doc_id: string }>('POST', `/v1/documents/${encodeURIComponent(docId)}/edit`, { markdown: text });
      location.href = `/review?id=${encodeURIComponent(r.doc_id)}`;
    } catch (e) { setErr((e as ApiError).message); setBusy(false); }
  }
  return (
    <section className="wiki-editor" id="wiki-editor" aria-labelledby="wiki-edit-h">
      <h2 className="section" id="wiki-edit-h">위키에서 고치기</h2>
      <p className="note">{note ?? '저장하면 새 버전이 만들어지고 AI가 다시 검사합니다. 원래 문서는 승인될 때까지 그대로 보입니다.'} 제목은 ##, 목록은 1. 또는 - 로 씁니다.</p>
      {focus && <p className="notice" role="status">넣은 줄을 선택해 두었습니다. 위치를 옮기거나 문장을 다듬은 뒤 저장하세요.</p>}
      <label className="lbl" htmlFor="wiki-md">본문</label>
      <textarea ref={ta} id="wiki-md" className="field wiki-md" value={text} onChange={(e) => setText(e.target.value)} rows={18} spellCheck={false} />
      <section className="edit-diff" aria-labelledby="edit-diff-h">
        <h3 className="lbl" id="edit-diff-h">바뀐 부분 {diff === null ? '(문서가 커서 표시 생략)' : diff.length ? <b className="num">{diff.length}줄</b> : '없음'}</h3>
        {diff && diff.length > 0 && <ol className="diff-lines">{diff.slice(0, 30).map((c, n) => (
          <li key={n} className={c.kind}><span className="num">{c.line}</span>{c.kind === 'add' ? <ins>{c.text}</ins> : <del>{c.text}</del>}</li>
        ))}{diff.length > 30 && <li className="note">외 {diff.length - 30}줄</li>}</ol>}
      </section>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="btn solid" onClick={save} disabled={busy || !text.trim() || text === orig}>{busy ? '저장하는 중' : '저장하고 검사 받기'}</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>취소</button>
      </div>
    </section>
  );
}
