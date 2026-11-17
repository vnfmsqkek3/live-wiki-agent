'use client';
// 04 문서 등록: 서식 기입란 형태. 업로드 → 격리 저장 → 분석 시작
import { useEffect, useState } from 'react';
import { api, ApiError, uploadFile, type Progress } from '../lib/api';
import { IssueList } from '../issues';

const ACCEPT = '.pdf,.docx,.hwpx,.png,.jpg,.jpeg';
const MAX = 50 * 1024 * 1024;
const SCOPES = [['ALL', '전 직원'], ['DEPT#여신', '여신 부서'], ['DEPT#준법감시', '준법감시 부서']] as const;

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [acl, setAcl] = useState('ALL');
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'done' | 'error'; msg?: string; doc_id?: string }>({ kind: 'idle' });
  const [sent, setSent] = useState(0);
  const [prog, setProg] = useState<Progress | null>(null);

  // 분석 진행: 끝나거나 멈출 때까지 2초마다 확인
  useEffect(() => {
    if (state.kind !== 'done' || !state.doc_id) return;
    let stop = false;
    const tick = async () => {
      try {
        const p = await api<Progress>('GET', `/v1/documents/${state.doc_id}/progress`);
        if (stop) return;
        setProg(p);
        if (!p.finished && !p.halted) setTimeout(tick, 2000);
      } catch { if (!stop) setTimeout(tick, 4000); }
    };
    tick();
    return () => { stop = true; };
  }, [state.kind, state.doc_id]);

  const ext = file?.name.split('.').pop()?.toLowerCase() ?? '';
  const fileErr = file && (!ACCEPT.includes(`.${ext}`) ? 'PDF, DOCX, HWPX, PNG, JPG 파일만 올릴 수 있습니다.' : file.size > MAX ? '50MB 이하 파일만 올릴 수 있습니다.' : '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || fileErr) return;
    try {
      setState({ kind: 'busy', msg: '업로드 주소를 받는 중입니다.' });
      const { doc_id, url } = await api<{ doc_id: string; url: string }>('POST', '/v1/documents/upload-url', {
        filename: file.name, size: file.size, ...(title.trim() ? { title: title.trim() } : {}), dept: acl.startsWith('DEPT#') ? acl.slice(5) : 'all', acl_groups: [acl],
      });
      setState({ kind: 'busy', msg: '검사 전용 저장소에 올리는 중입니다.' });
      setProg(null); setSent(0);
      await uploadFile(url, file, setSent);
      await api('POST', `/v1/documents/${doc_id}/analyze`);
      setState({ kind: 'done', doc_id, msg: '분석을 시작했습니다.' });
    } catch (err) {
      const x = err as ApiError;
      setState({ kind: 'error', msg: x.status === 403 ? '문서 등록은 작성자 권한이 있어야 합니다.' : x.message });
    }
  }

  return (
    <>
      <h1 className="title">문서 등록</h1>
      <p className="notice">실제 은행 문서나 고객 정보는 올리지 마세요. 하나은행 가상 데이터(SYNTHETIC 표시) 문서만 등록할 수 있습니다.</p>
      <form onSubmit={submit} className="sheet" noValidate>
        <label className="lbl" htmlFor="f" style={{ marginTop: 0 }}>파일</label>
        <input id="f" type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-describedby="f-help" style={{ padding: '10px 0' }} />
        <p id="f-help" className={fileErr ? 'error' : 'note'}>{fileErr || 'PDF, DOCX, HWPX, PNG, JPG 파일, 50MB 이하'}</p>

        <label className="lbl" htmlFor="t">문서명 <span className="note">(선택)</span></label>
        <input id="t" className="field" type="text" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} aria-describedby="t-help" />
        <p id="t-help" className="note">비워 두면 분석이 끝난 뒤 문서 내용으로 제목을 붙입니다. 검토 화면에서 고칠 수 있습니다.</p>

        <label className="lbl" htmlFor="a">열람 범위</label>
        <select id="a" className="field" value={acl} onChange={(e) => setAcl(e.target.value)}>{SCOPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>

        <label className="lbl">문서 종류</label>
        <p className="note" style={{ margin: '6px 0 0' }}>분석이 끝나면 규정, 노하우, 매뉴얼 중 하나로 제안합니다. 검토할 때 바꿀 수 있습니다.</p>

        <div className="actions" style={{ marginTop: 24 }}>
          <button className="btn solid" type="submit" disabled={!file || !!fileErr || state.kind === 'busy'}>분석 시작</button>
        </div>
        <p aria-live="polite" className={state.kind === 'error' ? 'error' : 'note'} style={{ marginTop: 12 }}>{state.msg}</p>
        {state.kind === 'busy' && sent > 0 && <Bar label="파일 올리기" value={sent} />}
        {prog && (
          <section aria-label="분석 진행" className="progress">
            <Bar label={prog.halted ? '분석이 멈췄습니다' : prog.finished ? '분석이 끝났습니다' : `분석 중 (${prog.done}/${prog.total})`} value={prog.done / prog.total} danger={prog.halted} />
            <ol className="prog-steps">
              {prog.steps.map((s) => <li key={s.key} className={s.state}>{s.label}{s.state === 'running' && ' 중'}{s.state === 'failed' && ' 실패'}{s.state === 'blocked' && ' 차단'}</li>)}
            </ol>
            {prog.lifecycle === 'BLOCKED' && (
              <div className="notice" role="alert">
                <p style={{ margin: 0 }}>보안 검사에서 차단되어 등록할 수 없습니다.</p>
                {(prog.blocked_reasons ?? []).length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: '1.2em' }}>{prog.blocked_reasons!.map((r) => <li key={r}>{r}</li>)}</ul>}
              </div>
            )}
          </section>
        )}
        {state.doc_id && (prog?.finished || prog?.halted) && <IssueList docId={state.doc_id} refreshKey={prog?.lifecycle} />}
        {/* 실행이 실패해 분석이 끝나지 않은 문서(QUARANTINED)는 검토할 결과가 없다 → 실패 단계와 다음 행동만 */}
        {state.doc_id && prog?.halted && prog.lifecycle === 'QUARANTINED' && (
          <p className="notice" role="alert">{prog.steps.find((x) => x.state === 'failed')?.label ?? '처리'} 단계에서 분석이 멈춰 검토할 결과가 없습니다. 위 '확인할 내용'의 사유를 보고 파일을 고쳐 다시 올려 주세요. 반복되면 관리자에게 알려 주세요.</p>
        )}
        {state.doc_id && (prog?.finished || prog?.halted) && prog?.lifecycle !== 'BLOCKED' && prog?.lifecycle !== 'QUARANTINED' && <a className="btn solid" href={`/review?id=${encodeURIComponent(state.doc_id)}`}>분석 결과 검토하기</a>}
      </form>
    </>
  );
}

function Bar({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="bar-wrap">
      <span className="note">{label} · {pct}%</span>
      <div className={`bar${danger ? ' danger' : ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
