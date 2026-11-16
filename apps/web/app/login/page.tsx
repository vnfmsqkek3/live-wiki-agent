'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { login, MOCK } from '../lib/api';

export default function Login() {
  const router = useRouter();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  return (
    <>
      <h1>Living Wiki 로그인</h1>
      <p className="muted">한빛은행 (Synthetic Bank) · 합성 데이터 전용</p>
      {MOCK && <p className="banner b-warn">mock 모드: 아이디에 author / approver 를 포함하면 해당 역할로 로그인됩니다.</p>}
      <form className="card" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await login(u, p); router.push('/'); } catch (x) { setErr((x as Error).message); } }}>
        <label htmlFor="u">아이디</label>
        <input id="u" type="text" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required />
        <label htmlFor="p">비밀번호</label>
        <input id="p" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required={!MOCK} />
        {err && <p className="error" role="alert">{err}</p>}
        <div style={{ marginTop: 16 }}><button className="primary" type="submit">로그인</button></div>
      </form>
    </>
  );
}
