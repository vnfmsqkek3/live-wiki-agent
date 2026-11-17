'use client';
// 06 관리: 결재란으로 진행 단계 표시. 불일치는 AI가 위조로 단정하지 않고 출처 검토를 요청한다.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, getSession, type Role } from '../lib/api';
import { decideApproval, rejectSource } from '../lib/decide';
import { accountLabel } from '../lib/roles';
import { Seal } from '../seal';

interface Item { approval_id: string; doc_id: string; title?: string; detail?: string; stage?: number; lifecycle?: string; workflow_failure?: { step: string; error: string }; version?: { version_no?: number; previous_title: string; changes_count: number } }
interface Mismatch { doc_id: string; title: string; dept: string; kind: 'SOURCE_MISMATCH' | 'BLOCKED'; findings: { message: string; user_message?: string; evidence_ref: string }[] }
/** 결재함 → 문서 상세 (무엇이 왜 문제인지 쪽·밑줄로). 돌아오면 결재함 */
const detail = (doc_id: string) => `/library?id=${encodeURIComponent(doc_id)}&from=admin`;

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

  async function onRejectSource(docId: string) {
    const r = await rejectSource(docId);
    if (!r) return;
    if (r.status) setDone((d) => ({ ...d, [docId]: r.status! }));
    setMsg(r.msg);
  }

  async function decide(id: string, decision: 'APPROVE' | 'REJECT') {
    const r = await decideApproval(id, decision);
    if (!r) return;
    if (r.status) setDone((d) => ({ ...d, [id]: r.status! }));
    setMsg(r.msg);
  }

  const pending = items ?? [];
  const source = mismatch.filter((m) => m.kind !== 'BLOCKED');
  const blocked = mismatch.filter((m) => m.kind === 'BLOCKED');
  return (
    <>
      <h1 className="title">결재함</h1><p className="page-description">출처 확인이 필요한 문서를 먼저 확인하고, 근거를 읽은 뒤 결재하세요.</p>
      {role && <p className="meta" style={{ marginTop: -10 }}>{role} 계정으로 보고 있습니다</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="counts">
        <div><strong>{items ? pending.length : '–'}</strong><span className="meta">게시 승인 대기</span></div>
        <div><strong>{items ? source.filter((m) => !done[m.doc_id]).length : '–'}</strong><span className="meta">출처 확인 필요</span></div>
      </div>

      {source.length > 0 && <h2 className="section">출처 확인이 먼저 필요한 문서</h2>}
      <ul className="ledger">
        {source.map((i) => (
          <li className="entry" key={i.doc_id} style={{ paddingRight: 16, borderLeftColor: 'var(--danger)' }}>
            <h3 className="doc-title"><Link href={detail(i.doc_id)}>{i.title}</Link></h3>
            {i.findings.map((f, n) => <p key={n} className="quote">{f.message}</p>)}
            <p className="note">공식 원본과 내용이 다릅니다. 위조로 확정된 것은 아니며, 출처가 확인될 때까지 게시 요청이 막혀 있습니다. 제목을 누르면 어느 쪽 어느 조문이 다른지 볼 수 있습니다.</p>
            {done[i.doc_id] ? <p className="meta">반려 처리됨</p> : <div className="actions"><button className="btn" onClick={() => onRejectSource(i.doc_id)}>반려</button></div>}
          </li>
        ))}
      </ul>

      <h2 className="section">게시 승인 대기</h2>
      {items && pending.length === 0 && <p className="note">결재할 문서가 없습니다.</p>}
      <ul className="ledger">
        {pending.map((i) => (
          <li className="entry" key={i.approval_id} style={{ paddingRight: 16 }}>
            <h3 className="doc-title"><Link href={detail(i.doc_id)}>{i.title ?? '제목 없는 문서'}</Link></h3>
            <p className="note">{i.detail ?? '작성자 검토가 끝났습니다.'} 제목을 누르면 본문과 확인할 곳을 볼 수 있습니다.</p>
            {i.version && <p className="flag" style={{ display: 'block' }}>새 버전 v{i.version.version_no ?? 2} · 이전 「{i.version.previous_title}」 대비 바뀐 곳 {i.version.changes_count}건 (상세에서 비교)</p>}
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

      {blocked.length > 0 && (
        <>
          <h2 className="section">보안 검사에서 자동 차단된 문서 <span className="note">최근 7일</span></h2>
          <p className="note">결재할 필요는 없습니다. 올린 사람에게 고치는 방법이 안내되었고, 원본 파일은 삭제되었습니다.</p>
          <ul className="ledger">
            {blocked.map((i) => (
              <li className="entry" key={i.doc_id} style={{ paddingRight: 16 }}>
                <h3 className="doc-title"><Link href={detail(i.doc_id)}>{i.title}</Link></h3>
                {i.findings.slice(0, 3).map((f, n) => <p key={n} className="quote">{f.user_message ?? f.message}</p>)}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className="section">승인 뒤 게시 진행</h2>
      {after.length === 0 ? <p className="note">승인한 뒤 아직 게시되지 않은 문서가 없습니다.</p> : (
        <ul className="ledger">
          {after.map((i) => (
            <li className="entry" key={i.approval_id} style={{ paddingRight: 16 }}>
              <h3 className="doc-title">{i.title ?? '제목 없는 문서'}</h3>
              {i.workflow_failure
                ? <p className="error">게시 처리에 실패했습니다. 운영 담당자 확인이 필요합니다. 승인은 그대로 유지됩니다.</p>
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
