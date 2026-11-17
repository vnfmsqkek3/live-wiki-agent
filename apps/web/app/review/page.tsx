'use client';
// 05 OCR·PII 검토: 작성자가 자동 분석 결과를 확인·수정하고 게시를 요청한다.
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError, dateLine, type Finding, type Review } from '../lib/api';
import { IssueList, PageFacts, VersionLink } from '../issues';

const STAGES = ['파일 올리기', '자동 분석', '작성자 검토', '게시 요청'];
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

/** [전화번호] 같은 마스킹 표시를 눈에 띄게 */
function Masked({ text }: { text: string }) {
  return <>{text.split(/(\[[^\]\n]{2,8}\])/).map((p, i) => (/^\[.+\]$/.test(p) ? <mark key={i} className="pii">{p}</mark> : p))}</>;
}

function ReviewView() {
  const id = useSearchParams().get('id') ?? '';
  const [r, setR] = useState<Review | null>(null);
  const [err, setErr] = useState('');
  const [type, setType] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [editTitle, setEditTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!id) { setErr('검토할 문서를 찾을 수 없습니다. 문서 등록 화면에서 다시 시작하세요.'); return; }
    api<Review>('GET', `/v1/documents/${encodeURIComponent(id)}/review`)
      .then((x) => { setR(x); setType(x.classification?.document_type ?? ''); })
      .catch((e: ApiError) => setErr(e.status === 404 ? '이 문서를 볼 권한이 없거나 문서가 없습니다.' : e.message));
  }, [id]);

  if (err) return <p className="error" role="alert">{err}</p>;
  if (!r) return <p className="note">분석 결과를 불러오는 중입니다.</p>;

  const changed = type && type !== r.classification?.document_type;
  const blocked = r.trust_gate_result === 'QUARANTINED' || r.lifecycle === 'BLOCKED';
  const uncertain = r.findings.filter((f) => f.severity !== 'LOW').length;

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
    try { await api('POST', `/v1/documents/${encodeURIComponent(id)}/submit`); setSubmitted(true); setMsg('게시를 요청했습니다. 규정 승인자가 결재하면 검색에 나타납니다.'); }
    catch (e) { setMsg((e as ApiError).status === 409 ? '지금 상태에서는 게시를 요청할 수 없습니다. 분석이 끝났는지 확인하세요.' : (e as ApiError).message); }
  }

  const stage = submitted ? 4 : 3;
  return (
    <>
      {editTitle === null ? (
        <>
          <h1 className="title" style={{ marginBottom: 4 }}>{r.title ?? '문서 검토'}</h1>
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
      <ol className="stages" aria-label="등록 진행 단계">
        {STAGES.map((s, i) => <li key={s} aria-current={i + 1 === stage ? 'step' : undefined} className={i + 1 < stage ? 'done' : ''}>{s}</li>)}
      </ol>

      {r.workflow_failure && <p className="notice" role="alert">{r.workflow_failure.step} 단계에서 처리가 멈췄습니다. 아래 '확인할 내용'에 사유와 고치는 방법이 있습니다.</p>}
      {blocked && <p className="notice">보안 검사에서 차단되어 게시할 수 없습니다. 아래 '확인할 내용'에 쪽·사유가 있습니다.</p>}
      <IssueList docId={r.doc_id} />
      <VersionLink docId={r.doc_id} canEdit={!!r.can_edit} />
      {!blocked && r.trust_gate_result === 'REVIEW_REQUIRED' && <p className="mock">확인이 필요한 항목이 {uncertain}건 있습니다. 아래 내용을 확인한 뒤 게시를 요청하세요.</p>}

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

      {r.knowhow_validation && (() => {
        const k = r.knowhow_validation;
        const [title, color] = VERDICT[k.verdict]!;
        return (
          <section aria-labelledby="kh">
            <h2 className="section" id="kh">노하우 검증</h2>
            <p className="notice" style={{ borderLeftColor: color, color }}>{title}. AI가 비교한 결과이며, 게시 여부는 규정 승인자가 결정합니다.</p>
            {k.outdated.map((o) => <p key={o.cited} className="flag" style={{ display: 'block', marginBottom: 8 }}>개정 전 조문을 인용했습니다. 현행 {o.label} 기준으로 다시 확인하세요.</p>)}
            <ul className="ledger">
              {k.items.filter((j) => j.relation !== 'UNRELATED').map((j, i) => (
                <li key={i} className="entry" style={{ paddingRight: 16, borderLeftColor: j.relation === 'CONFLICTS' ? 'var(--danger)' : j.relation === 'SUPPORTS' ? 'var(--verified)' : undefined }}>
                  <p style={{ margin: 0 }}><strong>{REL[j.relation]}</strong><br />노하우: “{j.statement}”</p>
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
                <li key={f.finding_id} className="entry" style={{ paddingRight: 16, borderLeftColor: f.severity === 'LOW' ? undefined : f.severity === 'HIGH' ? 'var(--danger)' : 'var(--ochre)' }}>
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
          <div className="sheet quote" style={{ whiteSpace: 'pre-line' }}><Masked text={r.masked_preview} /></div>
        </>
      )}

      <div className="actions" style={{ marginTop: 24 }}>
        <button className="btn solid" onClick={submit} disabled={blocked || submitted || r.lifecycle !== 'IN_REVIEW'}>검토 마치고 게시 요청</button>
      </div>
      <p aria-live="polite" className="note" style={{ marginTop: 12 }}>{msg}</p>
    </>
  );
}

export default function ReviewPage() {
  return <Suspense fallback={<p className="note">불러오는 중입니다.</p>}><ReviewView /></Suspense>;
}
