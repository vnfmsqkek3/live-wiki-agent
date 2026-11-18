'use client';
// 출처 링크는 같은 탭에서 연다: 로그인은 탭 단위(sessionStorage)라 새 탭은 다시 로그인을 요구한다 (사용자 지적 11/18)
// 확인 필요 (계약 interfaces 6.5, 사용자 요구 11/18): 질문 · 원문 강조 · AI 제안(출처) · [적용][직접 입력][해당 없음] → 카드 안 전/후 → "n건 반영하고 저장".
// 저장은 항목별 before→after 를 모아 /edit 한 번(새 버전 → 재검사 → 사람 승인). 담당자는 이름 대신 부서·직책.
import Link from 'next/link';
import { useState } from 'react';
import { api, ApiError } from './lib/api';
import { DocText } from './doc-text';

/** 표 행이면 머리행과 함께 마크다운 표로 (사용자 요청 11/18: 빈 칸이 어디인지 표로 보이게). 머리행이 없던 옛 항목은 '칸 1…n' */
export const isRowText = (s: string) => /^\s*\|.*\|\s*$/.test(s);
export function rowAsTable(row: string, header?: string) {
  const n = row.replace(/^\s*\||\|\s*$/g, '').split('|').length;
  const h = header && isRowText(header) ? header : `| ${Array.from({ length: n }, (_, i) => `칸 ${i + 1}`).join(' | ')} |`;
  const cells = row.replace(/^\s*\||\|\s*$/g, '').split('|').map((x) => x.trim() || '(빈 칸)');
  return `${h}\n| ${Array.from({ length: n }, () => '---').join(' | ')} |\n| ${cells.join(' | ')} |`;
}

export interface ClarifyItem {
  finding_id: string; kind: 'VAGUE_ACTOR' | 'MISSING_VALUE' | 'MISSING_LINK' | 'INCONSISTENT' | 'OUTDATED';
  item: string; page?: number; before: string; span?: string; table_header?: string; question: string; blocking?: boolean; severity?: string;
  suggestions: { value: string; after: string; source: { type: 'WIKI' | 'WEB' | 'USER'; doc_id?: string; page?: number; url?: string; title?: string } }[];
  status: 'OPEN' | 'APPLIED' | 'DISMISSED'; dismiss_reason?: string;
}
const KIND: Record<ClarifyItem['kind'], string> = { VAGUE_ACTOR: '누가 하는지', MISSING_VALUE: '빠진 값', MISSING_LINK: '빠진 주소', INCONSISTENT: '서로 맞지 않음', OUTDATED: '바뀌었을 수 있음' };
const SRC = { WIKI: '사내 위키', WEB: '공개 웹', USER: '직접 입력' } as const;


export function ClarifyList({ items, docId, text, canFix, onDismissed }: { items: ClarifyItem[]; docId: string; text?: string; canFix: boolean; onDismissed: (id: string, reason: string) => void }) {
  const [pick, setPick] = useState<Record<string, string>>({}); // finding_id → after
  const [typing, setTyping] = useState<Record<string, string>>({});
  const [dismissing, setDismissing] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const open = items.filter((c) => c.status === 'OPEN');
  const chosen = open.filter((c) => pick[c.finding_id]);
  async function save() {
    if (!text) return;
    let out = text; const miss: string[] = [];
    for (const c of chosen) { const i = out.indexOf(c.before); if (i < 0) { miss.push(c.item); continue; } out = out.slice(0, i) + pick[c.finding_id]! + out.slice(i + c.before.length); }
    if (miss.length) { setMsg(`본문에서 원래 문장을 찾지 못한 항목: ${miss.join(', ')}. 위키에서 직접 고쳐 주세요.`); return; }
    setBusy(true); setMsg('');
    try {
      const r = await api<{ doc_id: string }>('POST', `/v1/documents/${encodeURIComponent(docId)}/edit`, { markdown: out });
      location.href = `/review?id=${encodeURIComponent(r.doc_id)}`;
    } catch (e) { setMsg((e as ApiError).message); setBusy(false); }
  }
  // 입력값은 AI 가 그 문장에 자연스럽게 넣는다(조사 맞춤). 끝에 괄호로 붙이지 않는다 (사용자 지적 11/18, let522mj 전달)
  async function compose(c: ClarifyItem) {
    setBusy(true); setMsg('');
    try {
      const r = await api<{ edits: { after: string; ok: boolean; reason?: string }[] }>('POST', `/v1/documents/${encodeURIComponent(docId)}/clarify/compose`, { answers: [{ finding_id: c.finding_id, answer: typing[c.finding_id]!.trim() }] });
      const e = r.edits[0];
      if (e?.ok) setPick((p) => ({ ...p, [c.finding_id]: e.after })); else setMsg(e?.reason ?? '이 답은 넣을 수 없습니다.');
    } catch (e) { setMsg((e as ApiError).message); }
    setBusy(false);
  }
  async function dismiss(c: ClarifyItem) {
    const reason = (dismissing[c.finding_id] ?? '').trim();
    if (!reason) { setMsg('해당 없음 사유를 한 줄 적어 주세요.'); return; }
    try { await api('POST', `/v1/documents/${encodeURIComponent(docId)}/findings/${encodeURIComponent(c.finding_id)}/ack`, { reason }); onDismissed(c.finding_id, reason); setMsg(''); }
    catch (e) { setMsg((e as ApiError).message); }
  }
  if (!items.length) return null;
  return (
    <section aria-labelledby="clarify-h" className="fix-list clarify">
      <h2 className="section" id="clarify-h">확인 필요 {open.length ? <b className="num">{open.length}건</b> : '— 모두 처리함'}</h2>
      <p className="note">읽는 사람이 그대로 따라 하기 어려운 곳입니다. 제안을 적용하거나 직접 입력하세요. 담당자는 이름 대신 부서·직책으로 적습니다.</p>
      <ol className="fixes">{items.map((c) => {
        const after = pick[c.finding_id];
        const done = c.status !== 'OPEN';
        return (
          <li key={c.finding_id} className={`fix${done ? ' done' : ''}`}>
            <p className="fix-head">{KIND[c.kind]}{c.page ? ` · ${c.page}쪽` : ''}{c.blocking && !done ? ' · 게시 요청 전에 처리' : ''}{c.status === 'DISMISSED' ? ` · 해당 없음(${c.dismiss_reason ?? ''})` : ''}</p>
            <p><strong>{c.question}</strong></p>
            {isRowText(c.before) ? <div className="basis md"><DocText text={rowAsTable(c.before, c.table_header)} /></div> : <blockquote className="basis"><p>{c.before.split(c.span || c.item).flatMap((part, n, a) => (n < a.length - 1 ? [part, <mark key={n}>{c.span || c.item}</mark>] : [part]))}</p></blockquote>}
            {!done && c.suggestions.map((s, n) => (
              <div key={n} className="clarify-sugg">
                <span className={`src-badge ${s.source.type.toLowerCase()}`}>{SRC[s.source.type]}</span>
                <span>{s.value}</span>
                {s.source.type === 'WIKI' && s.source.doc_id && <Link href={`/library?id=${encodeURIComponent(s.source.doc_id)}${s.source.page ? `&page=${s.source.page}` : ''}`} prefetch={false} title={`${s.source.title ?? '출처 문서'}${s.source.page ? ` ${s.source.page}쪽` : ''}`}>문서 바로가기</Link>}
                {s.source.type === 'WEB' && s.source.url && <a href={s.source.url} target="_blank" rel="noopener noreferrer">{s.source.title ?? s.source.url}</a>}
                {canFix && <button type="button" className={`btn${after === s.after ? ' solid' : ''}`} aria-pressed={after === s.after} onClick={() => setPick((p) => ({ ...p, [c.finding_id]: s.after }))}>적용</button>}
              </div>
            ))}
            {!done && canFix && <div className="clarify-input">
              <label className="lbl" htmlFor={`cv-${c.finding_id}`}>직접 입력{c.kind === 'VAGUE_ACTOR' ? ' (예: 여신심사부 심사역)' : ''}</label>
              <div className="actions" style={{ marginTop: 4 }}>
                <input id={`cv-${c.finding_id}`} className="field" maxLength={80} value={typing[c.finding_id] ?? ''} onChange={(e) => setTyping((t) => ({ ...t, [c.finding_id]: e.target.value }))} />
                <button type="button" className="btn" disabled={!(typing[c.finding_id] ?? '').trim() || busy} onClick={() => compose(c)}>입력값 적용</button>
              </div>
            </div>}
            {!done && after && <ol className="diff-lines" aria-label="고치기 전·후"><li className="del"><span className="num">전</span><del>{c.before}</del></li><li className="add"><span className="num">후</span><ins>{after}</ins></li></ol>}
            {!done && canFix && <details className="clarify-dismiss"><summary>해당 없음</summary>
              <div className="actions" style={{ marginTop: 4 }}>
                <input className="field" aria-label="해당 없음 사유" placeholder="사유 한 줄 (승인자에게 보입니다)" maxLength={200} value={dismissing[c.finding_id] ?? ''} onChange={(e) => setDismissing((t) => ({ ...t, [c.finding_id]: e.target.value }))} />
                <button type="button" className="btn" onClick={() => dismiss(c)}>해당 없음으로 처리</button>
              </div>
            </details>}
          </li>
        );
      })}</ol>
      {canFix && <div className="actions"><button type="button" className="btn solid" disabled={busy || !chosen.length} onClick={save}>{busy ? '저장하는 중' : `${chosen.length}건 반영하고 저장`}</button></div>}
      {msg && <p className="error" role="alert">{msg}</p>}
    </section>
  );
}
