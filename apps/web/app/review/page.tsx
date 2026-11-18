'use client';
import { DocText } from '../doc-text';
import { PageHeader } from '../page-header';
import { ClarifyList } from '../clarify';
import { ReviewItems } from '../review-items';
// 05 OCR·PII 검토: 작성자가 자동 분석 결과를 확인·수정하고 게시를 요청한다.
import { Icon } from '../icons';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError, dateLine, getSession, type Finding, type Fix, type Review } from '../lib/api';
import { can } from '../lib/roles';
import { WikiEditor } from '../wiki-editor';
import { RefSuggestions, withReference } from '../ref-suggestions';
import { IssueList, PageFacts, VersionLink } from '../issues';
const VERDICT: Record<string, [string, string]> = {
  SUPPORTED: ['근거 규정과 맞습니다', 'var(--verified)'],
  CONFLICT: ['규정과 충돌하는 내용이 있습니다', 'var(--danger)'],
  OUTDATED: ['개정 전 규정을 근거로 하고 있습니다', 'var(--ochre)'],
  INSUFFICIENT: ['근거 규정을 확인하지 못했습니다', 'var(--ink-2)'],
};
const REL: Record<string, string> = { SUPPORTS: '근거 확인됨', SUPPLEMENTS: '실무 보완(규정 범위 안)', CONFLICTS: '규정과 어긋남', UNRELATED: '관련 없음', INSUFFICIENT: '관련 조문 확인 필요' };
const TYPES = [['REGULATION', '규정'], ['KNOWHOW', '노하우'], ['MANUAL', '매뉴얼']] as const;
const GROUPS: [string, string, (f: Finding) => boolean][] = [
  ['개인정보', '마스킹한 구간입니다. 불확실한 구간은 원문과 대조해 확인하세요.', (f) => f.step === 'PII_SCAN'],
  ['보안 검사', '파일 구조와 문서 안 지시문을 검사한 결과입니다.', (f) => ['FILE_STRUCTURE', 'INJECTION_SCAN', 'TYPE_DETECTION', 'MALWARE'].includes(f.step)],
  ['문자 인식', '인식 신뢰도가 낮은 페이지는 원문과 비교해 주세요.', (f) => f.step === 'OCR'],
  ['출처 확인', '공식 원본과의 대조 결과입니다.', (f) => f.step === 'TRUST_GATE'],
  // KNOWHOW_VALIDATION Finding은 위 '노하우 검증' 구역에서 근거와 함께 보여준다
];

function ReviewView() {
  const id = useSearchParams().get('id') ?? '';
  const [r, setR] = useState<Review | null>(null);
  const [err, setErr] = useState('');
  const [type, setType] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [editInit, setEditInit] = useState<string | null>(null); // 고치기 편집기 (AI 제안 적용본)
  const [pct, setPct] = useState<number | null>(null);
  const [fixState, setFixState] = useState<Record<string, string>>({}); // 제안대로 고치기 결과 (사용자 지적 11/18: 눌렀는지 알 수 없었다)
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [cur, setCur] = useState<string | null>(null); // 편집기의 지금 글
  const [editFocus, setEditFocus] = useState<string | undefined>(); // 편집기에서 바로 보여 줄 문장
  const isAdmin = can(getSession()?.groups, '/admin'); // 관리자는 고칠 것에서 편집기로 바로 (사용자 요청 11/18) // 규정 충돌 '그대로 사용' 사유

  useEffect(() => {
    if (!id) { setErr('검토할 문서를 찾을 수 없습니다. 문서 등록 화면에서 다시 시작하세요.'); return; }
    api<Review>('GET', `/v1/documents/${encodeURIComponent(id)}/review`)
      .then((x) => {
        setR(x); setType(x.classification?.document_type ?? '');
        // 검사 중이면 진행률을 보다가 끝나면 다시 읽는다 (규칙 2: AI 가 검사한다)
        // 새로고침(location.reload) 대신 검토 정보를 다시 읽는다: 진행률이 '끝남'이어도 문서가 아직 검사 중이면
        // 새로고침이 무한 반복돼 요청이 폭증했다(11/18 dev: WAF 차단·빈 화면). 바뀐 게 없으면 간격을 2.5→10초로 늘린다
        if (x.lifecycle === 'QUARANTINED' && !x.workflow_failure) { // 멈춘 실행은 기다리지 않는다
          let wait = 2500, last = -1, n = 0;
          const tick = () => api<{ total: number; done: number; finished: boolean; halted: boolean }>('GET', `/v1/documents/${encodeURIComponent(id)}/progress`)
            .then(async (p) => {
              setPct(p.total ? Math.round((p.done / p.total) * 100) : 0);
              if (p.finished || p.halted) {
                const y = await api<Review>('GET', `/v1/documents/${encodeURIComponent(id)}/review`);
                if (y.lifecycle !== 'QUARANTINED') { setR(y); setType(y.classification?.document_type ?? ''); return; }
              }
              wait = p.done === last ? Math.min(10_000, wait * 1.5) : 2500; last = p.done;
              if (++n < 240) setTimeout(tick, wait);
            })
            .catch(() => setTimeout(tick, 8000));
          tick();
        }
      })
      .catch((e: ApiError) => setErr(e.status === 404 ? '이 문서를 볼 권한이 없거나 문서가 없습니다.' : e.message));
  }, [id]);

  if (err) return <p className="error" role="alert">{err}</p>;
  if (!r) return <p className="note">분석 결과를 불러오는 중입니다.</p>;

  const changed = type && type !== r.classification?.document_type;
  const blocked = r.trust_gate_result === 'QUARANTINED' || r.lifecycle === 'BLOCKED';
  const uncertain = r.findings.filter((f) => f.severity !== 'LOW').length;
  const clarifyOpen = (r.clarify ?? []).filter((c) => c.blocking && c.status === 'OPEN');
  const reviewOpen = (r.reviews ?? []).filter((x) => !x.acknowledged);
  const fixOpen = (r.fixes ?? []).filter((f) => !f.acknowledged);
  const open = [...fixOpen, ...clarifyOpen, ...reviewOpen]; // 게시 요청 잠금 = 고칠 것 + 확인 필요(잠금 항목)
  // 규정은 위키에서 고칠 수 없다(사용자 결정 11/17) → 고치기·반영 버튼을 보이지 않는다 (11/18 dev 시험)
  const canFix = r.lifecycle === 'IN_REVIEW' && r.text !== undefined && (r.classification?.document_type ?? '') !== 'REGULATION';
  /** AI 수정 제안 적용: 그 문장을 제안 문장으로 바꾼 본문으로 편집기를 연다 */
  // 편집기가 열려 있으면 그 글 위에 이어서 적용한다(전에는 원문에서 다시 시작해 앞서 누른 제안이 사라졌다). 결과를 항목에 표시
  const applyFix = (f: Fix) => {
    const base = (editInit !== null ? cur ?? editInit : null) ?? r.text!;
    if (!f.suggestion) { setEditInit(base); setFixState((x) => ({ ...x, [f.finding_id]: '편집기에서 직접 고쳐 주세요' })); return; }
    if (base.includes(f.excerpt)) { setEditInit(base.replace(f.excerpt, f.suggestion)); setFixState((x) => ({ ...x, [f.finding_id]: '편집기에 반영함 — 아래 [저장하고 검사받기]를 눌러야 적용됩니다' })); }
    else if (base.includes(f.suggestion)) setFixState((x) => ({ ...x, [f.finding_id]: '이미 제안대로 고쳐져 있습니다 — 저장하면 다시 검사합니다. 그래도 남으면 [그대로 사용]에 사유를 적어 주세요' }));
    else { setEditInit(base); setFixState((x) => ({ ...x, [f.finding_id]: '본문에서 이 문장을 찾지 못했습니다 — 편집기에서 직접 고치거나 [그대로 사용]에 사유를 적어 주세요' })); }
    setTimeout(() => document.getElementById('wiki-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  async function keepConflict(f: Fix) {
    const reason = (keep[f.finding_id] ?? '').trim();
    if (!reason) { setMsg('그대로 사용하는 사유를 한 줄 적어 주세요.'); return; }
    try { await api('POST', `/v1/documents/${encodeURIComponent(id)}/findings/${encodeURIComponent(f.finding_id)}/ack`, { reason }); setR((x) => x && { ...x, fixes: x.fixes!.map((y) => (y.finding_id === f.finding_id ? { ...y, acknowledged: true, ack_reason: reason } : y)) }); setMsg(''); }
    catch (e) { setMsg((e as ApiError).message); }
  }
  async function ack(f: Fix) {
    try { await api('POST', `/v1/documents/${encodeURIComponent(id)}/findings/${encodeURIComponent(f.finding_id)}/ack`); setR((x) => x && { ...x, fixes: x.fixes!.map((y) => (y.finding_id === f.finding_id ? { ...y, acknowledged: true } : y)) }); }
    catch (e) { setMsg((e as ApiError).message); }
  }

  async function saveType() {
    try {
      await api('POST', `/v1/documents/${encodeURIComponent(id)}/classification`, { document_type: type, reason });
      setR((x) => x && { ...x, classification: { ...x.classification!, document_type: type as 'KNOWHOW', source: 'HUMAN', confidence: 1 } });
      setReason(''); setMsg('문서 종류를 바꿨습니다. 수정 이력이 함께 저장됩니다.');
    } catch (e) { setMsg((e as ApiError).message); }
  }
  async function saveTitle() {
    if (!editTitle?.trim()) return;
    try {
      const x = await api<{ title: string }>('POST', `/v1/documents/${encodeURIComponent(id)}/title`, { title: editTitle.trim() });
      setR((v) => v && { ...v, title: x.title, title_source: 'USER' }); setEditTitle(null); setMsg('제목을 바꿨습니다. 수정 이력이 함께 저장됩니다.');
    } catch (e) { setMsg((e as ApiError).message); }
  }
  async function submit() {
    try {
      await api('POST', `/v1/documents/${encodeURIComponent(id)}/submit`); setSubmitted(true);
      // 결재 권한이 있으면 바로 결재함으로 (사용자 지적 11/18). 아니면 안내만
      if (can(getSession()?.groups, '/admin')) { setMsg('게시를 요청했습니다. 결재함으로 이동합니다.'); setTimeout(() => { location.href = '/admin'; }, 800); }
      else setMsg('게시를 요청했습니다. 규정 승인자가 결재하면 검색에 나타납니다.');
    }
    catch (e) { setMsg((e as ApiError).message || '지금 상태에서는 게시를 요청할 수 없습니다.'); }
  }

  return (
    <>
      <PageHeader title={r.title ?? '문서 검토'} description="분석 결과를 확인하고 문서 종류와 제목을 정리하세요." action={<a className="btn" href={`/library?id=${encodeURIComponent(id)}`}>문서 보기</a>} />

      {/* 주 행동을 위로 고정 (Fable 11/18): 단계 → 고칠 것 N건 → 게시 요청 */}
      <div className="submit-bar" role="region" aria-label="게시 요청">
        <ol className="steps-line" aria-label="진행 단계">
          <li className="done">올리기</li>
          <li className={blocked ? 'bad' : r.lifecycle === 'QUARANTINED' ? 'now' : 'done'}>AI 검사{blocked && ' · 차단'}</li>
          <li className={blocked || r.lifecycle === 'QUARANTINED' ? '' : r.lifecycle === 'IN_REVIEW' && !submitted ? 'now' : 'done'}>고칠 것·확인{open.length > 0 && <b className="num"> {open.length}</b>}</li>
          <li className={submitted || r.lifecycle === 'PENDING_APPROVAL' ? 'now' : ''}>게시 요청</li>
        </ol>
        <button className="btn solid" onClick={submit} disabled={blocked || submitted || r.lifecycle !== 'IN_REVIEW' || open.length > 0}>{open.length ? `남은 일 ${open.length}건` : '검토 마치고 게시 요청'}</button>
        <p aria-live="polite" className="note submit-msg">{msg}</p>
        {/* 왜 게시 요청이 안 되는지 바로 보이게 (사용자 지적 11/18: 다 고쳤다고 생각했는데 막힘) */}
        {r.lifecycle === 'IN_REVIEW' && open.length > 0 && <ul className="note blockers" aria-label="게시 요청을 막는 항목">
          {fixOpen.map((f) => <li key={f.finding_id}><a href={`#fx-${f.finding_id}`}>고칠 것: {f.excerpt.slice(0, 40)}…</a></li>)}
          {clarifyOpen.map((c) => <li key={c.finding_id}>확인 필요: {c.question.slice(0, 40)}…</li>)}
          {reviewOpen.map((x) => <li key={x.finding_id}>개인정보 확인: {x.message.slice(0, 40)}…</li>)}
        </ul>}
      </div>
      <div className="layout-a review-layout"><div className="primary">
      {/* 위키 수정본: 직전 버전과 바뀐 부분 (사용자 요청 11/18) */}
      {r.version && <section className="edit-diff" aria-labelledby="rv-diff-h">
        <h2 className="section" id="rv-diff-h">v{r.version.previous.version_no}에서 바뀐 부분 <b className="num">{r.version.count}곳</b></h2>
        {r.version.changes.length > 0 && <ol className="diff-lines">{r.version.changes.slice(0, 30).map((c, n) => (
          <li key={n} className={c.kind === 'ADDED' ? 'add' : c.kind === 'REMOVED' ? 'del' : 'chg'}><span className="num">{c.new_page ?? c.old_page ?? ''}</span><span>{c.kind !== 'ADDED' && <del>{c.old_text}</del>}{c.kind === 'CHANGED' && ' → '}{c.kind !== 'REMOVED' && <ins>{c.new_text}</ins>}</span></li>
        ))}{r.version.count > 30 && <li className="note">외 {r.version.count - 30}곳</li>}</ol>}
      </section>}
      {r.workflow_failure && <p className="error" role="alert">자동 분석 단계에서 처리가 멈췄습니다. 아래 '확인할 내용'에 사유와 고치는 방법이 있습니다.</p>}
      {blocked && <p className="error">보안 검사에서 차단되어 게시할 수 없습니다. 아래 '확인할 내용'에 쪽·사유가 있습니다.</p>}
      {r.workflow_failure && r.can_edit && <div className="actions"><button type="button" className="btn solid" onClick={async () => { try { await api('POST', `/v1/documents/${encodeURIComponent(id)}/analyze`); setMsg('다시 분석을 시작했습니다. 잠시 뒤 화면이 바뀝니다.'); setTimeout(() => location.reload(), 4000); } catch (e) { setMsg((e as ApiError).message); } }}>다시 분석하기</button></div>}
      {r.lifecycle === 'QUARANTINED' && !r.workflow_failure && <p className="notice" role="status">AI가 검사하고 있습니다{pct !== null ? ` (${pct}%)` : ''}. 끝나면 고칠 것이 이 화면에 나옵니다.</p>}
      {editInit !== null && <WikiEditor docId={r.doc_id} initial={editInit} base={r.text} focus={editFocus} onText={setCur} onCancel={() => { setEditInit(null); setCur(null); setFixState({}); }} note="저장하면 이 문서를 고친 내용으로 AI가 다시 검사합니다." />}
      {r.lifecycle === 'IN_REVIEW' && <ReviewItems docId={r.doc_id} items={r.reviews ?? []} canFix={canFix} onEdit={() => setEditInit(r.text!)}
        onAcked={(ids, reason) => setR((x) => x && { ...x, reviews: x.reviews!.map((y) => (ids.includes(y.finding_id) ? { ...y, acknowledged: true, reason } : y)) })} />}
      {r.lifecycle === 'IN_REVIEW' && <ClarifyList items={r.clarify ?? []} docId={r.doc_id} text={r.text} canFix={canFix}
        onDismissed={(fid, reason) => setR((x) => x && { ...x, clarify: x.clarify!.map((c) => (c.finding_id === fid ? { ...c, status: 'DISMISSED', dismiss_reason: reason, blocking: false } : c)) })} />}
      {r.lifecycle === 'IN_REVIEW' && (
        <section aria-labelledby="fix-h" className="fix-list">
          {/* 다른 할 일(확인 필요·개인정보 확인)이 있으면 '고칠 것이 없습니다'를 크게 쓰지 않는다 (11/18 dev 시험) */}
          {fixOpen.length || !((r.clarify ?? []).length || (r.reviews ?? []).length) ? <h2 className="section" id="fix-h">{fixOpen.length ? `고칠 것 ${fixOpen.length}건` : '고칠 것이 없습니다'}</h2> : <p className="note" id="fix-h">규정과 어긋난 문장은 없습니다.</p>}
          {/* 확인할 내용이 남아 있으면 '검토할 게 없다'로 읽히지 않게 (11/18 사용자 보고) */}
          {/* 확인할 내용(게시를 막지 않음)은 여기서 바로 무엇인지·할 일을 보여 준다 (사용자 지적 11/18: 자세히에서 입력칸을 찾았다) */}
          {!open.length && uncertain > 0 && <div className="notice"><p style={{ margin: 0 }}>규정과 어긋난 문장은 없습니다. 아래 <strong>참고 {uncertain}건</strong>은 게시 요청을 막지 않으며, 입력할 것은 없습니다. 승인자에게 함께 보입니다.</p>
            <ul>{r.findings.filter((f) => f.severity !== 'LOW').map((f) => <li key={f.finding_id}>{f.user_message ?? f.message}{f.fix_hint ? <span className="note"> — {f.fix_hint}</span> : null}</li>)}</ul></div>}
          {!open.length && uncertain === 0 && <p className="note">AI 검사를 통과했습니다. 게시를 요청하면 승인자가 확인합니다.</p>}
          <ol className="fixes">{(r.fixes ?? []).map((f) => (
            <li key={f.finding_id} id={`fx-${f.finding_id}`} className={`fix${f.acknowledged ? ' done' : ''}`}>
              <p className="fix-head">{f.code === 'KNOWHOW_CONFLICT' ? '규정과 어긋난 문장' : '수정에서 지운 중요 문장'}{f.acknowledged && (f.code === 'KNOWHOW_CONFLICT' ? ` · 그대로 사용(${f.ack_reason ?? ''}) — 승인자가 판단` : ' · 의도한 삭제로 확인함')}</p>
              <p>{f.message}</p>
              {f.excerpt && <blockquote className="basis"><p>{f.excerpt}</p></blockquote>}
              {f.suggestion && <p><strong>AI 수정 제안:</strong> {f.suggestion}</p>}
              {!f.acknowledged && canFix && <div className="actions">
                {f.code === 'KNOWHOW_CONFLICT' && <button type="button" className="btn solid" onClick={() => applyFix(f)}>{f.suggestion ? '제안대로 고치기' : '직접 고치기'}</button>}
                {f.code === 'KNOWHOW_CONFLICT' && isAdmin && <button type="button" className="btn" onClick={() => { setEditFocus(f.excerpt); setEditInit((editInit !== null ? cur ?? editInit : null) ?? r.text!); setTimeout(() => document.getElementById('wiki-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }}>편집기로 바로가기</button>}
                {f.code === 'KNOWHOW_CONFLICT' && <details className="clarify-dismiss"><summary>그대로 사용</summary>
                  <div className="actions" style={{ marginTop: 4 }}>
                    <input className="field" aria-label="그대로 사용 사유" placeholder="사유 한 줄 (승인자에게 보입니다)" maxLength={200} value={keep[f.finding_id] ?? ''} onChange={(e) => setKeep((t) => ({ ...t, [f.finding_id]: e.target.value }))} />
                    <button type="button" className="btn" onClick={() => keepConflict(f)}>그대로 사용으로 처리</button>
                  </div></details>}
                {f.code === 'EDIT_REMOVED_KEY_SENTENCE' && <><button type="button" className="btn solid" onClick={() => setEditInit(r.text!)}>되돌려 고치기</button><button type="button" className="btn" onClick={() => ack(f)}>의도한 삭제</button></>}
              </div>}
              {fixState[f.finding_id] && !f.acknowledged && <p className="notice" role="status">{fixState[f.finding_id]}</p>}
            </li>
          ))}</ol>
          {canFix && !open.length && <div className="actions"><button type="button" className="btn" onClick={() => setEditInit(r.text!)}>본문 더 고치기</button></div>}
        </section>
      )}
      <RefSuggestions items={r.suggestions ?? []} onInsert={canFix ? (sg) => setEditInit(withReference(r.text!, sg)) : undefined} />
      <details className="more"><summary>자세히: 검사별 결과</summary>
      <IssueList docId={r.doc_id} />
      <VersionLink docId={r.doc_id} canEdit={!!r.can_edit} />
      {!blocked && r.trust_gate_result === 'REVIEW_REQUIRED' && <p className="mock">확인이 필요한 항목이 {uncertain}건 있습니다. 아래 내용을 확인한 뒤 게시를 요청하세요.</p>}


      {r.knowhow_validation && (() => {
        const k = r.knowhow_validation;
        const [title, color] = VERDICT[k.verdict]!;
        return (
          <section aria-labelledby="kh">
            <h2 className="section" id="kh">노하우 검증</h2>
            <p className="notice" style={{ color }}>{title}. AI가 비교한 결과이며, 게시 여부는 규정 승인자가 결정합니다.</p>
            {k.outdated.map((o) => <p key={o.cited} className="flag" style={{ display: 'block', marginBottom: 8 }}>개정 전 조문을 인용했습니다. 현행 {o.label} 기준으로 다시 확인하세요.</p>)}
            <ul className="ledger">
              {k.items.filter((j) => j.relation !== 'UNRELATED').map((j, i) => (
                <li key={i} className="entry" style={{ paddingRight: 16 }}>
                  <p style={{ margin: 0 }}><strong>{REL[j.relation]}</strong>{j.relation === 'CONFLICTS' && (() => { const fx = (r.fixes ?? []).find((y) => y.excerpt && (j.statement.includes(y.excerpt.slice(0, 40)) || y.excerpt.includes(j.statement.slice(0, 40)))); return <span className="note"> · {!fx ? '처리 상태 확인 필요' : fx.acknowledged ? `그대로 사용(${fx.ack_reason ?? ''}) — 승인자 판단` : '고칠 것에 남아 있음'}</span>; })()}<br />노하우: “{j.statement}”</p>
                  {j.verified_quote && <p className="quote" style={{ margin: '6px 0' }}>{j.label}: {j.quote}</p>}
                  <p className="note" style={{ margin: 0 }}>{j.reason}</p>
                </li>
              ))}
            </ul>
          </section>
        );
      })()}

      {GROUPS.map(([name, help, pick]) => {
        const fs = r.findings.filter(pick);
        if (!fs.length) return null;
        return (
          <section key={name}>
            <h2 className="section">{name}</h2>
            <p className="note">{help}</p>
            <ul className="ledger">
              {fs.map((f) => (
                <li key={f.finding_id} className="entry" style={{ paddingRight: 16 }}>
                  {f.message}<div className="meta">{f.evidence_ref.replace('page:', '')}쪽</div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {!!r.page_summaries?.length && (
        <section aria-labelledby="ps">
          <h2 className="section" id="ps">쪽별 요약</h2>
          <p className="note">마스킹된 본문만 AI가 읽고 요약했습니다. 원문과 다르면 검토 의견에 적어 주세요.</p>
          <ol className="ledger">
            {r.page_summaries.map((p) => (
              <li key={p.page_index} className="entry" style={{ paddingRight: 16 }}>
                <p style={{ margin: 0 }}><strong>{p.page_index + 1}쪽</strong> {p.summary}</p>
                <PageFacts m={p} />
              </li>
            ))}
          </ol>
        </section>
      )}

      {r.masked_preview && (
        <>
          <h2 className="section">마스킹 후 미리보기</h2>
          <p className="note">검색과 AI에는 이 내용만 전달됩니다. 이미지 속 개인정보도 같은 위치를 가린 뒤 다시 인식해 확인합니다.</p>
          <div className="sheet"><DocText text={r.masked_preview} /></div>
        </>
      )}

      </details>
      </div><aside className="support-panel">      <div className="review-summary" role="status"><Icon name={blocked ? 'alert' : 'approval'} /><div><strong>{submitted ? '게시 승인 대기' : blocked ? '게시 불가 · 수정 필요' : '작성자 검토 필요'}</strong><p>{submitted ? '승인자가 결재하면 게시됩니다.' : blocked ? '아래 검사 사유를 확인하고 파일을 수정해 주세요.' : '개인정보 가림과 근거를 확인한 뒤 게시를 요청해 주세요.'}</p></div></div>
      {editTitle === null ? (
        <>
          <h2 className="section">문서 제목</h2><p>{r.title}</p>
          <p className="meta" style={{ marginTop: 0 }}>
            {r.title_source === 'AUTO' && '문서 내용으로 붙인 제목입니다. '}
            {r.doc_dates?.length ? `본문 일자: ${dateLine(r.doc_dates)} ` : ''}
            {r.can_edit && <button type="button" className="linklike" onClick={() => setEditTitle(r.title ?? '')}>제목 고치기</button>}
          </p>
        </>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <label className="lbl" htmlFor="title-edit">문서 제목</label>
          <input id="title-edit" className="field" maxLength={200} value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
          <div className="actions"><button className="btn solid" onClick={saveTitle} disabled={!editTitle.trim()}>제목 저장</button><button className="btn" onClick={() => setEditTitle(null)}>취소</button></div>
        </div>
      )}

      <h2 className="section">문서 종류</h2>
      <div className="sheet">
        {r.classification ? (
          <p style={{ margin: 0 }}>
            {r.classification.source === 'HUMAN' ? '작성자가 정한 종류: ' : `AI 제안 (확신도 ${Math.round(r.classification.confidence * 100)}%): `}
            <strong>{TYPES.find(([v]) => v === r.classification!.document_type)?.[1]}</strong>
          </p>
        ) : <p style={{ margin: 0 }}>AI가 종류를 정하지 못했습니다. 직접 골라 주세요.</p>}
        {r.classification?.rationale && r.classification.source !== 'HUMAN' && <p className="note" style={{ marginTop: 6 }}>{r.classification.rationale}</p>}
        <label className="lbl" htmlFor="ty">바꿀 종류</label>
        <select id="ty" className="field" value={type} onChange={(e) => setType(e.target.value)} disabled={submitted}>
          <option value="" disabled>선택</option>
          {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {changed && (
          <>
            <label className="lbl" htmlFor="rs">바꾸는 이유</label>
            <input id="rs" className="field" type="text" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="actions"><button className="btn" onClick={saveType} disabled={!reason.trim()}>문서 종류 저장</button></div>
          </>
        )}
      </div>

      </aside></div>
    </>
  );
}

export default function ReviewPage() {
  return <Suspense fallback={<p className="note">불러오는 중입니다.</p>}><ReviewView /></Suspense>;
}
