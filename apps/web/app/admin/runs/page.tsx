'use client';
// 관리 > Agent 실행 기록: 업로드·게시·삭제 워크플로 실행(WORKFLOWS). 실행을 누르면 단계별 상태·오류·시각
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '../../lib/api';
import { PageHeader } from '../../page-header';
import { PaginatedList } from '../../paginated-list';

interface Run { workflow_id: string; doc_id?: string; title?: string; kind: string; status: string; started_at?: string; ended_at?: string; duration_s?: number; steps: number; failed_step?: string }
interface Step { step: string; status: string; ended_at: string; error?: string }
const KIND: Record<string, string> = { ingest: '업로드 검사', publish: '게시', 'publish-APPROVE': '승인 후 게시', 'publish-REJECT': '반려 처리', delete: '삭제 정리' };
const STATUS: Record<string, [string, string]> = { SUCCEEDED: ['완료', 'ok'], FAILED: ['실패', 'bad'], RUNNING: ['진행 중', 'wait'], OK: ['완료', 'ok'] };
const at = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-');
const dur = (s?: number) => (s === undefined ? '-' : s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`);

export default function Runs() {
  const [items, setItems] = useState<Run[] | null>(null);
  const [trace, setTrace] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  useEffect(() => {
    api<{ items: Run[]; trace_url: string }>('GET', '/v1/admin/runs').then((r) => { setItems(r.items); setTrace(r.trace_url); })
      .catch((e: ApiError) => { setErr(e.status === 403 ? '결재 권한이 있는 계정만 볼 수 있습니다.' : e.message); setItems([]); });
  }, []);
  const toggle = (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id); setSteps([]);
    api<{ steps: Step[] }>('GET', `/v1/admin/runs/${id}`).then((r) => setSteps(r.steps)).catch(() => setSteps([]));
  };
  return (
    <>
      <PageHeader title="Agent 실행 기록" description="문서마다 돌아간 자동 검사·게시·삭제 실행입니다. 실행을 누르면 단계별 결과가 보입니다." action={<Link className="btn" href="/admin">관리로 돌아가기</Link>} />
      {trace && <p className="note"><a href={trace} target="_blank" rel="noreferrer">모델 호출 추적 보기 (CloudWatch GenAI Observability)</a></p>}
      {err && <p className="error" role="alert">{err}</p>}
      {items === null ? <p className="note">불러오는 중입니다.</p> : items.length === 0 && !err ? <p className="note">아직 실행 기록이 없습니다. 문서를 올리면 여기에 나타납니다.</p> : (
        <PaginatedList label="실행 기록" pageKey="page" className="ledger run-list">
          {items.map((r) => {
            const [label, tone] = STATUS[r.status] ?? [r.status, 'wait'];
            return (
              <li className="entry run" key={r.workflow_id}>
                <button type="button" className="run-head" aria-expanded={open === r.workflow_id} onClick={() => toggle(r.workflow_id)}>
                  <span className={`run-status ${tone}`}>{label}</span>
                  <span className="doc-title">{r.title ?? r.workflow_id}</span>
                  <span className="meta">{KIND[r.kind] ?? r.kind} · 시작 {at(r.started_at)} · 소요 {dur(r.duration_s)} · 단계 {r.steps}개{r.failed_step ? ` · 멈춘 단계 ${r.failed_step}` : ''}</span>
                </button>
                {open === r.workflow_id && (
                  <ol className="run-steps">
                    {steps.length === 0 ? <li className="note">단계 기록을 불러오는 중입니다.</li> : steps.map((s) => {
                      const [sl, st] = STATUS[s.status] ?? [s.status, 'wait'];
                      return <li key={s.step}><span className={`run-status ${st}`}>{sl}</span> <strong>{s.step}</strong> <span className="meta">{at(s.ended_at)}{s.error ? ` · 오류 ${s.error}` : ''}</span></li>;
                    })}
                    {r.doc_id && <li><Link href={`/library?id=${encodeURIComponent(r.doc_id)}&from=admin`}>문서 보기</Link></li>}
                  </ol>
                )}
              </li>
            );
          })}
        </PaginatedList>
      )}
    </>
  );
}
