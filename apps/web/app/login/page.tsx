'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { login, MOCK } from '../lib/api';

function LoginForm() {
  const router = useRouter();
  // 같은 사이트 경로만 돌아간다 (외부 주소로 보내는 open redirect 방지)
  const n = useSearchParams().get('next') ?? '/';
  const next = n.startsWith('/') && !n.startsWith('//') ? n : '/';
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ maxWidth: '24rem', margin: '8vh auto 0' }}>
      <span className="seal official" aria-hidden="true" style={{ width: 72, height: 72, marginBottom: 16, fontSize: '.95rem' }}>위키</span>
      <h1 className="title" style={{ marginBottom: 6 }}>Living Wiki</h1>
      <p className="note">근거와 시행일이 확인된 업무 지식만 모아 둔 하나은행(가상 데이터) 사내 Wiki 시연판입니다.</p>
      {MOCK && <p className="mock">연습용 로그인입니다. 아이디에 author(작성자)·approver(규정 승인자)·security(보안 검토자)·operator(운영자)를 넣으면 그 그룹으로, 그 밖은 직원으로 들어갑니다.</p>}
      <form onSubmit={async (e) => { e.preventDefault(); setErr(''); setBusy(true); try { await login(u, p); router.replace(next); } catch (x) { setErr((x as Error).message); setBusy(false); } }}>
        <label className="lbl" htmlFor="u">아이디</label>
        <input id="u" className="field" type="text" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required />
        <label className="lbl" htmlFor="p">비밀번호</label>
        <input id="p" className="field" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required={!MOCK} />
        {err && <p className="error" role="alert" style={{ marginTop: 12 }}>{err}</p>}
        <div className="actions" style={{ marginTop: 24 }}><button className="btn solid" type="submit" disabled={busy}>로그인</button></div>
      </form>
      <p className="note" style={{ marginTop: 20 }}>계정은 관리자가 발급합니다. 계정이 없거나 권한(작성자·승인자)이 필요하면 운영 담당자에게 요청하세요.</p>
    </div>
  );
}

export default function Login() {
  return <Suspense fallback={<p className="note">불러오는 중입니다.</p>}><LoginForm /></Suspense>;
}
