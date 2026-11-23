'use client';
import { PaginatedList } from '../paginated-list';
import { DocText, parseDocText } from '../doc-text';
import { PageHeader } from '../page-header';
// 문서보관함: 카드 목록(요약·연관·태그) → 상세(전체 내용을 한 장씩) → 페이지 하단에 요약과 고칠 곳.
// 밑줄은 서버(buildMarks)가 찾은 위치만 긋는다. 화면에서 새로 판단하지 않는다.
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ConfirmCurrent } from '../confirm-current';
import { isAdmin } from '../lib/roles';
import { api, ApiError, getSession, isCheck, dateLine, type ExternalLaw, type CategoryNode, type LibraryCard, type LibraryDoc, type Mark, type VersionDiff, type VersionItem, markViewed } from '../lib/api';
import { FreshnessFlag, Popularity, Scheduled, Seal, Upcoming } from '../seal';
import { WikiEditor } from '../wiki-editor';
import { LibraryTree } from '../library-tree';
import { CardBoundary } from '../card-boundary';
import { isRowText, rowAsTable } from '../clarify';
import { Icon } from '../icons';
import { RefSuggestions, withReference, type RefSuggestion } from '../ref-suggestions';
import { Changes, PageFacts } from '../issues';
import { decideApproval, rejectSource, APPROVE_CHIPS } from '../lib/decide';

const TYPES = [['', '전체'], ['REGULATION', '규정'], ['KNOWHOW', '노하우'], ['MANUAL', '매뉴얼']] as const;
/** ISO 시각 → 'YYYY-MM-DD' (한국 시간) */
const day = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const REL: Record<LibraryCard['related'][number]['relation'], string> = { CITES: '근거로 인용한 규정', CITED_BY: '이 규정을 근거로 쓴 문서', CONFLICTS: '충돌', SIMILAR: '내용이 비슷함' };
const TYPE_NAME = { REGULATION: '규정', KNOWHOW: '실무 노하우', MANUAL: '매뉴얼' } as const;
const KIND: Record<Mark['kind'], string> = {
  CONFLICT: '규정과 충돌', OUTDATED: '개정 전 규정 인용', INSUFFICIENT: '근거 확인 안 됨', BASIS_MISMATCH: '근거와 다름',
  REGISTRY_MISMATCH: '공식 원본과 다름', PII_UNCERTAIN: '개인정보 확인 필요', INJECTION: '의심스러운 지시문',
  CONFIRMED: '근거 확인됨', SUPPLEMENT: '실무 보완(참고)',
};

/** Native modal: browser focus trap / Escape, explicit return focus and scroll restoration. */
function DetailPopup({ title, children, open, onClose }: { title: string; children: ReactNode; open: boolean; onClose: () => void }) {
  // 비모달 (총괄·엔드유저 11/20 U4): 창이 열려 있어도 결재 의견·승인·반려를 키보드·화면 낭독기로 쓸 수 있게. Esc로 닫는다
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const close = useRef(onClose); close.current = onClose; // 부모가 매번 새 함수를 넘겨도 창을 다시 열지 않게
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current!;
    const trigger = document.activeElement as HTMLElement | null;
    dialog.show();
    dialog.querySelector<HTMLElement>('.popup-header button')?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); }; // 초점이 창 밖에 있어도 Esc로 닫힘 (QA nit)
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('keydown', esc); dialog.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, [open]);
  return <dialog ref={ref} className="detail-popup" aria-labelledby={heading}>
    <div className="popup-header"><h2 id={heading}>{title}</h2><button type="button" className="btn" onClick={onClose}>닫기</button></div>
    {open && children}
  </dialog>;
}
/** filled: 내용이 있는 카드(사용자 요청: 초록 테두리 + '내용 있음' 글자, 색만으로 구분하지 않음) */
function CardLabel({ title, filled, count, warn, lazy }: { title: string; filled: boolean; count?: number; warn?: boolean; lazy?: boolean }) {
  // 건수가 있으면 건수, 없으면 '내용 있음' (판단용 카드는 건수를 크게, Fable 재배치안 11/18)
  return <>{title}{count !== undefined ? <span className={`card-count num${warn && count ? ' warn' : ''}`}>{count}건</span> : <span className={`card-state${filled ? '' : ' empty'}`}>{filled ? '내용 있음' : lazy ? '열어서 확인' : '없음'}</span>}</>;
}
const CLAIM_REL: Record<string, string> = { SUPPORTS: '규정과 일치', SUPPLEMENTS: '규정 범위 안의 실무 보완', CONFLICTS: '규정과 어긋남', INSUFFICIENT: '관련 조문 확인 필요', UNRELATED: '관련 없음' };
type Basis = { what: string; label: string; result: string; quote?: string; effective_from?: string; statement?: string; reason?: string; relation?: string };
/** 비교한 대상: 같은 조문은 한 묶음으로, 그 아래에 비교한 문서 문장마다 판정 (사용자 지적 11/17: 같은 조문이 반복돼 무엇이 다른지 모름) */
function groupBasis(basis: Basis[]) {
  const by = new Map<string, Basis & { key: string; rows: Basis[] }>();
  for (const b of basis) {
    const key = `${b.what}|${b.label}`;
    const g = by.get(key) ?? { ...b, key, rows: [] };
    if (!g.rows.some((r) => r.statement === b.statement && r.result === b.result)) g.rows.push(b);
    by.set(key, g);
  }
  return [...by.values()];
}

/** 원본: 모든 쪽을 원래 모습 그대로(개인정보만 검게) 세로로. 쪽별 파일 presigned URL(5분), 지연 로딩, 누르면 크게 */
function OriginalPages({ docId, start, fallback }: { docId: string; start: number; fallback?: string }) {
  const [items, setItems] = useState<{ page: number; url: string }[] | null>(null);
  const [big, setBig] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { api<{ items: { page: number; url: string }[] }>('GET', `/v1/library/${encodeURIComponent(docId)}/pages`).then((r) => setItems(r.items)).catch(() => setItems([])); }, [docId]);
  useEffect(() => { if (items?.length) document.getElementById(`orig-${start}`)?.scrollIntoView({ block: 'start' }); }, [items, start]);
  useEffect(() => { const d = ref.current; if (!d) return; if (big && !d.open) d.showModal(); if (!big && d.open) d.close(); }, [big]);
  if (items === null) return <p className="note">원본 쪽 이미지를 불러오는 중입니다.</p>;
  // 쪽 이미지가 없는 문서(이 기능 전 업로드, 글자 문서)는 개인정보를 가린 글자로 대신 보여 준다
  if (!items.length) return fallback ? <div className="sheet page"><p className="note">이 문서는 쪽 이미지가 없어 개인정보를 가린 글자로 보여 줍니다.</p><DocText text={fallback} /></div> : <p className="note">쪽 이미지가 없습니다.</p>;
  return (
    <div className="original-pages">
      <p className="note">개인정보는 회색 '개인정보' 칸으로 필터링했습니다. 필터링하지 않은 원본은 올린 사람·결재자만 원본 파일로 볼 수 있습니다. 쪽을 누르면 크게 봅니다.</p>
      {items.map((x) => (
        <figure key={x.page} id={`orig-${x.page}`} className="orig-page">
          <button type="button" className="fig-thumb" onClick={() => setBig(x.url)} aria-label={`${x.page}쪽 크게 보기`}><img src={x.url} loading="lazy" alt={`${x.page}쪽 필터링된 원문`} /></button>
          <figcaption className="note">{x.page}쪽</figcaption>
        </figure>
      ))}
      <dialog ref={ref} className="fig-zoom" onClose={() => setBig(null)} onClick={(e) => { if (e.target === ref.current) setBig(null); }}>
        {big && <img src={big} alt="필터링된 원문 쪽 크게" />}
        <form method="dialog"><button className="btn">닫기</button></form>
      </dialog>
    </div>
  );
}

/** 큰 그림 보기 (정리본 인라인 그림) */
function ZoomDialog({ url, onClose }: { url: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (!d) return; if (url && !d.open) d.showModal(); if (!url && d.open) d.close(); }, [url]);
  return (
    <dialog ref={ref} className="fig-zoom" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {url && <img src={url} alt="그림 크게 (개인정보는 가림)" />}
      <form method="dialog"><button className="btn">닫기</button></form>
    </dialog>
  );
}

function DetailCard({ title, children, filled = true, group = 'ref', count, lazy }: { title: string; children: ReactNode; filled?: boolean; group?: 'judge' | 'ref'; count?: number; lazy?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={`detail-card ${group}${filled ? ' filled' : ''}`} aria-haspopup="dialog" onClick={() => setOpen(true)}><CardLabel title={title} filled={filled} count={count} lazy={lazy} /></button><DetailPopup title={title} open={open} onClose={() => setOpen(false)}>{children}</DetailPopup></>;
}

function List() {
  const router = useRouter();
  const sp = useSearchParams();
  const type = sp.get('type') ?? '';
  const category = sp.get('category') ?? ''; // 업무 분류 칸 (AI 자동 분류, 하위 칸 포함)
  const only = ONLY[sp.get('only') ?? '']; // 결재함 숫자 카드에서 온 필터
  const view = sp.get('view') === 'tree' ? 'tree' : 'cards'; // 보기: 카드 / 폴더 (사용자 11/23)
  const sort = sp.get('sort') === 'rating' ? 'rating' : 'recent'; // 정렬: 최신 / 별점 높은 순
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp.toString()); if (v) n.set(k, v); else n.delete(k); router.push(`/library${n.size ? `?${n}` : ''}`); };
  const [items, setItems] = useState<LibraryCard[] | null>(null);
  const [cats, setCats] = useState<CategoryNode[]>([]);
  const [err, setErr] = useState('');
  const qs = (t: string, c: string) => new URLSearchParams([...(t ? [['type', t]] : []), ...(c ? [['category', c]] : [])]).toString();
  useEffect(() => { api<{ items: CategoryNode[] }>('GET', '/v1/categories').then((r) => setCats(r.items)).catch(() => setCats([])); }, []);
  useEffect(() => {
    setItems(null); setErr('');
    api<{ items: LibraryCard[] }>('GET', `/v1/library?${qs(type, category)}`)
      .then((r) => setItems(only ? r.items.filter(only.f) : r.items))
      .catch((e: ApiError) => { setErr(e.status === 401 ? '로그인한 뒤 다시 열어 주세요.' : e.message); setItems([]); });
  }, [type, category, only]);
  const go = (t: string, c: string) => router.push(`/library${qs(t, c) ? `?${qs(t, c)}` : ''}`);
  // 1단계 칸 → 고르면 그 아래 칸. 문서가 있는 칸만 (고른 칸은 늘 보임)
  const sel = cats.find((x) => x.category_id === category);
  const root = sel ? cats.find((x) => x.path === sel.path.split('/')[0]) : undefined;
  const shown = (x: CategoryNode) => x.doc_count > 0 || x.category_id === category;
  const level1 = cats.filter((x) => x.level === 1 && shown(x));
  const children = root ? cats.filter((x) => x.parent_id === root.category_id && shown(x)) : [];
  return (
    <>
      <div className="filter-row"><div className="filter" role="group" aria-label="문서 종류">
        {TYPES.map(([v, l]) => <button key={l} aria-pressed={type === v} onClick={() => go(v, category)}>{l}</button>)}
      </div>
      <div className="filter" role="group" aria-label="보기"><span className="filter-lbl" aria-hidden="true">보기</span>
        <button aria-pressed={view === 'cards'} onClick={() => setParam('view', '')}>카드</button><button aria-pressed={view === 'tree'} onClick={() => setParam('view', 'tree')}>폴더</button>
      </div>
      <div className="filter" role="group" aria-label="정렬"><span className="filter-lbl" aria-hidden="true">정렬</span>
        <button aria-pressed={sort === 'recent'} onClick={() => setParam('sort', '')}>최신순</button><button aria-pressed={sort === 'rating'} onClick={() => setParam('sort', 'rating')}>별점 높은 순</button>
      </div>
      </div>
      {level1.length > 0 && (
        <nav className="cat-nav" aria-label="업무 분류">
          <div className="chips">
            <button type="button" className="chip" aria-pressed={!category} onClick={() => go(type, '')}>전체 업무</button>
            {level1.map((x) => <button key={x.category_id} type="button" className="chip" aria-pressed={root?.category_id === x.category_id} title={x.description} onClick={() => go(type, x.category_id)}>{x.name} <span className="num">{x.doc_count}</span></button>)}
          </div>
          {children.length > 0 && <div className="chips sub">
            {children.map((x) => <button key={x.category_id} type="button" className="chip" aria-pressed={category === x.category_id} title={x.description} onClick={() => go(type, category === x.category_id ? root!.category_id : x.category_id)}>{x.name} <span className="num">{x.doc_count}</span></button>)}
          </div>}
        </nav>
      )}{err && <p className="error" role="alert">{err}</p>}
      {only && <p className="notice" role="status">{only.label} 문서만 보고 있습니다. <Link href="/library">전체 보기</Link></p>}
      {items === null ? <p className="note">불러오는 중입니다.</p> : items.length === 0 && !err ? (
        <p className="note">볼 수 있는 문서가 없습니다. 문서를 등록하거나 다른 종류를 골라 보세요.</p>
      ) : (
        view === 'tree' ? <LibraryTree items={sorted(items, sort)} /> :
        <PaginatedList label="문서보관함" className="ledger card-grid library-grid">
          {sorted(items, sort).map((d) => (
            <li className="entry" key={d.doc_id}>
              <Seal i={{ authority_status: d.authority_status, document_type: d.document_type ?? 'KNOWHOW', lifecycle: d.lifecycle, freshness: d.freshness, mark_count: d.mark_count }} />
              <h3 className="doc-title"><Link href={`/library?id=${encodeURIComponent(d.doc_id)}`} className="card-link">{d.title}</Link><Scheduled date={d.effective_from} /></h3>
              <FreshnessFlag freshness={d.freshness} reason={d.freshness_reason} max={1} /><Upcoming u={d.upcoming} />
              <dl>
                {d.category_path ? <><dt>분류</dt><dd>{d.category_path.split('/').join(' › ')}</dd></> : d.business_path.length > 0 && <><dt>업무</dt><dd>{d.business_path.join(' › ')}</dd></>}
                {d.tags.length > 0 && <><dt>태그</dt><dd>{d.tags.join(', ')}</dd></>}
                {d.rating && <><dt>평점</dt><dd><Popularity r={d.rating} /></dd></>}
                {d.effective_from && <><dt>시행일</dt><dd><span className="num">{d.effective_from}</span></dd></>}
                {!!d.doc_dates?.length && <><dt>문서 일자</dt><dd>{dateLine(d.doc_dates)}</dd></>}
                <dt>버전</dt><dd>v<span className="num">{d.version_no ?? 1}</span>{(d.version_count ?? 1) > 1 && <span className="note"> · 전체 {d.version_count}개 판</span>}</dd><dt>등록일</dt><dd><span className="num">{day(d.uploaded_at)}</span></dd>
                {d.related.length > 0 && <><dt>연관</dt><dd>{d.related.map((r) => `${r.title} (${REL[r.relation]})`).join(', ')}</dd></>}
                {d.mark_count > 0 && <><dt>고칠 곳</dt><dd className="danger-text">{d.mark_count}곳</dd></>}
                {d.lifecycle !== 'PUBLISHED' && <><dt>상태</dt><dd>게시 전 (내 문서)</dd></>}
              </dl>
              <p className="card-summary">{d.summary ?? '요약이 아직 없습니다.'}</p>
            </li>
          ))}
        </PaginatedList>
      )}
    </>
  );
}

/** 확인이 필요한 건의 세 칸: 원본 내용 · 근거 내용 · 근거를 바탕으로 한 수정 내용 (사용자 요청 11/17) */
function Trio({ m }: { m: Mark }) {
  // INSUFFICIENT: 근거 조문이 없으면 판단 불가, 있으면 그 조문만으로는 판단 부족 (AI팀 요청 11/20). BASIS_MISMATCH는 revision=null, 안내문은 fix (데이터 PR #103)
  const revision = m.revision ?? (m.kind === 'BASIS_MISMATCH' ? m.fix ?? '근거로 든 조항과 다른 내용으로 보입니다. 해당 부분을 다시 확인하세요.' : m.kind !== 'INSUFFICIENT' ? '수정 필요 없음' : m.basis ? '근거 조문만으로는 AI가 판단하지 못했습니다. 담당 부서에 확인해 주세요.' : '관련 조문이 없어 AI가 판단하지 못했습니다. 내용이 맞으면 그대로 두어도 됩니다.');
  return (
    <dl className="trio">
      <dt>원본 내용</dt><dd>{m.original ?? <span className="note">(올린 문서에 없음)</span>}</dd>
      <dt>근거 내용</dt>
      <dd>{m.basis ? <><cite>{m.basis.label}{m.basis.effective_from && ` · ${m.basis.effective_from} 시행`}</cite>{m.basis.text}</> : <span className="note">근거 조문 없음</span>}</dd>
      <dt>수정 내용</dt><dd className={m.revision ? 'rev' : 'note'}>{revision}</dd>
    </dl>
  );
}

function Fix({ m, n, on, onEdit, body, docId, locked }: { m: Mark; n?: number; on?: boolean; onEdit?: (text: string, to?: string) => void; body?: string; docId?: string; locked?: string }) {
  // 카드 안에서 바로 고친다 (사용자 요청 11/19: 업로드 뒤 질문 페이지처럼 [수정] → 입력칸). 문장이 본문에 그대로 있을 때만, 없으면 편집기로
  const inline = !!(onEdit && docId && m.original && body?.includes(m.original));
  // BASIS_MISMATCH의 revision은 안내문이지 고친 문장이 아니므로 [적용] 대상에서 뺀다 (데이터QA 11/20: 적용하면 본문이 안내문으로 바뀜)
  const ai = !!(m.revision && m.revision !== m.original && m.kind !== 'BASIS_MISMATCH');
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [why, setWhy] = useState('');
  async function save() {
    if (!draft?.trim() || !body || !m.original) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ doc_id: string }>('POST', `/v1/documents/${encodeURIComponent(docId!)}/edit`, { markdown: body.replace(m.original, draft.trim()) });
      location.href = `/review?id=${encodeURIComponent(r.doc_id)}`;
    } catch (e) { setErr((e as ApiError).message); setBusy(false); }
  }
  // 해당 없음: 본문은 그대로, 사유를 남기고 '참고'로 내린다 (질문 페이지의 해당 없음과 같은 자리)
  async function dismiss() {
    if (!why.trim()) { setErr('해당 없음 사유를 한 줄 적어 주세요.'); return; }
    setBusy(true); setErr('');
    try { await api('POST', `/v1/library/${encodeURIComponent(docId!)}/marks/dismiss`, { key: m.key, reason: why.trim() }); location.reload(); }
    catch (e) { setErr((e as ApiError).message); setBusy(false); }
  }
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
      {locked && m.original && <><p className="note">{locked}</p>{locked.startsWith('규정') && <div className="actions"><Link className="btn solid" href="/upload">공식 원본 다시 올리기</Link></div>}</>}
      {inline && draft === null && <div className="actions"><button type="button" className="btn solid" onClick={() => setDraft(m.original!)}>수정</button></div>}
      {inline && draft !== null && <div className="fix-edit">
        {ai ? <div className="clarify-sugg"><span className="src-badge">AI 추천</span><span>{m.revision}</span><button type="button" className={`btn${draft === m.revision ? ' solid' : ''}`} aria-pressed={draft === m.revision} onClick={() => setDraft(m.revision!)}>적용</button></div>
          : <p className="note">AI 추천 없음: {m.kind === 'BASIS_MISMATCH' ? '근거로 든 조항과 내용이 달라 AI가 고칠 문장을 만들지 않았습니다. 근거 조항을 확인해 직접 고치세요.' : '근거 조문을 찾지 못해 AI가 고칠 문장을 만들지 않았습니다. 직접 고치거나, 맞는 내용이면 해당 없음으로 두세요.'}</p>}
        <label className="lbl" htmlFor={`fix-in-${n ?? 'd'}`}>직접 입력</label>
        <textarea id={`fix-in-${n ?? 'd'}`} className="field" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
        {draft.trim() && draft.trim() !== m.original && <ol className="diff-lines" aria-label="고치기 전·후"><li className="del"><span className="num">전</span><del>{m.original}</del></li><li className="add"><span className="num">후</span><ins>{draft.trim()}</ins></li></ol>}
        <p className="note">저장하면 새 버전이 만들어지고 AI가 다시 검사합니다. 원래 문서는 승인될 때까지 그대로 보입니다.</p>
        <div className="actions"><button type="button" className="btn solid" disabled={busy || !draft.trim() || draft.trim() === m.original} onClick={save}>{busy ? '저장 중…' : '저장하고 검사받기'}</button><button type="button" className="btn" disabled={busy} onClick={() => { setDraft(null); setErr(''); }}>취소</button></div>
        {m.key && <details className="clarify-dismiss"><summary>해당 없음</summary>
          <div className="actions" style={{ marginTop: 4 }}>
            <input className="field" aria-label="해당 없음 사유" placeholder="사유 한 줄 (기록에 남습니다)" maxLength={200} value={why} onChange={(e) => setWhy(e.target.value)} />
            <button type="button" className="btn" disabled={busy} onClick={dismiss}>해당 없음으로 처리</button>
          </div>
        </details>}
        {err && <p className="danger-text" role="alert">{err}</p>}
      </div>}
      {onEdit && m.original && !inline && <div className="actions"><button type="button" className="btn" onClick={() => onEdit(m.original!)}>편집기에서 수정</button></div>}
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
        {items.map((x, xi) => {
          // clauses가 없거나 빈 배열(조문 번호 없는 법령 인용)이면 법령 단위 clause·result 1건으로 본다
          const cs = x.clauses?.length ? x.clauses : [{ clause: x.clause ?? '', result: x.result ?? null, error: x.error }];
          return (
            <li key={`${x.law_name}-${xi}`} className="fix">
              <p className="fix-head">「{x.law_name}」 {cs.some((c) => c.clause) ? `인용 조문 ${cs.length}곳` : '조문 번호 없이 인용'}</p>
              <ol className="law-clauses">{cs.map((c, n) => (
                <li key={c.clause + n}>
                  <p style={{ margin: 0 }}><strong>{c.clause || '법령 전체'}</strong>{c.sub?.length ? <span className="note"> ({c.sub.join('·')})</span> : null}{c.result?.effective_from && <span className="note"> · {c.result.effective_from} 시행본</span>}</p>
                  {c.error || !c.result ? <p className="note">원문 조회 실패. 잠시 뒤 다시 열어 보세요.</p> : (
                    <>
                      {c.result.clause?.text ? <blockquote className="basis"><p>{c.result.clause.text}</p></blockquote> : <p className="note">{c.clause ? '요청한 조문을 찾지 못했습니다.' : '본문이 조문을 특정하지 않았습니다. 원문 보기에서 확인하세요.'}</p>}
                      <p className="meta">출처 {c.result.source.replace(/\s*\(AgentCore Browser\)/, '')} · 조회 {new Date(c.result.fetched_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}{c.result.from_cache ? ' (1일 보관본)' : ''} · <a href={c.result.url} target="_blank" rel="noopener noreferrer">원문 보기</a></p>
                    </>
                  )}
                </li>
              ))}</ol>
            </li>
          );
        })}
      </ul>
      <p className="meta">공식 사이트 원문을 참고로 보여 줍니다. 공식 규정 등록·승인 전에는 검증 근거로 쓰지 않습니다.</p>
    </section>
  );
}

/** 별점 높은 순: 평균 → 평가 수 → 최신. 평가 없는 문서는 뒤로 (서버는 페이지 나눔 없이 전부 줌, 백엔드 11/23) */
const sorted = (l: LibraryCard[], sort: string) => sort !== 'rating' ? l : [...l].sort((a, b) =>
  (b.rating?.avg ?? -1) - (a.rating?.avg ?? -1) || (b.rating?.count ?? 0) - (a.rating?.count ?? 0) || b.updated_at.localeCompare(a.updated_at));

/** 결재함 숫자 카드 필터 (?only=). conflict는 문서 단위 근사(고칠 곳 있는 문서) — 주장 단위 목록은 없음 */
const ONLY: Record<string, { label: string; f: (d: LibraryCard) => boolean }> = {
  review: { label: '근거 개정으로 재검토 중인', f: (d) => d.freshness === 'REVIEW_REQUIRED' },
  unverified: { label: '근거 확인이 필요한', f: (d) => d.authority_status === 'UNVERIFIED' },
  conflict: { label: '고칠 곳(규정 충돌·개인정보 등)이 있는', f: (d) => d.mark_count > 0 },
};

const REVIEW_STATE: Record<string, string> = {
  BLOCKED: '보안 검사에서 자동 차단된 문서입니다. 결재할 필요는 없고, 올린 사람에게 고치는 방법이 안내되었습니다.',
  PENDING_APPROVAL: '게시 승인을 기다리는 문서입니다. 아래 이유를 확인한 뒤 맨 아래에서 승인하거나 반려하세요.',
  IN_REVIEW: '작성자 검토 중인 문서입니다.',
};

/** 쪽 밑줄(marks)이 있으면 review.findings는 근거 불일치만 따로 보인다 (밑줄로 안 그려짐, 총괄 11/20 MX-002) */
const reviewFindings = (d: LibraryDoc) => !d.review ? [] : d.pages.length ? d.review.findings.filter((f) => isCheck(f.code) || f.ack_reason) : d.review.findings;

/** 결재 대상: 맨 위에 '확인이 필요한 이유'. 누르면 그 쪽·밑줄로 이동 */
function Reasons({ d, jump, onInsert }: { d: LibraryDoc; jump: (page: number, n: number) => void; onInsert?: (s: RefSuggestion) => void }) {
  const r = d.review;
  const located = r ? d.pages.flatMap((pg, pi) => pg.marks.filter((m) => m.severity !== 'LOW').map((m, k) => ({ pi, n: k + 1, m }))) : [];
  const fs = r ? reviewFindings(d) : [];
  const total = located.length + (r ? d.doc_marks.length : 0) + fs.length;
  const refs = d.suggestions ?? []; // 참조 확인(웹 참고 주소): 게시는 막지 않는 참고 묶음 (사용자 요청 11/18)
  return (
    <section aria-labelledby="why-h" className="notice" style={{ display: 'block' }}>
      <h3 className="section" id="why-h" style={{ marginTop: 0 }}>확인이 필요한 이유 <span className="danger-text">{total}건</span>{refs.length > 0 && <span className="note"> · 참고 {refs.length}건</span>}</h3>
      {r && <p className="note">{d.authority_status === 'REJECTED' ? '승인자가 반려한 문서입니다. 작성자가 고쳐 다시 올리면 결재함에 다시 옵니다.' : r.source_mismatch ? '공식 원본과 내용이 다릅니다. 위조로 확정된 것은 아니며, 출처를 확인한 뒤 반려하거나 작성자에게 정정을 요청하세요.' : REVIEW_STATE[r.lifecycle] ?? ''}</p>} {/* 반려도 lifecycle은 BLOCKED (QA 11/20 MX-002) */}
      {total === 0 && <p className="note">{refs.length ? '게시를 막는 문제는 없습니다. 아래 참고를 확인하세요.' : '자동 검사에서 찾은 문제가 없습니다. 본문을 읽고 판단하세요.'}</p>}
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
        {fs.map((f, i) => (
          <li key={`f${i}`} className={`fix${f.severity === 'HIGH' ? ' sev-HIGH' : ''}`}>
            <p className="fix-head">{f.page ? `${f.page}쪽 · ` : ''}{f.severity === 'HIGH' ? '차단 사유' : isCheck(f.code) ? '근거 확인 필요' : '확인 필요'}</p>
            <p style={{ margin: 0 }}>{f.message}</p>
            {f.ack_reason && <p style={{ margin: 0 }}><strong>작성자 '그대로 사용' 사유</strong> {f.ack_reason}</p>}
            {f.fix_hint && <p style={{ margin: 0 }}><strong>{isCheck(f.code) ? '수정 제안' : '고치는 방법'}</strong> {isCheck(f.code) ? f.fix_hint.replace(/^확인 후 이렇게 고쳐 주세요:\s*/, '') : f.fix_hint}</p>}
          </li>
        ))}
      </ul>
      <RefSuggestions items={refs} onInsert={onInsert} heading={`참고 (게시는 막지 않음): 웹에서 찾은 참고 주소 ${refs.length}건`} />
    </section>
  );
}

/** 결재 대상 하단 결재 버튼. 출처 불일치는 반려만 */
function Decide({ r, docId, onDone }: { r: NonNullable<LibraryDoc['review']>; docId: string; onDone: (msg: string) => void }) {
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(false);
  const run = async (f: () => Promise<{ status?: string; msg: string } | undefined>) => { const x = await f(); if (!x) return; setMsg(x.msg); if (x.status) { setDone(true); onDone(x.msg); } };
  const [opinion, setOpinion] = useState('');
  if (!r.source_mismatch && !r.approval_id) return null;
  return (
    <section aria-labelledby="decide-h">
      <h3 className="section" id="decide-h">결재</h3>
      {!done && <>
        <label className="lbl" htmlFor="decide-op">{r.source_mismatch ? '반려 사유' : '결재 의견'}</label>
        {!r.source_mismatch && <div className="actions" style={{ marginTop: 4 }}>{APPROVE_CHIPS.map((c) => <button key={c} type="button" className={`btn chip-btn${opinion === c ? ' solid' : ''}`} onClick={() => setOpinion(c)}>{c}</button>)}</div>}
        <input id="decide-op" className="field" maxLength={300} value={opinion} placeholder={r.source_mismatch ? '예: 공식 원본과 승인 기준 금액이 다름' : '의견 직접 입력 (반려는 사유 필수)'} onChange={(e) => setOpinion(e.target.value)} />
        <div className="actions">
          {r.source_mismatch
            ? <button className="btn" onClick={() => run(() => rejectSource(docId, opinion))}>반려</button>
            : <>
                <button className="btn" onClick={() => run(() => decideApproval(r.approval_id!, 'REJECT', opinion))}>반려</button>
                <button className="btn solid" onClick={() => run(() => decideApproval(r.approval_id!, 'APPROVE', opinion))}>승인</button>
              </>}
        </div>
      </>}
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
// 위키에서 고친 문서: 수정본(글, .md) · 처음 올린 원본 파일 · 정리본 PDF 저장(인쇄) 세 가지 (사용자 요청 11/18: 원본 형식 그대로 고쳐 받기는 PDF 특성상 불가 → 정리본 PDF)
function Download({ id, edited, hasOriginal, onPrint }: { id: string; edited?: boolean; hasOriginal?: boolean; onPrint?: () => void }) {
  const [msg, setMsg] = useState('');
  async function go(kind?: 'original') {
    setMsg('');
    try {
      const r = await api<{ url: string; filename: string }>('GET', `/v1/library/${encodeURIComponent(id)}/download${kind ? '?kind=original' : ''}`);
      const a = document.createElement('a');
      a.href = r.url; a.rel = 'noopener'; a.download = r.filename;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { setMsg((e as ApiError).status === 404 ? '원본 파일이 없습니다. 검증 실패나 삭제로 지워진 문서입니다.' : (e as ApiError).message); }
  }
  if (!edited) return <><button type="button" className="btn" onClick={() => go()} title="처음 올린 파일 그대로 받기"><Icon name="download" />원본 다운로드</button>{msg && <p className="note" role="status">{msg}</p>}</>;
  return <>
    <button type="button" className="btn" onClick={() => go()} title="위키에서 고친 글(마크다운, 개인정보 가림)"><Icon name="download" />수정본 다운로드 (.md)</button>
    {hasOriginal && <button type="button" className="btn" onClick={() => go('original')} title="위키에서 고치기 전 처음 올린 파일">처음 올린 원본</button>}
    <button type="button" className="btn" onClick={() => (onPrint ? onPrint() : window.print())} title="정리본을 PDF 로 저장(인쇄 창에서 'PDF로 저장')">정리본 PDF 저장</button>
    {msg && <p className="note" role="status">{msg}</p>}
  </>;
}

/** 문서 상세 행동 막대 (사용자 11/23): 역할별 주 버튼 1개만 채움색, 나머지 테두리, 다운로드는 오른쪽 보조. 좁은 화면은 주 버튼 + [⋯] */
function DocActions({ d, canWikiEdit, onEdit, onPrint }: { d: LibraryDoc; canWikiEdit: boolean; onEdit: () => void; onPrint: () => void }) {
  const [more, setMore] = useState(false);
  const admin = isAdmin(getSession()?.groups);
  const owner = !!d.can_delete && !admin; // can_delete = 작성자 또는 결재자
  const prim = admin && d.freshness === 'REVIEW_REQUIRED' ? 'cr' : canWikiEdit ? (admin || owner ? 'wiki' : 'req') : null;
  const wiki = (solid: boolean) => <button type="button" className={`btn${solid ? ' solid' : ''}`} onClick={onEdit} title="새 버전 초안을 만들어 결재를 요청합니다"><Icon name="edit" />위키에서 고치기</button>;
  const main = prim === 'cr' ? <Link className="btn solid" href="/admin#cr-h" title="이 문서에 들어온 수정 요청을 결재함에서 확인합니다"><Icon name="approval" />수정 요청 보기</Link>
    : prim === 'wiki' ? wiki(true) : prim === 'req' ? <ChangeRequest id={d.doc_id} primary /> : null;
  return (
    <div className={`doc-actions no-print${more ? ' open' : ''}`} role="group" aria-label="문서 작업">
      {main}
      <div className="sec" id="doc-more">
        {canWikiEdit && prim !== 'wiki' && wiki(false)}
        {canWikiEdit && prim !== 'req' && <ChangeRequest id={d.doc_id} />}
        <span className="push" aria-hidden="true" />
        <Download id={d.doc_id} edited={d.edited} hasOriginal={d.has_original_upload} onPrint={onPrint} />
      </div>
      {main && <button type="button" className="btn more-btn" aria-expanded={more} aria-controls="doc-more" aria-label="작업 더보기" onClick={() => setMore((x) => !x)}><Icon name="more" /></button>}
    </div>
  );
}

/** 위키 수정 요청 (사용자 결정 11/18): 고칠 부분(본문에서 골라 붙여넣기) + 고칠 내용 → AI 판단과 초안을 붙여 관리자에게 */
function ChangeRequest({ id, primary }: { id: string; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const [before, setBefore] = useState(''); const [req, setReq] = useState('');
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
  const pick = () => { const t = window.getSelection()?.toString().trim(); if (t) setBefore(t.slice(0, 500)); setOpen(true); };
  async function send() {
    setBusy(true); setMsg('');
    try {
      const r = await api<{ verdict: string; after: string | null; ai_reason: string }>('POST', `/v1/documents/${encodeURIComponent(id)}/change-requests`, { before, request: req });
      setMsg(r.verdict === 'APPROPRIATE' ? `요청을 보냈습니다. AI가 적절하다고 보고 고친 문장을 만들었습니다: "${r.after}". 관리자가 확인하면 새 버전으로 반영됩니다.` : `요청을 보냈습니다. AI 의견: ${r.ai_reason} 관리자가 직접 판단합니다.`);
      setBefore(''); setReq('');
    } catch (e) { setMsg((e as ApiError).message); }
    setBusy(false);
  }
  if (!open) return <button type="button" className={`btn${primary ? ' solid' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={pick} title="작성자·결재자에게 고칠 점을 전달합니다 (본문에서 드래그해 고른 뒤 누르면 자동으로 채워짐)"><Icon name="message" />수정 요청</button>;
  return (
    <div className="change-req" role="group" aria-label="수정 요청">
      <label className="lbl" htmlFor="cr-before">고칠 부분 (본문에서 드래그해 고른 뒤 [수정 요청]을 누르면 채워집니다)</label>
      <textarea id="cr-before" className="field" rows={2} maxLength={500} value={before} onChange={(e) => setBefore(e.target.value)} />
      <label className="lbl" htmlFor="cr-req">어떻게 고쳐야 하나요</label>
      <textarea id="cr-req" className="field" rows={2} maxLength={500} value={req} onChange={(e) => setReq(e.target.value)} placeholder="예: 담당 부서가 IT인프라팀에서 디지털운영팀으로 바뀌었습니다" />
      <div className="actions"><button type="button" className="btn solid" disabled={busy || !before.trim() || !req.trim()} onClick={send}>{busy ? 'AI가 확인하는 중' : '요청하기'}</button><button type="button" className="btn" onClick={() => { setOpen(false); setMsg(''); }}>닫기</button></div>
      {msg && <p className="notice" role="status">{msg}</p>}
    </div>
  );
}

/** 평점 (P1 추천·평점): 사용자당 문서 1건, 다시 누르면 덮어쓴다. 평점은 인기일 뿐 검증 상태(인장)와 별개 */
function Rating({ id, mine, avg }: { id: string; mine?: number | null; avg?: { avg: number; count: number } }) {
  const [stars, setStars] = useState(mine ?? 0);
  const [msg, setMsg] = useState('');
  async function rate(n: number) {
    setStars(n); setMsg('');
    try { await api('POST', '/v1/feedback', { doc_id: id, stars: n, useful: n >= 4 }); setMsg(`${n}점으로 저장했습니다.`); }
    catch (e) { setStars(0); setMsg((e as ApiError).message); }
  }
  return (
    <section aria-labelledby="rate-h">
      <h3 className="section" id="rate-h">이 문서가 업무에 도움이 됐나요?</h3>
      <div className="view-toggle" style={{ flexWrap: 'wrap' }} role="group" aria-label="별점 주기">
        {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className="btn" aria-pressed={stars === n} aria-label={`${n}점`} onClick={() => rate(n)}>{'★'.repeat(n)}</button>)}
      </div>
      {avg && <p className="meta">지금 평균 <Popularity r={avg} />{mine ? ` · 내 별점 ${mine}점` : ''}</p>}
      <p className="note">평점은 다른 사람의 추천 참고용입니다. 규정 근거 확인 여부(검증 상태)와는 따로 판단합니다.</p>
      {msg && <p className="notice" role="status">{msg}</p>}
    </section>
  );
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
      {state === 'idle' && <><p className="note">검색·보관함·관계 그래프에서 빼고 파일을 모두 지웁니다. 결재·감사 기록은 남습니다.</p><div className="actions"><button className="btn danger" onClick={del}>문서 삭제</button></div></>}
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

/** 확인 필요 팝업 (사용자 요청 11/18): 질문마다 답 입력 → [적용] → AI 가 문장에 넣고 걸러서 → 위키 편집기에 넣어 연다(저장·검사는 사람이) */
function ClarifyApply({ d, canEdit, onApply }: { d: LibraryDoc; canEdit: boolean; onApply: (text: string, focus?: string) => void }) {
  const [ans, setAns] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const items = d.clarify ?? [];
  const filled = items.filter((c) => c.status === 'OPEN' && (ans[c.finding_id] ?? '').trim());
  async function apply() {
    setBusy(true); setMsg('');
    try {
      const r = await api<{ edits: { finding_id: string; before: string; after: string; ok: boolean; reason?: string }[] }>('POST', `/v1/documents/${encodeURIComponent(d.doc_id)}/clarify/compose`, { answers: filled.map((c) => ({ finding_id: c.finding_id, answer: ans[c.finding_id] })) });
      let text = d.pages.map((pg) => pg.structured ?? pg.text).join('\n\n'); const bad: string[] = []; let focus: string | undefined;
      for (const e of r.edits) {
        const at = text.indexOf(e.before);
        if (!e.ok || at < 0) { bad.push(`${items.find((c) => c.finding_id === e.finding_id)?.item ?? ''}: ${e.reason ?? '본문에서 문장을 찾지 못함'}`); continue; }
        text = text.slice(0, at) + e.after + text.slice(at + e.before.length); focus ??= e.after;
      }
      if (!focus) { setMsg(`넣을 수 있는 답이 없습니다. ${bad.join(' / ')}`); setBusy(false); return; }
      if (bad.length) window.setTimeout(() => window.alert(`넣지 못한 답: ${bad.join(' / ')}`), 0);
      onApply(text, focus);
    } catch (e) { setMsg((e as ApiError).message); }
    setBusy(false);
  }
  return <section className="clarify">
    <h3 className="section">확인 필요 (애매한 곳)</h3>
    <p className="note">질문마다 답을 적고 맨 아래 [적용]을 누르면, AI가 답을 문장에 맞게 넣어 위키 편집기를 엽니다. 편집기에서 바뀐 부분을 보고 '저장하고 검사 받기'를 누르면 반영됩니다. 담당자는 이름 대신 부서·직책으로 적습니다.</p>
    <ul className="fixes">{items.map((c) => (
      <li key={c.finding_id} className={`fix${c.status !== 'OPEN' ? ' done' : ''}`}>
        <p className="fix-head">{c.item}{c.page ? ` · ${c.page}쪽` : ''} · {c.status === 'OPEN' ? '처리 전' : c.status === 'DISMISSED' ? '해당 없음' : '반영함'}</p>
        <p><strong>{c.question}</strong></p>
        <div className="basis md"><DocText text={isRowText(c.before) ? rowAsTable(c.before, c.table_header) : c.before} /></div>
        {c.status === 'DISMISSED' && <p className="note">해당 없음 사유: {c.dismiss_reason}</p>}
        {c.status === 'OPEN' && canEdit && <>
          <label className="lbl" htmlFor={`ca-${c.finding_id}`}>답{c.suggestions[0] ? ` (제안: ${c.suggestions[0].value})` : ''}</label>
          <input id={`ca-${c.finding_id}`} className="field" maxLength={200} value={ans[c.finding_id] ?? ''} placeholder={c.kind === 'VAGUE_ACTOR' ? '예: 여신심사부 심사역' : '이 질문의 답'} onChange={(e) => setAns((x) => ({ ...x, [c.finding_id]: e.target.value }))} />
          {c.suggestions[0] && !ans[c.finding_id] && <button type="button" className="btn chip-btn" onClick={() => setAns((x) => ({ ...x, [c.finding_id]: c.suggestions[0]!.value }))}>제안 쓰기</button>}
        </>}
      </li>
    ))}</ul>
    {canEdit && <div className="actions"><button type="button" className="btn solid" disabled={busy || !filled.length} onClick={apply}>{busy ? 'AI가 넣는 중' : `적용 (${filled.length}건)`}</button></div>}
    {msg && <p className="error" role="alert">{msg}</p>}
  </section>;
}

function Detail({ id, from }: { id: string; from?: string | null }) {
  const [d, setD] = useState<LibraryDoc | null>(null);
  const [decided, setDecided] = useState(''); // 결재 직후 문서를 다시 불러와 단계 표시를 바꾼다 (엔드유저 11/20)
  const [err, setErr] = useState('');
  // ?page=N(1부터): 검색·가이드 썸네일에서 온 경우 그 쪽부터
  const [p, setP] = useState(() => (typeof window === 'undefined' ? 0 : Math.max(0, (Number(new URLSearchParams(window.location.search).get('page')) || 1) - 1)));
  const [active, setActive] = useState(0);
  const [zoomUrl, setZoomUrl] = useState<string | null>(null); // 정리본 인라인 그림 크게 보기
  // 정리본 PDF 저장: 정리본 전체(모든 쪽)만 인쇄용으로 그린 뒤 인쇄 창을 연다 (사용자 지적 11/18: 판단 필요·참고 카드까지 찍혔다). 훅은 이른 return 앞에 둔다
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => window.print(), 300); // 그림이 들어올 시간
    return () => { clearTimeout(t); window.removeEventListener('afterprint', done); };
  }, [printing]);
  const [images, setImages] = useState(false); // 필터링된 원문: 쪽 이미지(개인정보만 가림). 탭은 정리본·필터링된 원문 두 개 (사용자 결정 11/18)
  const [editing, setEditing] = useState<string | false>(false); // 위키 수정 (규칙 1). 문자열이면 그 본문으로 연다
  const [fixOpen, setFixOpen] = useState(false);
  const [reasonsOpen, setReasonsOpen] = useState(false);
  const [clarifyOpen, setClarifyOpen] = useState(false);
  const [editFocus, setEditFocus] = useState<string | undefined>(undefined); // 확인 필요 적용 뒤 편집기에서 처음 바뀐 줄
  // 정리본 비율: 원본 첫 쪽 이미지 비율로 16:9 · 4:3 · A4 (사용자 요청 11/18)
  const [ratio, setRatio] = useState<'r169' | 'r43' | 'a4'>('a4');
  useEffect(() => {
    api<{ items: { page: number; url: string }[] }>('GET', `/v1/library/${encodeURIComponent(id)}/pages`).then((r) => {
      const u = r.items[0]?.url; if (!u) return;
      const img = new Image(); img.onload = () => { const k = img.naturalWidth / Math.max(1, img.naturalHeight); setRatio(k >= 1.6 ? 'r169' : k >= 1.2 ? 'r43' : 'a4'); }; img.src = u;
    }).catch(() => {});
  }, [id]);
  useEffect(() => {
    api<LibraryDoc>('GET', `/v1/library/${encodeURIComponent(id)}`)
      .then((x) => {
        setD(x);
        markViewed(x.doc_id); // 상세를 열면 결재함 승인 잠금이 풀린다 (사용자 결정 11/18). 훅은 조기 반환 앞에만 둔다(11/18 dev 상세 화면 전체 오류)
        // 다른 유형의 비슷한 문서는 검색이 필요해 따로 불러와 붙인다
        api<{ items: LibraryDoc['related'] }>('GET', `/v1/library/${encodeURIComponent(id)}/similar`)
          .then((r) => setD((cur) => (cur ? { ...cur, related: [...cur.related, ...r.items.filter((s) => !cur.related.some((c) => c.doc_id === s.doc_id))] } : cur)))
          .catch(() => {});
      })
      .catch((e: ApiError) => setErr(e.status === 404 ? '문서를 찾을 수 없거나 볼 권한이 없습니다.' : e.message));
  }, [id, decided]);
  if (err) return <><p className="error" role="alert">{err}</p>{from === 'admin' ? <Link href="/admin">결재함으로 돌아가기</Link> : <Link href="/library">보관함으로 돌아가기</Link>}</>;
  if (!d) return <p className="note">불러오는 중입니다.</p>;
  const page = d.pages[p];
  // LOW(근거 확인됨·실무 보완)는 고칠 곳이 아니라 참고. 밑줄은 고칠 곳만 긋는다
  // 규칙 1: 게시된 노하우·매뉴얼은 누구나 위키에서 고친다 (규정은 개정 원본 업로드만)
  const figMap = Object.fromEntries((page?.figures ?? []).filter((f) => f.url).map((f) => [f.k, f.url!])) as Record<number, string>;
  // 정리본은 내용 단위 페이지(doc_pages)로 넘긴다 (사용자 요청 11/18). 원문 탭은 원본 쪽 단위
  const dps = d.doc_pages ?? [];
  const k = page ? dps.findIndex((g) => g.pages.includes(page.page)) : -1;
  const figOf = (n: number) => Object.fromEntries((d.pages.find((pg) => pg.page === n)?.figures ?? []).filter((f) => f.url).map((f) => [f.k, f.url!])) as Record<number, string>;
  const goDoc = (j: number) => { const n = dps[j]?.pages[0]; const i = d.pages.findIndex((pg) => pg.page === n); if (i >= 0) go(i); };
  // 쪽 번호는 원본 쪽 순서(1부터)로 보여 준다 (11/18 dev 시험: '원본 0쪽')
  const nth = (n: number) => d.pages.findIndex((pg) => pg.page === n) + 1;
  const range = (g: { pages: number[] }) => { const a = g.pages.map(nth).filter((x) => x > 0); return a.length > 1 ? `${Math.min(...a)}~${Math.max(...a)}` : `${a[0] ?? 1}`; };
  const showImages = images; // 정리본 탭은 늘 글: 정리본이 없는 쪽은 가린 본문 글자 (쪽 이미지로 바꾸지 않음, 사용자 지적 11/18)
  const reasonCount = (d.review ? d.pages.reduce((n, pg) => n + pg.marks.filter((m) => m.severity !== 'LOW').length, 0) + d.doc_marks.length + reviewFindings(d).length : 0) + (d.suggestions?.length ?? 0);
  const canWikiEdit = d.lifecycle === 'PUBLISHED' && d.freshness !== 'SUPERSEDED' && (d.document_type ?? 'KNOWHOW') !== 'REGULATION'; // 대체된 옛 판은 최신 버전에서 고친다
  const numbered = (page?.marks ?? []).filter((m) => m.severity !== 'LOW').map((m, i) => ({ m, n: i + 1 }));
  const notes = (page?.marks ?? []).filter((m) => m.severity === 'LOW');
  const go = (i: number) => { setP(i); setActive(0); };
  // 고칠 곳에서 바로 편집기로 (사용자 신고 11/19: 게시 문서의 고칠 곳에 고칠 길이 없음). 그 문장을 선택한 채 연다
  const body = d.pages.map((pg) => pg.structured ?? pg.text).join('\n\n');
  const editAt = canWikiEdit ? (text: string, to?: string) => { const ai = !!to && body.includes(text); setFixOpen(false); setEditFocus(ai ? to : text); setEditing(ai ? body.replace(text, to!) : ''); setTimeout(() => document.getElementById('wiki-editor')?.scrollIntoView({ block: 'start' }), 0); } : undefined;
  // 수정 버튼이 없는 이유를 카드에 적는다 (규정은 위키 수정 불가: 공식 원본 파일로만 바뀐다)
  const fixLocked = canWikiEdit ? undefined : d.freshness === 'SUPERSEDED' ? '새 버전으로 대체된 문서입니다. 최신 버전에서 고쳐 주세요.' : (d.document_type ?? 'KNOWHOW') === 'REGULATION' ? '규정은 이 화면에서 고칠 수 없습니다. 공식 원본 파일을 다시 올리면 AI가 공식 원본과 대조해 검증합니다.' : d.lifecycle !== 'PUBLISHED' ? '게시 전 문서는 검토 화면에서 고칩니다.' : undefined;
  const jump = (i: number, n: number) => { setImages(true); setReasonsOpen(false); setFixOpen(true); setP(i); setActive(n); setTimeout(() => document.getElementById(`mark-${n}`)?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }), 0); };
  // 문서 정보는 머리에서 빼 '한눈에 보기' 패널로 (Fable 재배치안 11/18: 머리는 제목·상태 문장·결재란만)
  const docMeta = (<dl className="meta-grid">
        {d.category_path && d.category_id && <><dt>분류</dt><dd><Link href={`/library?category=${encodeURIComponent(d.category_id)}`}>{d.category_path.split('/').join(' › ')}</Link></dd></>}
        {!d.category_path && d.business_path.length > 0 && <><dt>업무</dt><dd>{d.business_path.join(' › ')}</dd></>}
        {d.effective_from && <><dt>시행일</dt><dd><span className="num">{d.effective_from}</span></dd></>}
        {d.doc_dates?.length ? <><dt>문서 일자</dt><dd>{dateLine(d.doc_dates)} (본문 표기)</dd></> : d.doc_date && <><dt>문서 {d.doc_date.label}</dt><dd>{d.doc_date.date} (본문 표기)</dd></>}
        <dt>버전</dt><dd>v<span className="num">{d.version_no ?? 1}</span>{(d.version_count ?? 1) > 1 && <span className="note"> · 전체 {d.version_count}개 판</span>}</dd><dt>등록일</dt><dd><span className="num">{day(d.uploaded_at)}</span></dd>
        {d.updated_at.slice(0, 10) !== d.uploaded_at.slice(0, 10) && <><dt>최근 변경</dt><dd><span className="num">{day(d.updated_at)}</span></dd></>}
        {d.tags.length > 0 && <><dt>태그</dt><dd>{d.tags.join(', ')}</dd></>}

      </dl>);
  const back = from === 'admin' ? <Link className="btn" href="/admin">결재함으로 돌아가기</Link> : <Link className="btn" href="/library">보관함</Link>;
  return (
    <>
      <PageHeader title={d.title} description="본문과 근거를 확인하고 필요한 조치를 진행하세요." action={back} />
      <header className="document-header">
      <Seal size="full" i={{ authority_status: d.authority_status, document_type: d.document_type ?? 'KNOWHOW', lifecycle: d.lifecycle, freshness: d.freshness, mark_count: d.mark_count }}
        who={{ written_at: d.uploaded_at, checked_at: d.verification?.checks.checked_at ?? null, approver: d.verification?.approved_by ?? null, approved_at: d.verification?.approved_at ?? null }} />
      {d.lifecycle === 'PUBLISHED' && <p className="doc-rating">{d.rating?.count ? <span aria-label={`평균 ${d.rating.avg.toFixed(1)}점, ${d.rating.count}명 평가`}><span aria-hidden="true">★ <b className="num">{d.rating.avg.toFixed(1)}</b> ({d.rating.count}명 평가)</span></span>
        : <>아직 평가 없음 · <button type="button" className="linklike" onClick={() => [...document.querySelectorAll<HTMLButtonElement>('button.detail-card')].find((b) => b.textContent?.startsWith('평점'))?.click()}>평가하기</button></>}</p>}
      <Scheduled date={d.effective_from} /><FreshnessFlag freshness={d.freshness} reason={d.freshness_reason} /><Upcoming u={d.upcoming} /><p className="note">{d.freshness_reason && d.freshness === 'REVIEW_REQUIRED' ? '' : d.freshness !== 'CURRENT' ? '현행 근거와 최신 버전을 먼저 확인해 주세요.' : d.authority_status === 'VERIFIED' ? '시행일과 인용 근거를 확인한 뒤 업무에 참고해 주세요.' : '근거 검증이 완료되지 않았습니다. 확인할 내용과 출처를 먼저 살펴봐 주세요.'}</p>{d.summary && <p className="lead">{d.summary}</p>}<DocActions d={d} canWikiEdit={canWikiEdit} onEdit={() => setEditing('')} onPrint={() => setPrinting(true)} />{printing && <div className="print-only" aria-hidden="true"><h1>{d.title}</h1>{(dps.length ? dps.flatMap((x) => x.parts) : d.pages.map((pg) => ({ page: pg.page, markdown: pg.structured ?? pg.text }))).map((pt) => <DocText key={`pr-${pt.page}`} text={pt.markdown} figures={figOf(pt.page)} hideFigRefs />)}</div>}
      </header>
      {editing !== false && <WikiEditor docId={d.doc_id} base={d.pages.map((pg) => pg.structured ?? pg.text).join('\n\n')} initial={editing || d.pages.map((pg) => pg.structured ?? pg.text).join('\n\n')} focus={editFocus ?? (editing && editing.includes('\n- 참고 주소') ? editing.slice(editing.lastIndexOf('\n- 참고 주소') + 1) : undefined)} onCancel={() => { setEditing(false); setEditFocus(undefined); }} />}

      <div className="detail-layout"><div className="detail-body">

      {d.superseded_by && <p className="notice" role="status">새 버전이 게시되어 이 문서는 대체되었습니다. <Link href={`/library?id=${encodeURIComponent(d.superseded_by)}`}>최신 버전 보기</Link></p>}
      {d.lifecycle === 'PUBLISHED' && d.freshness === 'REVIEW_REQUIRED' && isAdmin(getSession()?.groups) && <ConfirmCurrent docId={d.doc_id} />}


      {!page ? <p className="note">표시할 본문이 없습니다. 개인정보를 가린 본문이 아직 만들어지지 않았습니다.</p> : (
        <section aria-label={`${p + 1}쪽`}>

          {parseDocText(page.text).some((b) => b.kind === 'clause') && <details className="clause-index"><summary>이 쪽 목차 · 조문 바로가기</summary><ul>{parseDocText(page.text).filter((b) => b.kind === 'clause').map((b) => <li key={b.start}><a href={`#clause-${b.start}`}>{page.text.slice(b.start, b.end).match(/^제\s*\d+\s*(?:조(?:의\d+)?(?:\([^)]*\))?|장.*|절.*)/)?.[0] ?? page.text.slice(b.start, Math.min(b.end, b.start + 80))}</a></li>)}</ul></details>}
          <div className="view-toggle seg-tabs" role="group" aria-label="본문 보기 방식">
            <button type="button" className="btn" aria-pressed={showImages} onClick={() => setImages(true)}>필터링된 원문</button>
            <button type="button" className="btn" aria-pressed={!showImages} onClick={() => setImages(false)}>정리본</button>
          </div>
          {showImages ? <div className="document-columns"><div><OriginalPages docId={d.doc_id} start={p + 1} fallback={page.text} /></div><aside className="page-checks" aria-label="한눈에 보기"><h3 className="section">한눈에 보기</h3>{docMeta}</aside></div> : (
          <div className="document-columns"><div><div className={`sheet page ${ratio}`} onClick={(e) => {
            const t = e.target as HTMLElement;
            const z = t.closest<HTMLElement>('[data-zoom]')?.dataset.zoom;
            if (z) { setZoomUrl(z); return; }
          }}>
            <div className="page-body">
            <p className="note">{page.structured_source === 'VISION'
              ? 'AI 정리(그림 기준): AI가 이 쪽 이미지를 보고 정리한 본문입니다. 근거로 인용하지 않으며, 원래 모습은 \'필터링된 원문\'에서 확인하세요.'
              : page.structured_source === 'AI' ? 'AI가 이 쪽 글자와 그림 설명을 함께 읽고 정리한 본문입니다. 그림을 보고 쓴 설명은 근거로 인용하지 않습니다. 그림을 누르면 크게 봅니다.'
              : '이 쪽은 원문 글자를 그대로 보여 줍니다(쪽마다 반복되는 머리글은 뺐습니다).'}</p>
            {k >= 0 ? dps[k]!.parts.map((pt) => <DocText key={pt.page} text={pt.markdown} figures={figOf(pt.page)} hideFigRefs />) : <DocText text={page.structured ?? page.text} figures={figMap} hideFigRefs />}
            <ZoomDialog url={zoomUrl} onClose={() => setZoomUrl(null)} />
            </div>
          </div>
          {/* 정리본 아래 가운데 화살표로 넘기기 (사용자 요청 11/18). 글자는 화면 읽기·QA 용 */}
          {(() => { const n = k >= 0 ? dps.length : d.pages.length; const cur = k >= 0 ? k : p; const to = (j: number) => (k >= 0 ? goDoc(j) : go(j)); return (
            <nav className="arrow-pager" aria-label="정리본 쪽 넘기기">
              <button type="button" className="arrow-btn prev" disabled={cur === 0} onClick={() => to(cur - 1)}><Icon name="arrow" /><span className="sr-only">이전 쪽</span></button>
              <span aria-live="polite"><span className="num">{cur + 1} / {n}</span>{k >= 0 && <span className="note"> · 원본 {range(dps[k]!)}쪽</span>}</span>
              <button type="button" className="arrow-btn" disabled={cur === n - 1} onClick={() => to(cur + 1)}><Icon name="arrow" /><span className="sr-only">다음 쪽</span></button>
            </nav>); })()}
          </div>
          <aside className="page-checks" aria-label="한눈에 보기"><h3 className="section">한눈에 보기</h3>{docMeta}<h4 className="aside-sub">이 쪽</h4>
            <dl className="meta-grid"><dt>현재 쪽</dt><dd>{p + 1} / {d.pages.length}</dd><dt>고칠 곳</dt><dd>{numbered.length}곳</dd><dt>참고</dt><dd>{notes.length}건</dd>{reviewFindings(d).length > 0 && <><dt>확인 필요</dt><dd className="danger-text">{reviewFindings(d).length}건</dd></>}</dl>
          </aside>          </div>
          )}
        </section>
      )}

      </div><div className="document-more">
      <CardBoundary label="상세 항목">
      <div className="detail-cards" aria-label="문서 상세 항목">
      <p className="cards-head judge">판단 필요</p>
      {(numbered.length > 0 || d.doc_marks.length > 0) && <button type="button" className="detail-card judge filled" aria-haspopup="dialog" onClick={() => setFixOpen(true)}><CardLabel title="고칠 곳" filled warn count={d.pages.reduce((n, pg) => n + pg.marks.filter((m) => m.severity !== 'LOW').length, 0) + d.doc_marks.length} /></button>}
      <DetailPopup title="고칠 곳" open={fixOpen} onClose={() => setFixOpen(false)}><h3 className="section">{p + 1}쪽 고칠 곳</h3><ul className="fixes">{numbered.map(({ m, n }) => <Fix key={n} m={m} n={n} on={active === n} onEdit={editAt} body={body} docId={d.doc_id} locked={fixLocked} />)}</ul>{d.doc_marks.length > 0 && <><h3 className="section" id="doc-marks">본문에서 위치를 찾지 못한 항목</h3><ul className="fixes">{d.doc_marks.map((m, i) => <Fix key={i} m={m} onEdit={editAt} body={body} docId={d.doc_id} locked={fixLocked} />)}</ul></>}</DetailPopup>
      {(d.review || (d.suggestions?.length ?? 0) > 0) && <><button type="button" className="detail-card judge filled" aria-haspopup="dialog" onClick={() => setReasonsOpen(true)}><CardLabel title="확인이 필요한 이유" filled warn count={reasonCount} /></button><DetailPopup title="확인이 필요한 이유" open={reasonsOpen} onClose={() => setReasonsOpen(false)}><Reasons d={d} jump={jump}
        onInsert={canWikiEdit ? (sg) => { setReasonsOpen(false); setEditing(withReference(d.pages.map((pg) => pg.structured ?? pg.text).join('\n\n'), sg)); } : undefined} /></DetailPopup></>}
      {d.verification && d.verification.basis.length > 0 && (
        <DetailCard title="비교한 대상" group="judge" count={groupBasis(d.verification.basis).length}>
          {d.verification.basis.length > 0 && (
            <>
              <p className="note" style={{ margin: '10px 0 4px' }}>이 문서의 문장을 어느 조문과 비교했고 결과가 어땠는지입니다. 같은 조문은 한 번만 보여 줍니다.</p>
              <ul className="fixes">
                {groupBasis(d.verification.basis).map((g) => (
                  <li key={g.key} className="fix">
                    <p className="fix-head">{g.what} · {g.label}{g.effective_from && ` · ${g.effective_from} 시행`}</p>
                    {g.quote && <blockquote className="basis"><p>{g.quote}</p></blockquote>}
                    {g.rows.some((r) => r.statement) ? (
                      <ol className="compare-rows">{g.rows.map((r, i) => (
                        <li key={i}>
                          <p className="stmt">“{r.statement}”</p>
                          <p><span className={`verdict ${r.relation === 'CONFLICTS' ? 'bad' : r.relation === 'INSUFFICIENT' ? 'wait' : 'ok'}`}>{r.result}</span>{r.reason && <span className="note"> — {r.reason}</span>}</p>
                        </li>
                      ))}</ol>
                    ) : <p>{g.rows.map((r) => r.result).join(' · ')}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </DetailCard>
      )}
      {(d.clarify?.length ?? 0) > 0 && <>
        <button type="button" className="detail-card judge filled" aria-haspopup="dialog" onClick={() => setClarifyOpen(true)}><CardLabel title="확인 필요" filled warn count={d.clarify!.filter((c) => c.status === 'OPEN').length} /></button>
        <DetailPopup title="확인 필요" open={clarifyOpen} onClose={() => setClarifyOpen(false)}>
          <ClarifyApply d={d} canEdit={canWikiEdit} onApply={(text, focus) => { setClarifyOpen(false); setEditing(text); setEditFocus(focus); }} />
        </DetailPopup>
      </>}
      <p className="cards-head ref">참고</p>
      {page && <DetailCard title="페이지 요약" filled={!!page.summary}><h3 className="section">페이지 요약</h3><p>{page.summary ?? '요약이 아직 없습니다.'}</p><PageFacts m={page} /></DetailCard>}
      {notes.length > 0 && <DetailCard title="확인된 근거·실무 보완" count={notes.length}><h3 className="section">참고: 확인된 근거·실무 보완</h3><ul className="fixes">{notes.map((m, i) => <Fix key={i} m={m} />)}</ul></DetailCard>}
      <Versions id={d.doc_id} />      {d.verification && (
        <DetailCard title="검증 정보"><section aria-labelledby="verify-h">
          <h3 className="section" id="verify-h">검증 정보</h3>
          <dl className="meta-grid">
            <dt>검증한 사람</dt><dd>{d.authority_status === 'REJECTED' ? '반려됨' : d.verification.approved_by ?? '아직 승인 전'}</dd>
            <dt>검증 시각</dt><dd>{d.verification.approved_at ? new Date(d.verification.approved_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-'}</dd>
            {d.verification.approval_reason && <><dt>승인 의견</dt><dd>{d.verification.approval_reason}</dd></>}
            <dt>검증 방법</dt><dd>{d.verification.method}</dd>
          </dl>
        </section></DetailCard>
      )}
      {(d.claims?.length ?? 0) > 0 && (
        <DetailCard title="이 문서의 주장" count={d.claims!.length}>
          <p className="note">이 문서의 문장마다 근거 조문과 판정, 그리고 같은 조문을 근거로 쓴 다른 게시 문서들이 어떻게 판정됐는지입니다.</p>
          <ol className="claims">{d.claims!.map((c) => (
            <li key={c.claim_id}>
              <p className="stmt">“{c.statement}”{c.page && <span className="note"> · {c.page}쪽</span>}</p>
              <p><span className={`verdict ${c.relation === 'CONFLICTS' ? 'bad' : c.relation === 'INSUFFICIENT' ? 'wait' : 'ok'}`}>{CLAIM_REL[c.relation] ?? c.relation}</span>
                {c.label && <span className="note"> · {c.label}</span>}{!c.verified && <span className="note"> · 인용 원문 확인 안 됨</span>}{c.status === 'REVIEW_REQUIRED' && <span className="danger-text"> · 근거 조문 개정으로 재검토</span>}</p>
              {c.on_provision && (c.on_provision.supports + c.on_provision.conflicts + c.on_provision.unclear) > 0 && (
                <p className="note">이 조문을 근거로 쓴 게시 문서 주장: 지지 {c.on_provision.supports} · 충돌 {c.on_provision.conflicts}{c.on_provision.unclear ? ` · 확인 필요 ${c.on_provision.unclear}` : ''}</p>
              )}
            </li>
          ))}</ol>
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
      {d.lifecycle === 'PUBLISHED' && <DetailCard title="평점"><Rating id={d.doc_id} mine={d.my_stars} avg={d.rating} /></DetailCard>}
      <DetailCard title="외부 법령 참고" filled={false} lazy><ExternalLaws id={d.doc_id} /></DetailCard>
      </div></CardBoundary>{decided ? <p className="notice" role="status">{decided}</p> : d.review && <Decide r={d.review} docId={d.doc_id} onDone={setDecided} />}

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

