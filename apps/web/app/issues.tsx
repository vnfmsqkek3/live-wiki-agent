'use client';
// 올린 사람에게 "몇 쪽 어디가 왜, 어떻게 고치는지" (사용자 지시 11/17). 쪽 이미지는 개인정보를 가린 마스킹본만 보여 준다
import { useEffect, useState } from 'react';
import { api, apiBlobUrl, type Explanation, type Issue, type Issues } from './lib/api';

const SEV: Record<Issue['severity'], string> = { HIGH: '등록 불가·수정 필요', MEDIUM: '확인 필요', LOW: '참고' };

/** AgentCore가 확인 결과를 사람이 읽을 문장으로 정리한 설명 (판정은 바꾸지 않음) */
function ExplainView({ e, issues, pages, onPage }: { e: Explanation; issues: Issue[]; pages: number[]; onPage: (p: number) => void }) {
  const pageOf = (id: string, p?: number) => p ?? issues.find((i) => i.finding_id === id)?.location?.page;
  return (
    <div className="explain">
      <p className="lead" style={{ marginTop: 0 }}>{e.summary}</p>
      <ul className="fixes">
        {e.items.map((it) => {
          const p = pageOf(it.finding_id, it.page);
          return (
            <li key={it.finding_id} className={`fix ${it.risk === '높음' ? 'sev-HIGH' : ''}`}>
              <p className="fix-head">{p ? `${p}쪽 · ` : ''}{it.where} <span className={it.risk === '높음' ? 'danger-text' : 'note'}>· 위험도 {it.risk}</span></p>
              <p><strong>무엇이</strong> {it.problem}</p>
              <p><strong>왜</strong> {it.reason}</p>
              <p><strong>고치는 방법</strong> {it.fix}</p>
              {p && pages.includes(p) && <button className="btn" type="button" onClick={() => onPage(p)}>{p}쪽에서 위치 보기</button>}
            </li>
          );
        })}
      </ul>
      {e.next_action && <p><strong>다음에 할 일</strong> {e.next_action}</p>}
      <p className="meta">AI가 검사 결과를 설명한 내용입니다. 등록 가능 여부 판정은 검사 규칙이 정하며, 설명이 판정을 바꾸지 않습니다.</p>
    </div>
  );
}

function PageView({ docId, page, items, onClose }: { docId: string; page: number; items: Issue[]; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let u = '';
    apiBlobUrl(`/v1/documents/${encodeURIComponent(docId)}/pages/${page}/image`).then((x) => { u = x; setUrl(x); }).catch(() => setErr('이 쪽은 이미지가 없습니다. 아래 문장으로 위치를 확인해 주세요.'));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [docId, page]);
  const boxes = items.flatMap((i) => i.location?.bbox ?? []);
  return (
    <div className="page-view">
      <div className="actions" style={{ marginTop: 0 }}><strong>{page}쪽</strong><button className="btn" type="button" onClick={onClose}>닫기</button></div>
      {err ? <p className="note">{err}</p> : !url ? <p className="note">불러오는 중입니다.</p> : (
        <div className="page-img">
          <img src={url} alt={`${page}쪽 (개인정보를 가린 이미지)`} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          {size && boxes.map(([x0, y0, x1, y1], i) => (
            <span key={i} className="bbox" aria-hidden="true" style={{ left: `${(x0! / size.w) * 100}%`, top: `${(y0! / size.h) * 100}%`, width: `${((x1! - x0!) / size.w) * 100}%`, height: `${((y1! - y0!) / size.h) * 100}%` }} />
          ))}
        </div>
      )}
    </div>
  );
}

export function IssueList({ docId, refreshKey }: { docId: string; refreshKey?: unknown }) {
  const [d, setD] = useState<Issues | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { api<Issues>('GET', `/v1/documents/${encodeURIComponent(docId)}/issues`).then(setD).catch(() => setD(null)); }, [docId, refreshKey]);
  if (!d) return null;
  const shown = d.items.filter((i) => i.severity !== 'LOW');
  const info = d.items.filter((i) => i.severity === 'LOW');
  return (
    <section aria-labelledby="issues-h" className="issues">
      <h2 className="section" id="issues-h">확인할 내용 {shown.length > 0 && <span className="danger-text">{shown.length}건</span>}</h2>
      {d.explanation && <ExplainView e={d.explanation} issues={d.items} pages={d.page_images} onPage={setOpen} />}
      {shown.length === 0 && <p className="note">고쳐야 할 내용이 없습니다.</p>}
      {d.explanation && shown.length > 0 && <h3 className="section" style={{ fontSize: '.9rem' }}>검사 항목별 결과</h3>}
      <ul className="fixes">
        {shown.map((i, n) => (
          <li key={n} className={`fix sev-${i.severity}`}>
            <p className="fix-head">{i.step_label}{i.location?.page && <> · {i.location.page}쪽</>} <span className={i.severity === 'HIGH' ? 'danger-text' : 'note'}>· {SEV[i.severity]}</span></p>
            <p>{i.user_message}</p>
            {i.location?.excerpt && <blockquote className="basis"><p>{i.location.excerpt}</p></blockquote>}
            {i.fix_hint && <p><strong>고치는 방법</strong> {i.fix_hint}</p>}
            {i.location?.page && d.page_images.includes(i.location.page) && (
              <button className="btn" type="button" onClick={() => setOpen(i.location!.page!)}>{i.location.page}쪽에서 위치 보기</button>
            )}
          </li>
        ))}
      </ul>
      {open !== null && <PageView docId={docId} page={open} items={d.items.filter((i) => i.location?.page === open)} onClose={() => setOpen(null)} />}
      {info.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="note">자동으로 처리한 내용 {info.length}건</summary>
          <ul className="fixes">{info.map((i, n) => <li key={n} className="fix"><p style={{ margin: 0 }}>{i.user_message}</p></li>)}</ul>
        </details>
      )}
    </section>
  );
}
