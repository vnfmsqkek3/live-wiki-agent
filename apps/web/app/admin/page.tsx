'use client';
import { PaginatedList } from '../paginated-list';
import { PageHeader } from '../page-header';
// 06 관리: 결재란으로 진행 단계 표시. 불일치는 AI가 위조로 단정하지 않고 출처 검토를 요청한다.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, getSession, type CrRevision, type DocChange, type FreshnessReason, type LibraryCard, type Role, viewedDocs, markViewed as markViewedDoc } from '../lib/api';
import { APPROVE_CHIPS, decideApproval, rejectSource } from '../lib/decide';
import { accountLabel } from '../lib/roles';
import { readable } from '../lib/readable';
import { Icon } from '../icons';
import { FreshnessFlag, Scheduled, Seal, todayKst } from '../seal';

interface Item { approval_id: string; doc_id: string; own?: boolean; title?: string; detail?: string; stage?: number; lifecycle?: string; workflow_failure?: { step: string; error: string }; version?: { version_no?: number; previous_title: string; changes_count: number; changes?: DocChange[] }; summary_line?: string | null; source?: string; kept?: { text: string; reason: string; system: boolean }[]; checks_count?: number; checks?: { code: string; text: string; message: string }[]; effective_from?: string | null; freshness?: LibraryCard['freshness']; freshness_reason?: FreshnessReason | null }
interface Mismatch { doc_id: string; title: string; dept: string; kind: 'SOURCE_MISMATCH' | 'BLOCKED'; findings: { message: string; user_message?: string; evidence_ref: string }[] }
/** 결재함 → 문서 상세 (무엇이 왜 문제인지 쪽·밑줄로). 돌아오면 결재함 */
const detail = (doc_id: string) => `/library?id=${encodeURIComponent(doc_id)}&from=admin`;

/** 지식 부채 (게시 문서 주장 기준, interfaces 10.2): 지금 손봐야 할 지식이 얼마나 쌓였나 */
function KnowledgeDebt() {
  const [k, setK] = useState<Record<string, number> | null>(null);
  useEffect(() => { api<Record<string, number>>('GET', '/v1/admin/knowledge-debt').then(setK).catch(() => setK(null)); }, []);
  if (!k) return null;
  const rows: [string, string, string][] = [['conflicts', '규정과 어긋난 주장', 'bad'], ['review_required', '근거 개정으로 재검토', 'bad'], ['unverified', '근거 확인 필요', 'wait'], ['healthy', '근거 확인된 주장', 'ok'], ['docs_needing_attention', '손봐야 할 문서', 'bad']];
  return (
    <section aria-labelledby="debt-h" className="debt">
      <h2 className="section" id="debt-h">지식 상태</h2>
      <dl className="debt-grid">{rows.map(([key, label, tone]) => <div key={key} className={`debt-cell ${tone}`}><dt>{label}</dt><dd className="num">{k[key] ?? 0}</dd></div>)}</dl>
    </section>
  );
}

/** 결재 진행: 공통 결재란. 승인하면 승인 칸에 도장이 찍힌다(한 번의 서명 동작) */
function ApprovalBox({ approved }: { stage?: number; approved?: boolean }) {
  return <Seal size="full" stampedNow={!!approved} i={{ authority_status: approved ? 'VERIFIED' : 'UNVERIFIED', document_type: 'KNOWHOW', lifecycle: approved ? 'PUBLISHED' : 'PENDING_APPROVAL' }} />;
}

/** 게시 요청 전 (사용자 결정 11/18 권고 ①): 작성자가 검토 중인 문서. 게시 요청을 눌러야 위 '게시 승인 대기'로 온다 */
/** 위키 수정 요청 (사용자 결정 11/18): AI 판단·초안을 보고 [초안으로 새 버전 만들기] 한 번 → 새 버전 검토 화면(AI 검사 → 본인 결재) 또는 반려 */
type CR = { id: string; doc_id: string; title: string; before: string; request: string; verdict: 'APPROPRIATE' | 'INAPPROPRIATE' | 'UNKNOWN'; after?: string | null; ai_reason?: string; at: string; source?: string; law?: string; path?: string; revision?: CrRevision };
/** IMPACT 수정 요청의 개정 시행일·현행 값 (총괄 11/23: 시행 예정 개정을 '현행과 다른 틀린 제안'으로 오해) */
function Revision({ r }: { r: CrRevision }) {
  const soon = r.effective_from! > todayKst();
  return <p className="notice" style={{ display: 'block' }}>
    <strong>{r.effective_from} 시행{soon ? ' 예정' : ''} 개정 반영 초안</strong>{r.label && <> · {r.law_name} {r.label}</>}
    {r.old_text && <><br />현행{r.current_effective_from ? `(${r.current_effective_from}판)` : ''}은 「{r.old_text}」{r.new_text && <>, 개정 후 「{r.new_text}」</>}</>}
    {soon && <><br />시행일 전입니다. 반영은 시행일 이후에 하세요 (그 전까지는 현행 조문이 맞습니다).</>}
  </p>;
}
function ChangeRequests() {
  const [items, setItems] = useState<CR[] | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({}); const [why, setWhy] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [manual, setManual] = useState<Record<string, boolean>>({}); // 반영 409: 본문에서 문장을 못 찾음 → 위키에서 직접 고치기
  useEffect(() => { api<{ items: CR[] }>('GET', '/v1/admin/change-requests').then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  async function decide(i: CR, decision: 'APPLY' | 'REJECT') {
    setMsg('');
    try {
      const r = await api<{ new_doc_id: string | null }>('POST', `/v1/admin/change-requests/${encodeURIComponent(i.doc_id)}/${encodeURIComponent(i.id)}`, { decision, reason: why[i.id] ?? '', after: edit[i.id] ?? i.after ?? '' });
      if (r.new_doc_id) { location.href = `/review?id=${encodeURIComponent(r.new_doc_id)}`; return; }
      setItems((x) => x && x.filter((y) => y.id !== i.id));
    } catch (e) { const x = e as ApiError; if (decision === 'APPLY' && x.status === 409) setManual((m) => ({ ...m, [i.id]: true })); else setMsg(x.message); }
  }
  if (!items?.length) return null;
  const V = { APPROPRIATE: 'AI: 적절', INAPPROPRIATE: 'AI: 부적절', UNKNOWN: 'AI: 판단 못함' } as const;
  return (
    <section aria-labelledby="cr-h" className="fix-list">
      <h2 className="section" id="cr-h">위키 수정 요청 <b className="num">{items.length}건</b></h2>
      <p className="note">읽는 사람이 낸 수정 요청입니다. 반영하면 고친 새 버전이 만들어지고 AI 검사를 거쳐 결재로 게시됩니다.</p>
      <ol className="fixes">{items.map((i) => (
        <li key={i.id} className="fix">
          <p className="fix-head"><Link href={`/library?id=${encodeURIComponent(i.doc_id)}&from=admin`} prefetch={false}>{i.title}</Link> · <span className={`kind-tag${i.verdict === 'APPROPRIATE' ? '' : ' own'}`}>{V[i.verdict]}</span>{i.source === 'IMPACT' && <span className="kind-tag">규정 개정 영향{i.law ? ` · ${i.law}` : ''}</span>}</p>
          {i.revision?.effective_from && <Revision r={i.revision} />}
          <blockquote className="basis"><p>{i.before}</p></blockquote>
          {i.request && <p><strong>요청:</strong> {readable(i.request)}</p>}
          {!i.after && i.source === 'IMPACT' && <p className="danger-text">AI 초안 없음: 바꿀 문장을 직접 쓰거나 문서에서 직접 고치세요.</p>}
          {i.ai_reason && <p className="note">AI 의견: {readable(i.ai_reason)}</p>}
          <label className="lbl" htmlFor={`cr-a-${i.id}`}>바꿀 문장{i.after ? ' (AI 초안, 고쳐도 됩니다)' : ''}</label>
          <textarea id={`cr-a-${i.id}`} className="field" rows={2} value={edit[i.id] ?? i.after ?? ''} onChange={(e) => setEdit((x) => ({ ...x, [i.id]: e.target.value }))} />
          <input className="field" aria-label="의견(반려 시 필수)" placeholder="의견 한 줄 (반려할 때는 필수)" maxLength={200} value={why[i.id] ?? ''} onChange={(e) => setWhy((x) => ({ ...x, [i.id]: e.target.value }))} />
          <div className="actions"><button type="button" className="btn solid" disabled={!(edit[i.id] ?? i.after ?? '').trim()} onClick={() => decide(i, 'APPLY')}>초안으로 새 버전 만들기</button><button type="button" className="btn" onClick={() => decide(i, 'REJECT')}>반려</button></div>
          {manual[i.id] && <p className="error" role="alert">본문에서 이 문장을 찾지 못해 초안으로 반영할 수 없습니다. <Link href={`/library?id=${encodeURIComponent(i.doc_id)}&from=admin`} prefetch={false}>문서를 열어 [위키에서 고치기]로 직접 고쳐 주세요.</Link></p>}
        </li>
      ))}</ol>
      {msg && <p className="error" role="alert">{msg}</p>}
    </section>
  );
}

function InReview() {
  const [items, setItems] = useState<{ doc_id: string; title: string; lifecycle: string; own: boolean; open: number; source_mismatch?: boolean }[] | null>(null);
  useEffect(() => { api<{ items: NonNullable<typeof items> }>('GET', '/v1/admin/in-review').then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  if (!items?.length) return null;
  return (
    <details className="admin-more" open={items.some((i) => i.own)}>
      <summary>게시 요청 전(작성자 검토 중) <b className="num">{items.length}</b>건 — 작성자가 '게시 요청'을 눌러야 결재할 수 있습니다</summary>
      <ul className="todo-list">{items.map((i) => (
        <li key={i.doc_id}>
          <Link href={i.own ? `/review?id=${encodeURIComponent(i.doc_id)}` : `/library?id=${encodeURIComponent(i.doc_id)}&from=admin`} prefetch={false}>{i.title}</Link>
          {i.own && <span className="kind-tag own">본인 문서</span>}
          <span className="note">{i.lifecycle === 'QUARANTINED' ? 'AI 검사 중' : i.lifecycle === 'BLOCKED' ? '차단됨 (게시 불가)' : i.source_mismatch ? '출처 확인 대기 (게시 요청 불가)' : i.open ? `남은 일 ${i.open}건` : '게시 요청만 남음'}</span>
          {i.own && i.lifecycle === 'IN_REVIEW' && <Link className="btn" href={`/review?id=${encodeURIComponent(i.doc_id)}`} prefetch={false}>검토 화면에서 게시 요청</Link>}
        </li>
      ))}</ul>
    </details>
  );
}

export default function Admin() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [mismatch, setMismatch] = useState<Mismatch[]>([]);
  const [done, setDone] = useState<Record<string, 'APPROVED' | 'REJECTED'>>({});
  // 결재자가 문서를 열어 봤는지: 열어 보기 전에는 승인 잠금 (사용자 결정 11/18)
  const [viewed, setViewed] = useState<Record<string, boolean>>({});
  useEffect(() => setViewed(viewedDocs()), []);
  const markViewed = (id: string) => { markViewedDoc(id); setViewed(viewedDocs()); };
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [role, setRole] = useState('');
  const [after, setAfter] = useState<Item[]>([]);
  useEffect(() => {
    setRole(accountLabel(getSession()?.groups as Role[] | undefined));
    // 승인 뒤 아직 게시되지 않은 문서 (게시 중이거나 실패). 실패면 단계·사유를 보여 준다
    Promise.all(['APPROVED', 'USED'].map((st) => api<{ items: Item[] }>('GET', `/v1/approvals?status=${st}`).then((r) => r.items).catch(() => [] as Item[])))
      .then((x) => setAfter(x.flat().filter((i) => i.lifecycle && i.lifecycle !== 'PUBLISHED' && i.lifecycle !== 'DELETED')));
    api<{ items: Item[] }>('GET', '/v1/approvals?status=PENDING').then((r) => setItems(r.items))
      .catch((e: ApiError) => { setErr(e.status === 403 ? '승인 대기 목록은 관리자만 볼 수 있습니다.' : e.message); setItems([]); });
    api<{ items: Mismatch[] }>('GET', '/v1/review-queue').then((r) => setMismatch(r.items)).catch(() => setMismatch([]));
  }, []);

  async function onRejectSource(docId: string) {
    const r = await rejectSource(docId, opinion[docId] ?? '');
    if (!r) return;
    if (r.status) setDone((d) => ({ ...d, [docId]: r.status! }));
    setMsg(r.msg);
  }

  const [opinion, setOpinion] = useState<Record<string, string>>({}); // 카드별 결재 의견
  async function decide(id: string, decision: 'APPROVE' | 'REJECT' | 'REVALIDATE') {
    const r = await decideApproval(id, decision, opinion[id] ?? '');
    if (!r) return;
    if (r.status) setDone((d) => ({ ...d, [id]: r.status! }));
    setMsg(r.msg);
  }

  const pending = items ?? [];
  const source = mismatch.filter((m) => m.kind !== 'BLOCKED');
  const blocked = mismatch.filter((m) => m.kind === 'BLOCKED');
  return (
    <>
      <PageHeader title="결재함" description="출처 확인이 필요한 문서를 먼저 확인하고, 근거를 읽은 뒤 결재하세요." action={<Link className="btn" href="/library">문서보관함</Link>} />
      {role && <p className="meta" style={{ marginTop: -10 }}>{role} 계정으로 보고 있습니다</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {/* 할 일 숫자와 지식 상태를 첫 화면에 함께 (Fable A안 11/18: 카드가 쌓이면 맨 아래 지식 상태가 안 보임) */}
      <div className="admin-status">
        <div className="counts">
          <a href="#pending-h"><strong>{items ? pending.length : '–'}</strong><span className="meta">게시 승인 대기</span></a>
          <a href="#source-h"><strong>{items ? source.filter((m) => !done[m.doc_id]).length : '–'}</strong><span className="meta">출처 확인 필요</span></a>
        </div>
        <KnowledgeDebt />
      </div>

      {/* 운영 도구를 위로 (Fable 재배치안 11/18: 규정 변경 영향은 포지셔닝 둘째 축) */}
      <div className="actions ops-row" role="group" aria-label="운영 도구">
        <Link className="btn" href="/admin/impact"><Icon name="library" />규정 변경 영향</Link>
        <Link className="btn" href="/admin/runs"><Icon name="clock" />Agent 실행 기록</Link>
        <Link className="btn" href="/admin/evals"><Icon name="clock" />Agent 평가</Link>
      </div>
      {/* 카테고리별 가로 카드와 독립 페이지네이션 */}
      <div className="approval-categories">
        <div className="approval-category-group" aria-label="결재할 일">
          {source.length > 0 && <h2 className="section" id="source-h">출처 확인이 먼저 필요한 문서</h2>}
          <PaginatedList label="출처 확인 필요" pageKey="source_page" pageSize={3} className="ledger card-grid admin-grid">
            {source.map((i) => (
              <li className="entry" key={i.doc_id} style={{ paddingRight: 16 }}>
                <span className="flag"><Icon name="alert" />출처 확인 필요</span>
                <h3 className="doc-title"><Link href={detail(i.doc_id)}>{i.title}</Link></h3>
                {i.findings.map((f, n) => <p key={n} className="quote">{f.message}</p>)}
                <p className="note">공식 원본과 내용이 다릅니다. 위조로 확정된 것은 아니며, 출처가 확인될 때까지 게시 요청이 막혀 있습니다. '다른 곳 보기'에서 어느 쪽 어느 조문이 다른지 볼 수 있습니다.</p>
                {done[i.doc_id] ? <p className="meta">반려 처리됨</p> : <><input className="field" aria-label="반려 사유" maxLength={300} placeholder="반려 사유 (예: 공식 원본과 승인 기준 금액이 다름)" value={opinion[i.doc_id] ?? ''} onChange={(e) => setOpinion((x) => ({ ...x, [i.doc_id]: e.target.value }))} /><div className="actions"><Link className="btn" href={detail(i.doc_id)}><Icon name="library" />다른 곳 보기</Link><button className="btn" onClick={() => onRejectSource(i.doc_id)}>반려</button></div></>}
              </li>
            ))}
          </PaginatedList>

          <h2 className="section" id="pending-h">게시 승인 대기</h2>
          {items && pending.length === 0 && <p className="note">결재할 문서가 없습니다.</p>}
          <PaginatedList label="게시 승인 대기" pageKey="pending_page" pageSize={3} className="ledger card-grid admin-grid">
            {pending.map((i) => (
              <li className="entry" key={i.approval_id} style={{ paddingRight: 16 }}>
                {/* 규칙 3: 한 줄 요약 + 바뀐 부분 + 승인·반려. 나머지는 '자세히' (AI 검사를 통과한 것만 여기 온다) */}
                <span className="kind-tag">{i.source === 'WIKI_EDIT' ? '위키 수정' : i.version ? '새 버전' : '새 문서'} · {i.kept?.length ? `승인자 판단 ${i.kept.length}건` : i.checks_count ? `확인 필요 ${i.checks_count}건` : 'AI 검사 통과'}</span>
                {i.own && <span className="kind-tag own" title="관리자 본인이 올린 문서입니다. 승인하면 자기 승인으로 기록됩니다.">본인 문서</span>}
                <h3 className="doc-title"><Link href={detail(i.doc_id)} onClick={() => markViewed(i.doc_id)}>{i.title ?? '제목 없는 문서'}</Link><Scheduled date={i.effective_from} /></h3>
                {i.freshness && <FreshnessFlag freshness={i.freshness} reason={i.freshness_reason} max={1} />}
                {i.summary_line && <p className="lead-line">{i.summary_line}</p>}
                {i.checks?.length ? <div className="kept-conflicts"><p className="danger-text"><strong>근거 확인이 필요한 문장 {i.checks_count ?? i.checks.length}건 — 승인자 확인</strong></p><ul>{i.checks.map((c, n) => <li key={n}>{c.text}<span className="note"> — {c.message}</span></li>)}</ul></div> : null}
                {i.kept?.length ? <div className="kept-conflicts"><p className="danger-text"><strong>규정과 어긋난 문장 {i.kept.length}건 — 승인자 판단</strong></p><ul>{i.kept.map((k, n) => <li key={n}>{k.text}<span className="note"> — {k.system ? '재검사에서 새로 나옴(고치지 않은 문장)' : `올린 사람: 그대로 사용(${k.reason})`}</span></li>)}</ul></div> : null}
                {i.version?.changes?.length ? (
                  <ul className="mini-changes" aria-label="바뀐 부분">{i.version.changes.slice(0, 3).map((c, n) => (
                    <li key={n}>{c.kind !== 'ADDED' && <del>{c.old_text.slice(0, 90)}</del>}{c.kind !== 'REMOVED' && <ins>{c.new_text.slice(0, 90)}</ins>}</li>
                  ))}{i.version.changes_count > 3 && <li className="note">외 {i.version.changes_count - 3}곳</li>}</ul>
                ) : !i.version && <p className="note">처음 올라온 문서입니다.</p>}
                <ApprovalBox stage={done[i.approval_id] === 'APPROVED' ? 3 : (i.stage ?? 2)} approved={done[i.approval_id] === 'APPROVED'} />
                {!done[i.approval_id] && (
                  <div className="actions">
                    <div className="opinion">
                      <label className="lbl" htmlFor={`op-${i.approval_id}`}>결재 의견</label>
                      <div className="actions" style={{ marginTop: 4 }}>{APPROVE_CHIPS.map((c) => <button key={c} type="button" className={`btn chip-btn${opinion[i.approval_id] === c ? ' solid' : ''}`} onClick={() => setOpinion((x) => ({ ...x, [i.approval_id]: c }))}>{c}</button>)}</div>
                      <input id={`op-${i.approval_id}`} className="field" maxLength={300} placeholder="의견 직접 입력 (반려는 사유 필수)" value={opinion[i.approval_id] ?? ''} onChange={(e) => setOpinion((x) => ({ ...x, [i.approval_id]: e.target.value }))} />
                    </div>
                    {/* 사람이 확인 → 판단 순서: 문서 확인을 먼저, 같은 크기의 버튼으로 (사용자 지적 11/18: 밑줄 글자라 안 보임) */}
                    <Link className="btn" href={detail(i.doc_id)} onClick={() => markViewed(i.doc_id)}><Icon name="library" />{viewed[i.doc_id] ? '확인함 · 다시 보기' : '문서 확인'}</Link>
                    <span className="actions-gap" aria-hidden="true" />
                    <button className="btn" onClick={() => decide(i.approval_id, 'REJECT')}>반려</button>
                    <button className="btn" onClick={() => decide(i.approval_id, 'REVALIDATE')} title="게시하지 않고 문서를 작성자 검토 단계로 돌려보냅니다 (의견 필수)">재검증 요청</button>
                    {/* 열어 보기 전 승인 잠금 (사용자 결정 11/18). 반려는 열지 않아도 가능 */}
                    <button className={`btn${viewed[i.doc_id] ? ' solid' : ''}`} onClick={() => decide(i.approval_id, 'APPROVE')} disabled={!viewed[i.doc_id]} aria-describedby={viewed[i.doc_id] ? undefined : `lock-${i.approval_id}`}>승인</button>
                    {!viewed[i.doc_id] && <p className="note lock-hint" id={`lock-${i.approval_id}`}>문서를 열어 확인한 뒤 승인할 수 있습니다.</p>}
                  </div>
                )}
              </li>
            ))}
          </PaginatedList>
          <p aria-live="polite" className="note" style={{ marginTop: 12 }}>{msg}</p>
        </div>
        <div className="approval-category-group" aria-label="진행·참고">
          <ChangeRequests />
          <InReview />
          <details className="admin-more" open={after.some((x) => !!x.workflow_failure)}>
            <summary>진행·참고: 승인 뒤 게시 진행 <b className="num">{after.length}</b>건{blocked.length ? <> · 자동 차단 <b className="num">{blocked.length}</b>건(최근 7일)</> : null}</summary>
          <h2 className="section">승인 뒤 게시 진행</h2>
          {after.length === 0 ? <p className="note">승인한 뒤 아직 게시되지 않은 문서가 없습니다.</p> : (
            <PaginatedList label="승인 뒤 게시 진행" pageKey="after_page" pageSize={3} className="ledger admin-rows">
              {after.map((i) => (
                <li className="entry" key={i.approval_id} style={{ paddingRight: 16 }}>
                  <span className="kind-tag"><Icon name="clock" />게시 진행</span>
                  <h3 className="doc-title">{i.title ?? '제목 없는 문서'}</h3>
                  {i.workflow_failure
                    ? <p className="error">게시 처리에 실패했습니다. 운영 담당자 확인이 필요합니다. 승인은 그대로 유지됩니다.</p>
                    : <p className="note">게시 중입니다. 색인이 끝나면 검색과 보관함에 나타납니다(보통 수 분).</p>}
                </li>
              ))}
            </PaginatedList>
          )}
          {blocked.length > 0 && (
            <>
              <h2 className="section">보안 검사에서 자동 차단된 문서 <span className="note">최근 7일</span></h2>
              <p className="note">결재할 필요는 없습니다. 올린 사람에게 고치는 방법이 안내되었고, 원본 파일은 삭제되었습니다.</p>
              <PaginatedList label="자동 차단" pageKey="blocked_page" pageSize={3} className="ledger admin-rows">
                {blocked.map((i) => (
                  <li className="entry" key={i.doc_id} style={{ paddingRight: 16 }}>
                    <span className="flag"><Icon name="alert" />자동 차단</span>
                <h3 className="doc-title"><Link href={detail(i.doc_id)}>{i.title}</Link></h3>
                    {i.findings.slice(0, 3).map((f, n) => <p key={n} className="quote">{f.user_message ?? f.message}</p>)}
                  </li>
                ))}
              </PaginatedList>
            </>
          )}
          </details>
        </div>
      </div>

    </>
  );
}
