'use client';
// 04 문서 등록: 서식 기입란 형태. 업로드 → 격리 저장 → 분석 시작
import { useState } from 'react';
import { api, ApiError, uploadFile } from '../lib/api';

const ACCEPT = '.pdf,.docx,.hwpx,.png,.jpg,.jpeg';
const MAX = 50 * 1024 * 1024;
const SCOPES = [['ALL', '전 직원'], ['dept:loan', '여신 부서'], ['dept:compliance', '준법감시 부서']] as const;

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [acl, setAcl] = useState('ALL');
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'done' | 'error'; msg?: string }>({ kind: 'idle' });

  const ext = file?.name.split('.').pop()?.toLowerCase() ?? '';
  const fileErr = file && (!ACCEPT.includes(`.${ext}`) ? 'PDF, DOCX, HWPX, PNG, JPG 파일만 올릴 수 있습니다.' : file.size > MAX ? '50MB 이하 파일만 올릴 수 있습니다.' : '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || fileErr || !title.trim()) return;
    try {
      setState({ kind: 'busy', msg: '업로드 주소를 받는 중입니다.' });
      const { doc_id, url } = await api<{ doc_id: string; url: string }>('POST', '/v1/documents/upload-url', {
        filename: file.name, size: file.size, title: title.trim(), dept: acl.startsWith('dept:') ? acl.slice(5) : 'all', acl_groups: [acl],
      });
      setState({ kind: 'busy', msg: '검사 전용 저장소에 올리는 중입니다.' });
      await uploadFile(url, file);
      await api('POST', `/v1/documents/${doc_id}/analyze`);
      setState({ kind: 'done', msg: '분석을 시작했습니다. 보안 검사, 텍스트 추출, 분류와 개인정보 확인이 끝나면 검토 요청이 옵니다.' });
    } catch (err) {
      const x = err as ApiError;
      setState({ kind: 'error', msg: x.status === 403 ? '문서 등록은 작성자 권한이 있어야 합니다.' : x.message });
    }
  }

  return (
    <>
      <h1 className="title">문서 등록</h1>
      <p className="notice">실제 은행 문서나 고객 정보는 올리지 마세요. 한빛은행 합성 문서만 등록할 수 있습니다.</p>
      <form onSubmit={submit} className="sheet" noValidate>
        <label className="lbl" htmlFor="f" style={{ marginTop: 0 }}>파일</label>
        <input id="f" type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-describedby="f-help" style={{ padding: '10px 0' }} />
        <p id="f-help" className={fileErr ? 'error' : 'note'}>{fileErr || 'PDF, DOCX, HWPX, PNG, JPG 파일, 50MB 이하'}</p>

        <label className="lbl" htmlFor="t">문서명</label>
        <input id="t" className="field" type="text" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />

        <label className="lbl" htmlFor="a">열람 범위</label>
        <select id="a" className="field" value={acl} onChange={(e) => setAcl(e.target.value)}>{SCOPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>

        <label className="lbl">문서 종류</label>
        <p className="note" style={{ margin: '6px 0 0' }}>분석이 끝나면 규정, 노하우, 매뉴얼 중 하나로 제안합니다. 검토할 때 바꿀 수 있습니다.</p>

        <div className="actions" style={{ marginTop: 24 }}>
          <button className="btn solid" type="submit" disabled={!file || !!fileErr || !title.trim() || state.kind === 'busy'}>분석 시작</button>
        </div>
        <p aria-live="polite" className={state.kind === 'error' ? 'error' : 'note'} style={{ marginTop: 12 }}>{state.msg}</p>
      </form>
    </>
  );
}
