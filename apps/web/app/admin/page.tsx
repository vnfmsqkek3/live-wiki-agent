'use client';
import { PaginatedList } from '../paginated-list';
import { PageHeader } from '../page-header';
// 06 관리: 결재란으로 진행 단계 표시. 불일치는 AI가 위조로 단정하지 않고 출처 검토를 요청한다.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, getSession, type DocChange, type Role } from '../lib/api';
import { decideApproval, rejectSource } from '../lib/decide';
import { accountLabel } from '../lib/roles';
import { Icon } from '../icons';
import { Seal } from '../seal';

interface Item { approval_id: string; doc_id: string; title?: string; detail?: string; stage?: number; lifecycle?: string; workflow_failure?: { step: string; error: string }; version?: { version_no?: number; previous_title: string; changes_count: number; changes?: DocChange[] }; summary_line?: string | null; source?: string }
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
      <PageHeader title="결재함" description="출처 확인이 필요한 문서를 먼저 확인하고, 근거를 읽은 뒤 결재하세요." action={<Link className="btn" href="/library">문서보관함</Link>} />
      {role && <p className="meta" style={{ marginTop: -10 }}>{role} 계정으로 보고 있습니다</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="counts">
        <div><strong>{items ? pending.length : '–'}</strong><span className="meta">게시 승인 대기</span></div>
        <div><strong>{items ? source.filter((m) => !done[m.doc_id]).length : '–'}</strong><span className="meta">출처 확인 필요</span></div>
      </div>

      {/* 운영 도구를 위로 (Fable 재배치안 11/18: 규정 변경 영향은 포지셔닝 둘째 축) */}
      <div className="actions ops-row" aria-label="운영 도구">
        <Link className="btn" href="/admin/impact"><Icon name="alert" />규정 변경 영향</Link>
        <Link className="btn" href="/admin/runs"><Icon name="clock" />Agent 실행 기록</Link>
      </div>
      {/* 카테고리별 가로 카드와 독립 페이지네이션 */}
      <div className="approval-categories">
        <div className="approval-category-group" aria-label="결재할 일">
          {source.length > 0 && <h2 className="section">출처 확인이 먼저 필요한 문서</h2>}
          <PaginatedList label="출처 확인 필요" pageKey="source_page" pageSize={3} className="ledger card-grid admin-grid">
            {source.map((i) => (
              <li className="entry" key={i.doc_id} style={{ paddingRight: 16 }}>
                <span className="flag"><Icon name="alert" />출처 확인 필요</span>
                <h3 className="doc-title"><Link href={detail(i.doc_id)}>{i.title}</Link></h3>
                {i.findings.map((f, n) => <p key={n} className="quote">{f.message}</p>)}
                <p className="note">공식 원본과 내용이 다릅니다. 위조로 확정된 것은 아니며, 출처가 확인될 때까지 게시 요청이 막혀 있습니다. '다른 곳 보기'에서 어느 쪽 어느 조문이 다른지 볼 수 있습니다.</p>
                {done[i.doc_id] ? <p className="meta">반려 처리됨</p> : <div className="actions"><Link className="btn" href={detail(i.doc_id)}><Icon name="library" />다른 곳 보기</Link><button className="btn" onClick={() => onRejectSource(i.doc_id)}>반려</button></div>}
              </li>
            ))}
          </PaginatedList>

          <h2 className="section">게시 승인 대기</h2>
          {items && pending.length === 0 && <p className="note">결재할 문서가 없습니다.</p>}
          <PaginatedList label="게시 승인 대기" pageKey="pending_page" pageSize={3} className="ledger card-grid admin-grid">
            {pending.map((i) => (
              <li className="entry" key={i.approval_id} style={{ paddingRight: 16 }}>
                {/* 규칙 3: 한 줄 요약 + 바뀐 부분 + 승인·반려. 나머지는 '자세히' (AI 검사를 통과한 것만 여기 온다) */}
                <span className="kind-tag">{i.source === 'WIKI_EDIT' ? '위키 수정' : '새 문서'} · AI 검사 통과</span>
                <h3 className="doc-title">{i.title ?? '제목 없는 문서'}</h3>
                {i.summary_line && <p className="lead-line">{i.summary_line}</p>}
                {i.version?.changes?.length ? (
                  <ul className="mini-changes" aria-label="바뀐 부분">{i.version.changes.slice(0, 3).map((c, n) => (
                    <li key={n}>{c.kind !== 'ADDED' && <del>{c.old_text.slice(0, 90)}</del>}{c.kind !== 'REMOVED' && <ins>{c.new_text.slice(0, 90)}</ins>}</li>
                  ))}{i.version.changes_count > 3 && <li className="note">외 {i.version.changes_count - 3}곳</li>}</ul>
                ) : !i.version && <p className="note">처음 올라온 문서입니다.</p>}
                <ApprovalBox stage={done[i.approval_id] === 'APPROVED' ? 3 : (i.stage ?? 2)} approved={done[i.approval_id] === 'APPROVED'} />
                {!done[i.approval_id] && (
                  <div className="actions">
                    {/* 사람이 확인 → 판단 순서: 문서 확인을 먼저, 같은 크기의 버튼으로 (사용자 지적 11/18: 밑줄 글자라 안 보임) */}
                    <Link className="btn" href={detail(i.doc_id)}><Icon name="library" />문서 확인</Link>
                    <span className="actions-gap" aria-hidden="true" />
                    <button className="btn" onClick={() => decide(i.approval_id, 'REJECT')}>반려</button>
                    <button className="btn solid" onClick={() => decide(i.approval_id, 'APPROVE')}>승인</button>
                  </div>
                )}
              </li>
            ))}
          </PaginatedList>
          <p aria-live="polite" className="note" style={{ marginTop: 12 }}>{msg}</p>
        </div>
        <div className="approval-category-group" aria-label="진행·참고">
          <h2 className="section">승인 뒤 게시 진행</h2>
          {after.length === 0 ? <p className="note">승인한 뒤 아직 게시되지 않은 문서가 없습니다.</p> : (
            <PaginatedList label="승인 뒤 게시 진행" pageKey="after_page" pageSize={3} className="ledger card-grid admin-grid">
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
              <PaginatedList label="자동 차단" pageKey="blocked_page" pageSize={3} className="ledger card-grid admin-grid">
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
        </div>
      </div>

      <KnowledgeDebt />
    </>
  );
}
