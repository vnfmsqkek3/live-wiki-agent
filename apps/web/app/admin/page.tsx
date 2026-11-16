'use client';
// 06 관리: 결재란으로 진행 단계 표시. 불일치는 AI가 위조로 단정하지 않고 출처 검토를 요청한다.
import { useEffect, useState } from 'react';
import { api, ApiError, getSession, type Role } from '../lib/api';
import { accountLabel } from '../lib/roles';
import { Seal } from '../seal';

interface Item { approval_id: string; doc_id: string; title?: string; detail?: string; stage?: number; lifecycle?: string; workflow_failure?: { step: string; error: string } }
interface Mismatch { doc_id: string; title: string; dept: string; findings: { message: string; evidence_ref: string }[] }

function ApprovalBox({ stage, approved }: { stage: number; approved?: boolean }) {
  const steps = ['작성', '검토', '승인'];
  return (
    <div className="approval-box" aria-label={`결재 진행: ${steps.slice(0, stage).join(', ') || '없음'} 완료`}>
      {steps.map((s, n) => (
        <div key={s}>
          <span>{s}</span>
          {n === 2 && approved ? <b><Seal i={{ authority_status: 'VERIFIED', document_type: 'KNOWHOW' }} stamp /></b>
            : <b className={n < stage ? 'done' : 'wait'}>{n < stage ? '완료' : '대기'}</b>}
        </div>
      ))}
    </div>
  );
}

export default function Admin() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [mismatch, setMismatch] = useState<Mismatch[]>([]);
  const [done, setDone] = useState<Record<string, 'APPROVED' | 'REJECTED'>>({});
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

  /** 출처 불일치 문서 반려: 승인 대상이 아니므로 결재가 아니라 출처 검토 결과로 처리 */
  async function rejectSource(docId: string) {
    const reason = prompt('반려 사유를 적어주세요 (예: 공식 원본과 승인 기준 금액이 다름)');
    if (!reason) return;
    try {
      await api('POST', `/v1/documents/${docId}/source-review`, { decision: 'REJECT', reason });
      setDone((d) => ({ ...d, [docId]: 'REJECTED' }));
      setMsg('반려했습니다. 이 문서는 게시되지 않으며 작성자에게 사유가 전달됩니다.');
    } catch (e) { setMsg((e as ApiError).message); }
  }

  async function decide(id: string, decision: 'APPROVE' | 'REJECT') {
    const reason = prompt(decision === 'APPROVE' ? '승인 사유를 적어주세요' : '반려 사유를 적어주세요');
    if (!reason) return;
    try {
      const r = await api<{ status: 'APPROVED' | 'REJECTED' }>('POST', `/v1/approvals/${id}/decision`, { decision, reason });
      setDone((d) => ({ ...d, [id]: r.status }));
      setMsg(r.status === 'APPROVED' ? '승인했습니다. 색인이 끝나면 검색에 나타납니다.' : '반려했습니다. 작성자에게 사유가 전달됩니다.');
    } catch (e) {
      const x = e as ApiError;
      setMsg(x.message.startsWith('unclassified') ? x.message.replace(/^unclassified: /, '') : x.status === 409 ? '검토 이후 파일이 바뀌었거나, 이미 처리됐거나, 본인이 올린 문서입니다(본인 문서는 승인할 수 없음).' : x.message);
    }
  }

  const pending = items ?? [];
  return (
    <>
      <h1 className="title">결재함</h1>
      {role && <p className="meta" style={{ marginTop: -10 }}>{role} 계정으로 보고 있습니다</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="counts">
        <div><strong>{items ? pending.length : '–'}</strong><span className="meta">게시 승인 대기</span></div>
        <div><strong>{items ? mismatch.filter((m) => !done[m.doc_id]).length : '–'}</strong><span className="meta">출처 확인 필요</span></div>
      </div>

      {mismatch.length > 0 && <h2 className="section">출처 확인이 먼저 필요한 문서</h2>}
      <ul className="ledger">
        {mismatch.map((i) => (
          <li className="entry" key={i.doc_id} style={{ paddingRight: 16, borderLeftColor: 'var(--danger)' }}>
            <h3 className="doc-title">{i.title}</h3>
            {i.findings.map((f, n) => <p key={n} className="quote">{f.message}</p>)}
            <p className="note">공식 원본과 내용이 다릅니다. 위조로 확정된 것은 아니며, 출처가 확인될 때까지 게시 요청이 막혀 있습니다. 등록 출처를 확인한 뒤 처리하세요.</p>
            {done[i.doc_id] ? <p className="meta">반려 처리됨</p> : <div className="actions"><button className="btn" onClick={() => rejectSource(i.doc_id)}>반려</button></div>}
          </li>
        ))}
      </ul>

      <h2 className="section">게시 승인 대기</h2>
      {items && pending.length === 0 && <p className="note">결재할 문서가 없습니다.</p>}
      <ul className="ledger">
        {pending.map((i) => (
          <li className="entry" key={i.approval_id} style={{ paddingRight: 16 }}>
            <h3 className="doc-title">{i.title ?? i.doc_id}</h3>
            <p className="note">{i.detail ?? '작성자 검토가 끝났습니다.'}</p>
            <ApprovalBox stage={done[i.approval_id] === 'APPROVED' ? 3 : (i.stage ?? 2)} approved={done[i.approval_id] === 'APPROVED'} />
            {!done[i.approval_id] && (
              <div className="actions">
                <button className="btn solid" onClick={() => decide(i.approval_id, 'APPROVE')}>승인</button>
                <button className="btn" onClick={() => decide(i.approval_id, 'REJECT')}>반려</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p aria-live="polite" className="note" style={{ marginTop: 12 }}>{msg}</p>

      <h2 className="section">승인 뒤 게시 진행</h2>
      {after.length === 0 ? <p className="note">승인한 뒤 아직 게시되지 않은 문서가 없습니다.</p> : (
        <ul className="ledger">
          {after.map((i) => (
            <li className="entry" key={i.approval_id} style={{ paddingRight: 16 }}>
              <h3 className="doc-title">{i.title ?? i.doc_id}</h3>
              {i.workflow_failure
                ? <p className="error">게시 실패: {i.workflow_failure.step} 단계 ({i.workflow_failure.error}). 운영 담당자 확인이 필요합니다. 승인은 그대로 유지됩니다.</p>
                : <p className="note">게시 중입니다. 색인이 끝나면 검색과 보관함에 나타납니다(보통 수 분).</p>}
            </li>
          ))}
        </ul>
      )}

      <h2 className="section">운영 도구</h2>
      <div className="actions" style={{ marginTop: 0 }}>
        <button className="btn" disabled title="11/21 연동 예정">Agent 실행 기록</button>
        <button className="btn" disabled title="11/20 연동 예정">규정 변경 영향</button>
      </div>
    </>
  );
}
