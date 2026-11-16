'use client';
// 06 관리: 결재란으로 진행 단계 표시. 불일치는 AI가 위조로 단정하지 않고 출처 검토를 요청한다.
import { useEffect, useState } from 'react';
import { api, ApiError, getSession } from '../lib/api';
import { Seal } from '../seal';

interface Item { approval_id: string; doc_id: string; kind?: 'MISMATCH' | 'PENDING'; title?: string; detail?: string; stage?: number }
const ROLE_NAME: Record<string, string> = { USER: '일반 사용자', AUTHOR: '작성자', REG_APPROVER: '규정 승인자', SECURITY_REVIEWER: '보안 검토자', PLATFORM_OPERATOR: '운영 관리자' };

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
  const [done, setDone] = useState<Record<string, 'APPROVED' | 'REJECTED'>>({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [role, setRole] = useState('');
  useEffect(() => {
    setRole(getSession()?.groups.map((g) => ROLE_NAME[g] ?? g).join(', ') ?? '');
    api<{ items: Item[] }>('GET', '/v1/approvals?status=PENDING').then((r) => setItems(r.items))
      .catch((e: ApiError) => { setErr(e.status === 403 ? '승인 대기 목록은 규정 승인자와 보안 검토자만 볼 수 있습니다.' : e.message); setItems([]); });
  }, []);

  async function decide(id: string, decision: 'APPROVE' | 'REJECT') {
    const reason = prompt(decision === 'APPROVE' ? '승인 사유를 적어주세요' : '반려 사유를 적어주세요');
    if (!reason) return;
    try {
      const r = await api<{ status: 'APPROVED' | 'REJECTED' }>('POST', `/v1/approvals/${id}/decision`, { decision, reason });
      setDone((d) => ({ ...d, [id]: r.status }));
      setMsg(r.status === 'APPROVED' ? '승인했습니다. 색인이 끝나면 검색에 나타납니다.' : '반려했습니다. 작성자에게 사유가 전달됩니다.');
    } catch (e) { setMsg((e as ApiError).status === 409 ? '검토 이후 파일이 바뀌었거나 이미 처리된 요청입니다.' : (e as ApiError).message); }
  }

  const mismatch = items?.filter((i) => i.kind === 'MISMATCH') ?? [];
  const pending = items?.filter((i) => i.kind !== 'MISMATCH') ?? [];
  return (
    <>
      <h1 className="title">결재함</h1>
      {role && <p className="meta" style={{ marginTop: -10 }}>{role} 권한으로 보고 있습니다</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="counts">
        <div><strong>{items ? pending.length : '–'}</strong><span className="meta">게시 승인 대기</span></div>
        <div><strong>{items ? mismatch.length : '–'}</strong><span className="meta">출처 확인 필요</span></div>
      </div>

      {mismatch.length > 0 && <h2 className="section">출처 확인이 먼저 필요한 문서</h2>}
      <ul className="ledger">
        {mismatch.map((i) => (
          <li className="entry" key={i.approval_id} style={{ paddingRight: 16, borderLeftColor: 'var(--danger)' }}>
            <h3 className="doc-title">{i.title ?? i.doc_id}</h3>
            <p className="quote">{i.detail}</p>
            <p className="note">공식 원본과 내용이 다릅니다. 위조로 확정된 것은 아니며, 등록 출처를 확인한 뒤 처리하세요.</p>
            {done[i.approval_id] ? <p className="meta">반려 처리됨</p> : <div className="actions"><button className="btn" onClick={() => decide(i.approval_id, 'REJECT')}>반려</button></div>}
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

      <h2 className="section">운영 도구</h2>
      <div className="actions" style={{ marginTop: 0 }}>
        <button className="btn" disabled title="11/21 연동 예정">Agent 실행 기록</button>
        <button className="btn" disabled title="11/20 연동 예정">규정 변경 영향</button>
      </div>
    </>
  );
}
