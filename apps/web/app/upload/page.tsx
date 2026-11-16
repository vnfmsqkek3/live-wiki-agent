'use client';
// 04 문서 업로드: 허용 형식, 문서명, 공개 범위, 문서 유형(AI 자동 분류 예정), 실문서 금지 경고 → [분석 시작]
import { useState } from 'react';
import { api, ApiError, uploadFile } from '../lib/api';

const ACCEPT = '.pdf,.docx,.hwpx,.png,.jpg,.jpeg';
const MAX = 50 * 1024 * 1024;
const DEPTS = [['ALL', '전체 공개'], ['dept:loan', '여신 부서'], ['dept:compliance', '준법감시 부서']] as const;

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [acl, setAcl] = useState('ALL');
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'done' | 'error'; msg?: string }>({ kind: 'idle' });

  const ext = file?.name.split('.').pop()?.toLowerCase() ?? '';
  const fileErr = file && (!ACCEPT.includes(`.${ext}`) ? '허용되지 않은 형식입니다' : file.size > MAX ? '50MB 이하만 업로드할 수 있습니다' : '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || fileErr || !title.trim()) return;
    setState({ kind: 'busy', msg: '업로드 URL 발급 중' });
    try {
      const { doc_id, url } = await api<{ doc_id: string; url: string }>('POST', '/v1/documents/upload-url', {
        filename: file.name, size: file.size, title: title.trim(), dept: acl.startsWith('dept:') ? acl.slice(5) : 'all', acl_groups: [acl],
      });
      setState({ kind: 'busy', msg: '격리 저장소에 업로드 중' });
      await uploadFile(url, file);
      setState({ kind: 'busy', msg: '분석 시작 요청 중' });
      await api('POST', `/v1/documents/${doc_id}/analyze`);
      setState({ kind: 'done', msg: `분석을 시작했습니다 (${doc_id}). 보안 검사 → OCR → 분류·PII 순으로 진행됩니다.` });
    } catch (err) {
      const e2 = err as ApiError;
      setState({ kind: 'error', msg: e2.status === 403 ? '작성자 권한이 필요합니다' : e2.message });
    }
  }

  return (
    <>
      <h1>문서 등록</h1>
      <p className="banner b-bad" role="note">실제 은행 문서·고객정보는 업로드하지 마세요. 합성 문서(SYNTHETIC)만 허용됩니다.</p>
      <form onSubmit={submit} className="card">
        <label htmlFor="f">파일 (PDF · DOCX · HWPX · PNG/JPG, 50MB 이하)</label>
        <input id="f" type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-describedby="f-err" />
        {fileErr && <p id="f-err" className="error">{fileErr}</p>}
        <label htmlFor="t">문서명</label>
        <input id="t" type="text" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} required />
        <label htmlFor="a">공개 범위</label>
        <select id="a" value={acl} onChange={(e) => setAcl(e.target.value)}>{DEPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <label>문서 유형</label>
        <p className="muted" style={{ margin: 0 }}>AI 자동 분류 예정 (기반 규정 / 노하우 / 매뉴얼). 분석 후 수정할 수 있습니다.</p>
        <div style={{ marginTop: 16 }}>
          <button className="primary" type="submit" disabled={!file || !!fileErr || !title.trim() || state.kind === 'busy'}>분석 시작</button>
        </div>
        <p aria-live="polite" className={state.kind === 'error' ? 'error' : 'muted'}>{state.msg}</p>
      </form>
    </>
  );
}
