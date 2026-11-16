'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { login, MOCK } from '../lib/api';

export default function Login() {
  const router = useRouter();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ maxWidth: '24rem', margin: '8vh auto 0' }}>
      <span className="seal official" aria-hidden="true" style={{ width: 72, height: 72, marginBottom: 16, fontSize: '.95rem' }}>한빛</span>
      <h1 className="title" style={{ marginBottom: 6 }}>Living Wiki</h1>
      <p className="note">근거와 시행일이 확인된 업무 지식만 모아 둔 한빛은행(합성) 사내 Wiki입니다.</p>
      {MOCK && <p className="mock">연습용 로그인입니다. 아이디에 author를 넣으면 작성자, approver를 넣으면 승인자로 들어갑니다.</p>}
      <form onSubmit={async (e) => { e.preventDefault(); setErr(''); setBusy(true); try { await login(u, p); router.push('/'); } catch (x) { setErr((x as Error).message); setBusy(false); } }}>
        <label className="lbl" htmlFor="u">아이디</label>
        <input id="u" className="field" type="text" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required />
        <label className="lbl" htmlFor="p">비밀번호</label>
        <input id="p" className="field" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required={!MOCK} />
        {err && <p className="error" role="alert" style={{ marginTop: 12 }}>{err}</p>}
        <div className="actions" style={{ marginTop: 24 }}><button className="btn solid" type="submit" disabled={busy}>로그인</button></div>
      </form>
    </div>
  );
}
