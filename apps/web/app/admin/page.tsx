'use client';
// 06 관리자 대시보드: 승인 대기·재검증 카운터, 규정 불일치 우선 카드("위조 확정 아님"), 게시 승인 대기
import { useEffect, useState } from 'react';
import { api, ApiError, getSession } from '../lib/api';

interface Item { approval_id: string; doc_id: string; kind?: 'MISMATCH' | 'PENDING'; title?: string; detail?: string }

export default function Admin() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<{ items: Item[] }>('GET', '/v1/approvals?status=PENDING').then((r) => setItems(r.items)).catch((e: ApiError) => { setErr(e.status === 403 ? '승인 권한이 없습니다' : e.message); setItems([]); });
  useEffect(() => { load(); }, []);

  async function decide(id: string, decision: 'APPROVE' | 'REJECT') {
    const reason = prompt(decision === 'APPROVE' ? '승인 사유' : '반려 사유');
    if (!reason) return;
    try {
      const r = await api<{ status: string }>('POST', `/v1/approvals/${id}/decision`, { decision, reason });
      setMsg(`${id}: ${r.status}`);
      setItems((xs) => xs?.filter((x) => x.approval_id !== id) ?? null);
    } catch (e) { setMsg((e as ApiError).message); }
  }

  const mismatch = items?.filter((i) => i.kind === 'MISMATCH') ?? [];
  const pending = items?.filter((i) => i.kind !== 'MISMATCH') ?? [];
  const role = getSession()?.groups.join(', ') ?? '미로그인';
  return (
    <>
      <p className="muted" style={{ margin: 0 }}>ADMIN CONSOLE · {role}</p>
      <h1>관리</h1>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row">
        <div className="card grow"><div className="muted">승인 대기</div><strong style={{ fontSize: '1.6rem' }}>{items?.length ?? '–'}</strong></div>
        <div className="card grow"><div className="muted">재검증 필요</div><strong style={{ fontSize: '1.6rem' }}>{mismatch.length}</strong></div>
      </div>
      {mismatch.length > 0 && <h2>우선 처리 · 규정 불일치</h2>}
      {mismatch.map((i) => (
        <article className="card" key={i.approval_id}>
          <span className="badge b-bad">규정 불일치</span> <span className="badge b-warn">위조 확정 아님 · 출처 검토 필요</span>
          <h3 style={{ margin: '6px 0' }}>{i.title ?? i.doc_id}</h3>
          <p className="muted">{i.detail}</p>
          <div className="row"><button onClick={() => decide(i.approval_id, 'REJECT')}>반려</button></div>
        </article>
      ))}
      <h2>게시 승인 대기</h2>
      {pending.length === 0 && <p className="muted">대기 중인 문서가 없습니다.</p>}
      {pending.map((i) => (
        <article className="card" key={i.approval_id}>
          <h3 style={{ margin: '0 0 6px' }}>{i.title ?? i.doc_id}</h3>
          <p className="muted">{i.detail ?? '작성자 검토 완료'}</p>
          <div className="row"><button className="primary" onClick={() => decide(i.approval_id, 'APPROVE')}>승인</button><button onClick={() => decide(i.approval_id, 'REJECT')}>반려</button></div>
        </article>
      ))}
      <p aria-live="polite" className="muted">{msg}</p>
      <h2>운영 도구</h2>
      <div className="row"><button disabled title="11/21 예정">Agent Observability</button><button disabled title="11/20 예정">변경 영향 분석</button></div>
    </>
  );
}
