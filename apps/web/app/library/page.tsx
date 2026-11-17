'use client';
import { PaginatedList } from '../paginated-list';
import { DocText, parseDocText } from '../doc-text';
import { PageHeader } from '../page-header';
// 문서보관함: 카드 목록(요약·연관·태그) → 상세(전체 내용을 한 장씩) → 페이지 하단에 요약과 고칠 곳.
// 밑줄은 서버(buildMarks)가 찾은 위치만 긋는다. 화면에서 새로 판단하지 않는다.
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, dateLine, type ExternalLaw, type LibraryCard, type LibraryDoc, type Mark, type VersionDiff, type VersionItem } from '../lib/api';
import { FreshnessFlag, Seal } from '../seal';
import { Changes, PageFacts } from '../issues';
import { decideApproval, rejectSource } from '../lib/decide';

const TYPES = [['', '전체'], ['REGULATION', '규정'], ['KNOWHOW', '노하우'], ['MANUAL', '매뉴얼']] as const;
/** ISO 시각 → 'YYYY-MM-DD' (한국 시간) */
const day = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const REL: Record<LibraryCard['related'][number]['relation'], string> = { CITES: '근거로 인용한 규정', CITED_BY: '이 규정을 근거로 쓴 문서', CONFLICTS: '충돌', SIMILAR: '내용이 비슷함' };
const TYPE_NAME = { REGULATION: '규정', KNOWHOW: '실무 노하우', MANUAL: '매뉴얼' } as const;
const KIND: Record<Mark['kind'], string> = {
  CONFLICT: '규정과 충돌', OUTDATED: '개정 전 규정 인용', INSUFFICIENT: '근거 확인 안 됨',
  REGISTRY_MISMATCH: '공식 원본과 다름', PII_UNCERTAIN: '개인정보 확인 필요', INJECTION: '의심스러운 지시문',
  CONFIRMED: '근거 확인됨', SUPPLEMENT: '실무 보완(참고)',
};

/** Native modal: browser focus trap / Escape, explicit return focus and scroll restoration. */
function DetailPopup({ title, children, open, onClose }: { title: string; children: ReactNode; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current!;
    const trigger = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => { dialog.close(); document.body.style.overflow = overflow; if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, [open]);
  return <dialog ref={ref} className="detail-popup" aria-labelledby={heading} onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <div className="popup-header"><h2 id={heading}>{title}</h2><button type="button" className="btn" autoFocus onClick={onClose}>닫기</button></div>
    {open && children}
  </dialog>;
}
/** filled: 내용이 있는 카드(사용자 요청: 초록 테두리 + '내용 있음' 글자, 색만으로 구분하지 않음) */
function CardLabel({ title, filled }: { title: string; filled: boolean }) {
  return <>{title}{filled && <span className="card-state">내용 있음</span>}</>;
}
function DetailCard({ title, children, filled = true }: { title: string; children: ReactNode; filled?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={`detail-card${filled ? ' filled' : ''}`} aria-haspopup="dialog" onClick={() => setOpen(true)}><CardLabel title={title} filled={filled} /></button><DetailPopup title={title} open={open} onClose={() => setOpen(false)}>{children}</DetailPopup></>;
}

function List() {
  const router = useRouter();
  const sp = useSearchParams();
  const type = sp.get('type') ?? '';
  const business = sp.get('business') ?? '';
  const [items, setItems] = useState<LibraryCard[] | null>(null);
  const [businesses, setBusinesses] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const qs = (t: string, b: string) => new URLSearchParams([...(t ? [['type', t]] : []), ...(b ? [['business', b]] : [])]).toString();
  useEffect(() => {
    setItems(null); setErr('');
    api<{ items: LibraryCard[] }>('GET', `/v1/library?${qs(type, business)}`)
      .then((r) => { setItems(r.items); if (!business) setBusinesses([...new Set(r.items.map((i) => i.business_path[0]).filter((x): x is string => !!x))].sort()); })
      .catch((e: ApiError) => { setErr(e.status === 401 ? '로그인한 뒤 다시 열어 주세요.' : e.message); setItems([]); });
  }, [type, business]);
  const go = (t: string, b: string) => router.push(`/library${qs(t, b) ? `?${qs(t, b)}` : ''}`);
  return (
    <>
      <div className="filter-row"><div className="filter" role="group" aria-label="문서 종류">
        {TYPES.map(([v, l]) => <button key={l} aria-pressed={type === v} onClick={() => go(v, business)}>{l}</button>)}
      </div>
      {businesses.length > 1 && (
        <label className="lbl">업무
          <select className="field" value={business} onChange={(e) => go(type, e.target.value)}>
            <option value="">전체 업무</option>
            {businesses.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
      )}
      </div>{err && <p className="error" role="alert">{err}</p>}
      {items === null ? <p className="note">불러오는 중입니다.</p> : items.length === 0 && !err ? (
        <p className="note">볼 수 있는 문서가 없습니다. 문서를 등록하거나 다른 종류를 골라 보세요.</p>
      ) : (
        <PaginatedList label="문서보관함" className="ledger card-grid library-grid">
          {items.map((d) => (
            <li className="entry" key={d.doc_id}>
              <Seal i={{ authority_status: d.authority_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', document_type: d.document_type ?? 'KNOWHOW', lifecycle: d.lifecycle, freshness: d.freshness, mark_count: d.mark_count }} />
              <h3 className="doc-title"><Link href={`/library?id=${encodeURIComponent(d.doc_id)}`} className="card-link">{d.title}</Link></h3>
              <FreshnessFlag freshness={d.freshness} />
              <dl>
                {d.business_path.length > 0 && <><dt>업무</dt><dd>{d.business_path.join(' › ')}</dd></>}
                {d.tags.length > 0 && <><dt>태그</dt><dd>{d.tags.join(', ')}</dd></>}
                {d.effective_from && <><dt>시행일</dt><dd><span className="num">{d.effective_from}</span></dd></>}
                {!!d.doc_dates?.length && <><dt>문서 일자</dt><dd>{dateLine(d.doc_dates)}</dd></>}
                <dt>버전</dt><dd>v<span className="num">{d.version_no ?? 1}</span>{(d.version_count ?? 1) > 1 && <span className="note"> · 전체 {d.version_count}개 판</span>}</dd><dt>등록일</dt><dd><span className="num">{day(d.uploaded_at)}</span></dd>
                {d.related.length > 0 && <><dt>연관</dt><dd>{d.related.map((r) => `${r.title} (${REL[r.relation]})`).join(', ')}</dd></>}
                {d.mark_count > 0 && <><dt>고칠 곳</dt><dd className="danger-text">{d.mark_count}곳</dd></>}
                {d.lifecycle !== 'PUBLISHED' && <><dt>상태</dt><dd>게시 전 (내 문서)</dd></>}
              </dl>
              <p className="card-summary">{d.summary ?? '요약이 아직 없습니다.'}</p>
              <Link href={`/library?id=${encodeURIComponent(d.doc_id)}`}>문서 보기 →</Link>
            </li>
          ))}
        </PaginatedList>
      )}
    </>
  );
}

/** 확인이 필요한 건의 세 칸: 원본 내용 · 근거 내용 · 근거를 바탕으로 한 수정 내용 (사용자 요청 11/17) */
function Trio({ m }: { m: Mark }) {
  const revision = m.revision ?? (m.kind === 'INSUFFICIENT' ? '근거 조문을 확인한 뒤 고쳐 주세요.' : '수정 필요 없음');
  return (
    <dl className="trio">
      <dt>원본 내용</dt><dd>{m.original ?? <span className="note">(올린 문서에 없음)</span>}</dd>
      <dt>근거 내용</dt>
      <dd>{m.basis ? <><cite>{m.basis.label}{m.basis.effective_from && ` · ${m.basis.effective_from} 시행`}</cite>{m.basis.text}</> : <span className="note">근거 조문 없음</span>}</dd>
      <dt>수정 내용</dt><dd className={m.revision ? 'rev' : 'note'}>{revision}</dd>
    </dl>
  );
}

function Fix({ m, n, on }: { m: Mark; n?: number; on?: boolean }) {
  const trio = m.original !== undefined || m.revision !== undefined; // 새 API(세 칸). 이전 API는 기존 표시
  return (
    <li className={`fix${on ? ' on' : ''}`} id={n ? `mark-${n}` : undefined}>
      <p className="fix-head">{n && <b className="fix-n">{n}</b>}{m.label ?? KIND[m.kind]}{m.severity === 'HIGH' && <span className="danger-text"> · 수정 필요</span>}</p>
      {trio ? <><Trio m={m} /><p className="note" style={{ marginTop: 6 }}>{m.reason}</p></> : <p>{m.reason}</p>}
      {!trio && m.basis && (
        <blockquote className="basis">
          <cite>{m.basis.label}{m.basis.effective_from && ` · ${m.basis.effective_from} 시행`}</cite>
          <p>{m.basis.text}</p>
        </blockquote>
      )}
      {m.fix && m.fix !== m.revision && <p className={trio ? 'note' : undefined}><strong>고칠 내용</strong> {m.fix}</p>}
    </li>
  );
}

/** 본문이 인용한 외부 법령의 최신 공식본 (AgentCore Browser, 참고용·미검증). 첫 조회는 20초 남짓이라 따로 불러온다 */
function ExternalLaws({ id }: { id: string }) {
  const [items, setItems] = useState<ExternalLaw[] | null>(null);
  useEffect(() => { api<{ items: ExternalLaw[] }>('GET', `/v1/library/${encodeURIComponent(id)}/external-laws`).then((r) => setItems(r.items)).catch(() => setItems([])); }, [id]);
  if (items === null) return <p className="note" aria-live="polite">본문이 인용한 법령을 국가법령정보센터에서 확인하는 중입니다…</p>;
  if (!items.length) return <p className="note" role="status">참고할 외부 법령이 없습니다.</p>;
  return (
    <section aria-labelledby="ext-h">
      <h3 className="section" id="ext-h">외부 법령 최신본 참고 <span className="note">(미검증)</span></h3>
      <ul className="fixes">
        {items.map((x) => (
          <li key={x.law_name + (x.clause ?? '')} className="fix">
            <p className="fix-head">「{x.law_name}」{x.clause ? ` ${x.clause}` : ''}{x.result?.effective_from && ` · ${x.result.effective_from} 시행본`}</p>
            {x.error || !x.result ? <p className="note">공식 사이트에서 가져오지 못했습니다. 잠시 뒤 다시 열어 보세요.</p> : (
              <>
                {x.result.clause?.text ? <blockquote className="basis"><p>{x.result.clause.text}</p></blockquote> : <p className="note">요청한 조문을 찾지 못했습니다.</p>}
                <p className="meta">출처 {x.result.source} · 조회 {new Date(x.result.fetched_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}{x.result.from_cache ? ' (1일 보관본)' : ''} · <a href={x.result.url} target="_blank" rel="noopener noreferrer">원문 보기</a></p>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="meta">공식 사이트 원문을 참고로 보여 줍니다. 공식 규정 등록·승인 전에는 검증 근거로 쓰지 않습니다.</p>
    </section>
  );
}

const REVIEW_STATE: Record<string, string> = {
  BLOCKED: '보안 검사에서 자동 차단된 문서입니다. 결재할 필요는 없고, 올린 사람에게 고치는 방법이 안내되었습니다.',
  PENDING_APPROVAL: '게시 승인을 기다리는 문서입니다. 아래 이유를 확인한 뒤 맨 아래에서 승인하거나 반려하세요.',
  IN_REVIEW: '작성자 검토 중인 문서입니다.',
};

/** 결재 대상: 맨 위에 '확인이 필요한 이유'. 누르면 그 쪽·밑줄로 이동 */
function Reasons({ d, jump }: { d: LibraryDoc; jump: (page: number, n: number) => void }) {
  const r = d.review!;
  const located = d.pages.flatMap((pg, pi) => pg.marks.filter((m) => m.severity !== 'LOW').map((m, k) => ({ pi, n: k + 1, m })));
  const total = located.length + d.doc_marks.length + (d.pages.length ? 0 : r.findings.length);
  return (
    <section aria-labelledby="why-h" className="notice" style={{ display: 'block' }}>
      <h3 className="section" id="why-h" style={{ marginTop: 0 }}>확인이 필요한 이유 <span className="danger-text">{total}건</span></h3>
      <p className="note">{r.source_mismatch ? '공식 원본과 내용이 다릅니다. 위조로 확정된 것은 아니며, 출처를 확인한 뒤 반려하거나 작성자에게 정정을 요청하세요.' : REVIEW_STATE[r.lifecycle] ?? ''}</p>
      {total === 0 && <p className="note">자동 검사에서 찾은 문제가 없습니다. 본문을 읽고 판단하세요.</p>}
      <ul className="fixes">
        {located.map(({ pi, n, m }) => (
          <li key={`${pi}-${n}`} className={`fix${m.severity === 'HIGH' ? ' sev-HIGH' : ''}`}>
            <button type="button" className="linklike" onClick={() => jump(pi, n)}>{pi + 1}쪽 {n}번 · {m.label ?? KIND[m.kind]}</button>
            {m.original !== undefined || m.revision !== undefined ? <Trio m={m} /> : <p style={{ margin: 0 }}>{m.reason}</p>}
          </li>
        ))}
        {d.doc_marks.map((m, i) => (
          <li key={`d${i}`} className="fix sev-HIGH"><p className="fix-head">{m.label ?? KIND[m.kind]} (위치 못 찾음)</p>{m.original !== undefined || m.revision !== undefined ? <Trio m={m} /> : <p style={{ margin: 0 }}>{m.reason}</p>}</li>
        ))}
        {!d.pages.length && r.findings.map((f, i) => (
          <li key={`f${i}`} className={`fix${f.severity === 'HIGH' ? ' sev-HIGH' : ''}`}>
            <p className="fix-head">{f.page ? `${f.page}쪽 · ` : ''}{f.severity === 'HIGH' ? '차단 사유' : '확인 필요'}</p>
            <p style={{ margin: 0 }}>{f.message}</p>
            {f.fix_hint && <p style={{ margin: 0 }}><strong>고치는 방법</strong> {f.fix_hint}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 결재 대상 하단 결재 버튼. 출처 불일치는 반려만 */
function Decide({ r, docId }: { r: NonNullable<LibraryDoc['review']>; docId: string }) {
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(false);
  const run = async (f: () => Promise<{ status?: string; msg: string } | undefined>) => { const x = await f(); if (!x) return; setMsg(x.msg); if (x.status) setDone(true); };
  if (!r.source_mismatch && !r.approval_id) return null;
  return (
    <section aria-labelledby="decide-h">
      <h3 className="section" id="decide-h">결재</h3>
      {!done && (
        <div className="actions">
          {r.source_mismatch
            ? <button className="btn" onClick={() => run(() => rejectSource(docId))}>반려</button>
            : <>
                <button className="btn solid" onClick={() => run(() => decideApproval(r.approval_id!, 'APPROVE'))}>승인</button>
                <button className="btn" onClick={() => run(() => decideApproval(r.approval_id!, 'REJECT'))}>반려</button>
              </>}
        </div>
      )}
      <p aria-live="polite" className="note">{msg}</p>
    </section>
  );
}

/** 문서 삭제 (작성자·관리자): 사유 → 확인 → 저장소·검색 색인·관계 그래프 정리 진행 표시 (interfaces 6.0) */
/** 버전 목록(v1 · v2 …)과 직전 버전과 바뀐 곳 (사용자 요청 11/17). 버전이 하나뿐이면 표시하지 않는다 */
function Versions({ id }: { id: string }) {
  const [v, setV] = useState<{ items: VersionItem[]; diff: VersionDiff | null } | null>(null);
  useEffect(() => { api<{ items: VersionItem[]; diff: VersionDiff | null }>('GET', `/v1/library/${encodeURIComponent(id)}/versions`).then(setV).catch(() => setV(null)); }, [id]);
  if (!v || (v.items.length < 2 && !v.diff)) return null;
  return (
    <DetailCard title="버전·바뀐 곳"><section aria-labelledby="vers-h">
      <h3 className="section" id="vers-h">버전</h3>
      <div className="version-list" role="list">
        {v.items.map((x) => (
          <span role="listitem" key={x.doc_id}>
            {x.doc_id === id ? <strong aria-current="page">v{x.version_no}</strong> : <Link href={`/library?id=${encodeURIComponent(x.doc_id)}`}>v{x.version_no}</Link>}
            {x.doc_id === id && <span className="note"> · 보고 있는 판</span>}
            <span className="note"> {x.current ? '오늘 시행 중' : x.freshness === 'SUPERSEDED' ? '대체됨' : x.lifecycle === 'PUBLISHED' ? '' : '게시 전'}</span>
            <p className="note">시행일 {x.effective_from ?? '정보 없음'}</p>
          </span>
        ))}
      </div>
      {v.diff && <Changes diff={v.diff} />}
    </section></DetailCard>
  );
}

/** 원본 파일 내려받기 (사용자 요청 11/17). 60초짜리 주소를 받아 바로 저장. 주소는 화면·저장소에 남기지 않는다 */
function Download({ id }: { id: string }) {
  const [msg, setMsg] = useState('');
  async function go() {
    setMsg('');
    try {
      const r = await api<{ url: string; filename: string }>('GET', `/v1/library/${encodeURIComponent(id)}/download`);
      const a = document.createElement('a');
      a.href = r.url; a.rel = 'noopener'; a.download = r.filename;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { setMsg((e as ApiError).status === 404 ? '원본 파일이 없습니다. 검증 실패나 삭제로 지워진 문서입니다.' : (e as ApiError).message); }
  }
  return <><button type="button" className="btn" onClick={go}>원본 다운로드</button>{msg && <p className="note" role="status">{msg}</p>}</>;
}

function DeleteDoc({ d }: { d: LibraryDoc }) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'slow' | 'error'>('idle');
  const [info, setInfo] = useState('');
  async function del() {
    const reason = prompt('삭제 사유를 적어 주세요 (예: 개정판으로 대체, 중복 등록)')?.trim();
    if (!reason) return;
    if (!confirm(`「${d.title}」을(를) 삭제합니다.\n검색·문서보관함·관계 그래프에서 빠지고 파일은 모든 버전이 지워집니다. 되돌릴 수 없습니다.\n결재·감사 기록은 남습니다. 계속할까요?`)) return;
    try {
      await api('DELETE', `/v1/documents/${encodeURIComponent(d.doc_id)}`, { reason });
    } catch (e) { setState('error'); setInfo((e as ApiError).message); return; }
    setState('running');
    // 정리(저장소 → 검색 색인 → 그래프)는 보통 1~3분. Finalize가 purge.deleted_at을 남기면 끝
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const x = await api<{ purge?: { deleted_at?: string; review_required?: string[] } }>('GET', `/v1/documents/${encodeURIComponent(d.doc_id)}`).catch(() => undefined);
      if (x?.purge?.deleted_at) {
        const n = x.purge.review_required?.length ?? 0;
        setState('done');
        setInfo(n ? `이 문서를 근거로 쓰던 게시 문서 ${n}건을 재검토 대상으로 표시했습니다.` : '');
        return;
      }
    }
    setState('slow');
  }
  if (!d.can_delete) return null;
  return (
    <section aria-labelledby="del-h" style={{ marginTop: 28 }}>
      <h3 className="section" id="del-h">문서 삭제</h3>
      {state === 'idle' && <><p className="note">검색·보관함·관계 그래프에서 빼고 파일을 모두 지웁니다. 결재·감사 기록은 남습니다.</p><div className="actions"><button className="btn" onClick={del}>문서 삭제</button></div></>}
      <p aria-live="polite" className={state === 'error' ? 'error' : 'note'}>
        {state === 'running' && '삭제했습니다. 저장소·검색 색인·관계 그래프를 정리하는 중입니다(보통 1~3분).'}
        {state === 'done' && `삭제와 정리가 끝났습니다. ${info}`}
        {state === 'slow' && '삭제는 되었고 정리가 아직 진행 중입니다. 검색·보관함에는 이미 보이지 않습니다. 잠시 뒤 다시 확인해 주세요.'}
        {state === 'error' && `삭제하지 못했습니다: ${info}`}
      </p>
      {(state === 'done' || state === 'slow') && <Link href="/library">보관함으로</Link>}
    </section>
  );
}

function Detail({ id, from }: { id: string; from?: string | null }) {
  const [d, setD] = useState<LibraryDoc | null>(null);
  const [err, setErr] = useState('');
  const [p, setP] = useState(0);
  const [active, setActive] = useState(0);
  const [raw, setRaw] = useState(false); // false: AI 정리본(있으면), true: 원문(고칠 곳 밑줄)
  const [fixOpen, setFixOpen] = useState(false);
  const [reasonsOpen, setReasonsOpen] = useState(false);
  useEffect(() => {
    api<LibraryDoc>('GET', `/v1/library/${encodeURIComponent(id)}`)
      .then((x) => {
        setD(x);
        // 다른 유형의 비슷한 문서는 검색이 필요해 따로 불러와 붙인다
        api<{ items: LibraryDoc['related'] }>('GET', `/v1/library/${encodeURIComponent(id)}/similar`)
          .then((r) => setD((cur) => (cur ? { ...cur, related: [...cur.related, ...r.items.filter((s) => !cur.related.some((c) => c.doc_id === s.doc_id))] } : cur)))
          .catch(() => {});
      })
      .catch((e: ApiError) => setErr(e.status === 404 ? '문서를 찾을 수 없거나 볼 권한이 없습니다.' : e.message));
  }, [id]);
  if (err) return <><p className="error" role="alert">{err}</p>{from === 'admin' ? <Link href="/admin">결재함으로 돌아가기</Link> : <Link href="/library">보관함으로 돌아가기</Link>}</>;
  if (!d) return <p className="note">불러오는 중입니다.</p>;
  const page = d.pages[p];
  // LOW(근거 확인됨·실무 보완)는 고칠 곳이 아니라 참고. 밑줄은 고칠 곳만 긋는다
  const numbered = (page?.marks ?? []).filter((m) => m.severity !== 'LOW').map((m, i) => ({ m, n: i + 1 }));
  const notes = (page?.marks ?? []).filter((m) => m.severity === 'LOW');
  const go = (i: number) => { setP(i); setActive(0); };
  const jump = (i: number, n: number) => { setRaw(true); setReasonsOpen(false); setFixOpen(true); setP(i); setActive(n); setTimeout(() => document.getElementById(`mark-${n}`)?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }), 0); };
  const back = from === 'admin' ? <Link className="btn" href="/admin">결재함으로 돌아가기</Link> : <Link className="btn" href="/library">보관함</Link>;
  return (
    <>
      <PageHeader title={d.title} description="본문과 근거를 확인하고 필요한 조치를 진행하세요." action={back} />
      <header className="document-header">
      <Seal size="full" i={{ authority_status: d.authority_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', document_type: d.document_type ?? 'KNOWHOW', lifecycle: d.lifecycle, freshness: d.freshness, mark_count: d.mark_count }} />
      <FreshnessFlag freshness={d.freshness} /><p className="note">{d.freshness !== 'CURRENT' ? '현행 근거와 최신 버전을 먼저 확인해 주세요.' : d.authority_status === 'VERIFIED' ? '시행일과 인용 근거를 확인한 뒤 업무에 참고해 주세요.' : '근거 검증이 완료되지 않았습니다. 확인할 내용과 출처를 먼저 살펴봐 주세요.'}</p>{d.summary && <p className="lead">{d.summary}</p>}<div className="actions"><Download id={d.doc_id} /></div><dl className="meta-grid">
        {d.business_path.length > 0 && <><dt>업무</dt><dd>{d.business_path.join(' › ')}</dd></>}
        {d.effective_from && <><dt>시행일</dt><dd><span className="num">{d.effective_from}</span></dd></>}
        {d.doc_dates?.length ? <><dt>문서 일자</dt><dd>{dateLine(d.doc_dates)} (본문 표기)</dd></> : d.doc_date && <><dt>문서 {d.doc_date.label}</dt><dd>{d.doc_date.date} (본문 표기)</dd></>}
        <dt>버전</dt><dd>v<span className="num">{d.version_no ?? 1}</span>{(d.version_count ?? 1) > 1 && <span className="note"> · 전체 {d.version_count}개 판</span>}</dd><dt>등록일</dt><dd><span className="num">{day(d.uploaded_at)}</span></dd>
        {d.updated_at.slice(0, 10) !== d.uploaded_at.slice(0, 10) && <><dt>최근 변경</dt><dd><span className="num">{day(d.updated_at)}</span></dd></>}
        {d.tags.length > 0 && <><dt>태그</dt><dd>{d.tags.join(', ')}</dd></>}

      </dl></header>

      <div className="detail-layout"><div className="detail-body">

      {d.superseded_by && <p className="notice" role="status">새 버전이 게시되어 이 문서는 대체되었습니다. <Link href={`/library?id=${encodeURIComponent(d.superseded_by)}`}>최신 버전 보기</Link></p>}
      {d.freshness_reason?.deleted_doc ? (
        <p className="notice" role="status">
          근거로 쓰던 「{d.freshness_reason.law_name}」 문서가 삭제되었습니다. 근거 조문을 다시 확인해야 합니다. 게시는 유지되며 수정 승인 전까지 자동으로 바뀌지 않습니다.
        </p>
      ) : d.freshness_reason && (
        <p className="notice" role="status">
          근거 규정 「{d.freshness_reason.law_name}」이 {d.freshness_reason.effective_from} 시행 개정판으로 바뀌었습니다.
          이 문서는 {d.freshness_reason.cited_revision} 판을 근거로 승인되어, 현행 조문과 맞는지 다시 검토해야 합니다.
          게시는 유지되며 수정 승인 전까지 자동으로 바뀌지 않습니다.
        </p>
      )}


      {!page ? <p className="note">표시할 본문이 없습니다. 개인정보를 가린 본문이 아직 만들어지지 않았습니다.</p> : (
        <section aria-label={`${p + 1}쪽`}>
          <div className="pager">
            <button className="btn" disabled={p === 0} onClick={() => go(p - 1)}>이전 쪽</button>
            <span aria-live="polite"><span className="num">{p + 1} / {d.pages.length}</span>쪽</span>
            <button className="btn" disabled={p === d.pages.length - 1} onClick={() => go(p + 1)}>다음 쪽</button>
          </div>
          {parseDocText(page.text).some((b) => b.kind === 'clause') && <details className="clause-index"><summary>이 쪽 목차 · 조문 바로가기</summary><ul>{parseDocText(page.text).filter((b) => b.kind === 'clause').map((b) => <li key={b.start}><a href={`#clause-${b.start}`}>{page.text.slice(b.start, b.end).match(/^제\s*\d+\s*(?:조(?:의\d+)?(?:\([^)]*\))?|장.*|절.*)/)?.[0] ?? page.text.slice(b.start, Math.min(b.end, b.start + 80))}</a></li>)}</ul></details>}
          {page.structured && <div className="view-toggle" role="group" aria-label="본문 보기 방식">
            <button type="button" className="btn" aria-pressed={!raw} onClick={() => setRaw(false)}>정리본</button>
            <button type="button" className="btn" aria-pressed={raw} onClick={() => setRaw(true)}>원문{numbered.length > 0 ? ` · 고칠 곳 ${numbered.length}` : ''}</button>
          </div>}
          <div className="document-columns"><div className="sheet page">
            {page.structured && !raw ? <><p className="note">AI가 원문 글자를 바꾸지 않고 읽기 좋게 다시 배치한 본문입니다. 고칠 곳 밑줄은 원문에서 보입니다.</p><DocText text={page.structured} /></> : <DocText text={page.text} marks={numbered} active={active} onPick={(n) => { setActive(n); setFixOpen(true); setTimeout(() => document.getElementById(`mark-${n}`)?.scrollIntoView({ block: 'nearest' }), 0); }} />}
          </div>
          <aside className="page-checks" aria-label="이 쪽 한눈에 보기"><h3 className="section">이 쪽 한눈에 보기</h3>
            <dl className="meta-grid"><dt>현재 쪽</dt><dd>{p + 1} / {d.pages.length}</dd><dt>고칠 곳</dt><dd>{numbered.length}곳</dd><dt>참고</dt><dd>{notes.length}건</dd></dl>
          </aside>          </div>
        </section>
      )}

      </div><div className="document-more">
      <div className="detail-cards" aria-label="문서 상세 항목">
      {page && <DetailCard title="이 쪽 요약" filled={!!page.summary}><h3 className="section">이 쪽 요약</h3><p>{page.summary ?? '요약이 아직 없습니다.'}</p><PageFacts m={page} /></DetailCard>}
      {(numbered.length > 0 || d.doc_marks.length > 0) && <button type="button" className="detail-card filled" aria-haspopup="dialog" onClick={() => setFixOpen(true)}><CardLabel title="고칠 곳" filled /></button>}
      <DetailPopup title="고칠 곳" open={fixOpen} onClose={() => setFixOpen(false)}><h3 className="section">{p + 1}쪽 고칠 곳</h3><ul className="fixes">{numbered.map(({ m, n }) => <Fix key={n} m={m} n={n} on={active === n} />)}</ul>{d.doc_marks.length > 0 && <><h3 className="section" id="doc-marks">본문에서 위치를 찾지 못한 항목</h3><ul className="fixes">{d.doc_marks.map((m, i) => <Fix key={i} m={m} />)}</ul></>}</DetailPopup>
      {notes.length > 0 && <DetailCard title="확인된 근거·실무 보완"><h3 className="section">참고: 확인된 근거·실무 보완</h3><ul className="fixes">{notes.map((m, i) => <Fix key={i} m={m} />)}</ul></DetailCard>}
      {d.review && <><button type="button" className="detail-card filled" aria-haspopup="dialog" onClick={() => setReasonsOpen(true)}><CardLabel title="확인이 필요한 이유" filled /></button><DetailPopup title="확인이 필요한 이유" open={reasonsOpen} onClose={() => setReasonsOpen(false)}><Reasons d={d} jump={jump} /></DetailPopup></>}
      <Versions id={d.doc_id} />      {d.verification && (
        <DetailCard title="검증 정보"><section aria-labelledby="verify-h">
          <h3 className="section" id="verify-h">검증 정보</h3>
          <dl className="meta-grid">
            <dt>검증한 사람</dt><dd>{d.verification.approved_by ?? '아직 승인 전'}</dd>
            <dt>검증 시각</dt><dd>{d.verification.approved_at ? new Date(d.verification.approved_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-'}</dd>
            {d.verification.approval_reason && <><dt>승인 의견</dt><dd>{d.verification.approval_reason}</dd></>}
            <dt>검증 방법</dt><dd>{d.verification.method}</dd>
          </dl>
        </section></DetailCard>
      )}
      {d.verification && d.verification.basis.length > 0 && (
        <DetailCard title="비교한 대상">
          {d.verification.basis.length > 0 && (
            <>
              <p className="note" style={{ margin: '10px 0 4px' }}>비교한 대상</p>
              <ul className="fixes">
                {d.verification.basis.map((b, i) => (
                  <li key={i} className="fix">
                    <p className="fix-head">{b.what} · {b.label}{b.effective_from && ` · ${b.effective_from} 시행`}</p>
                    <p>{b.result}</p>
                    {b.quote && <blockquote className="basis"><p>{b.quote}</p></blockquote>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </DetailCard>
      )}

      {d.related.length > 0 && (
        <DetailCard title="관련 문서"><section aria-labelledby="rel-h">
          <h3 className="section" id="rel-h">함께 보면 좋은 문서</h3>
          {(['REGULATION', 'KNOWHOW', 'MANUAL'] as const).map((t) => {
            const rs = d.related.filter((r) => (r.document_type ?? 'KNOWHOW') === t);
            if (!rs.length) return null;
            return (
              <div key={t} style={{ marginBottom: 10 }}>
                <p className="note" style={{ margin: '6px 0 2px' }}>{TYPE_NAME[t]}</p>
                <PaginatedList label={`${TYPE_NAME[t]} 관련 문서`} pageKey={`related_${t}`} className="fixes">{rs.map((r) => (
                  <li key={r.doc_id} className={`fix${r.relation === 'CONFLICTS' ? ' sev-HIGH' : ''}`}>
                    <p style={{ margin: 0 }}><Link href={`/library?id=${encodeURIComponent(r.doc_id)}`}>{r.title}</Link></p>
                    <p className="meta" style={{ margin: 0 }}>{REL[r.relation]} · {r.reason}</p>
                  </li>
                ))}</PaginatedList>
              </div>
            );
          })}
        </section></DetailCard>
      )}
      <DetailCard title="외부 법령 참고" filled={false}><ExternalLaws id={d.doc_id} /></DetailCard>
      </div>{d.review && <Decide r={d.review} docId={d.doc_id} />}

<DeleteDoc d={d} /></div></div>
      {from === 'admin' && <p style={{ marginTop: 16 }}>{back}</p>}
    </>
  );
}

function View() {
  const sp = useSearchParams();
  const id = sp.get('id');
  return id ? <Detail key={id} id={id} from={sp.get('from')} /> : <><PageHeader title="문서보관함" description="검증 상태와 현행 여부를 확인한 뒤 업무에 참고하세요." action={<Link className="btn" href="/search">문서 검색</Link>} /><List /></>;
}

export default function LibraryPage() {
  return <><Suspense fallback={<p className="note">불러오는 중입니다.</p>}><View /></Suspense></>;
}

