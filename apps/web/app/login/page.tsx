'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Icon } from '../icons';
import { Seal } from '../seal';
import { login, MOCK } from '../lib/api';

function LoginForm() {
  const router = useRouter();
  // 같은 사이트 경로만 돌아간다 (외부 주소로 보내는 open redirect 방지)
  const sp = useSearchParams();
  const n = sp.get('next') ?? '/';
  const next = n.startsWith('/') && !n.startsWith('//') ? n : '/';
  const expired = sp.get('expired') === '1';
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="login-layout"><section className="login-intro"><h2>믿을 수 있는 지식으로<br />업무의 기준을 세우세요.</h2><p>모든 문서에는 결재란이 있습니다. 세 칸에 도장이 모두 찍힌 문서만 믿고 씁니다.</p><figure className="login-kyul"><Seal size="full" i={{ authority_status: 'VERIFIED', document_type: 'KNOWHOW', lifecycle: 'PUBLISHED', mark_count: 0 }} /><figcaption>작성자 등록 · AI가 근거 조문 대조 · 사람이 승인</figcaption></figure><ul className="trust-principles"><li><Icon name="shield" />공식 원본과 근거 조문 확인</li><li><Icon name="check" />개인정보 가림과 보안 검사</li><li><Icon name="approval" />담당자 검토 후 게시 승인</li></ul></section><section className="login-panel">
      <h1 className="title login-brand"><span className="brand-mark" aria-hidden="true"><Icon name="guide" /></span>Hanaeum Wiki</h1>
      <p className="note">근거와 시행일이 확인된 업무 지식만 모아 둔 하나은행(가상 데이터) 사내 Wiki 시연판입니다.</p>
      {expired && <p className="notice" role="status">로그인이 만료되었습니다. 다시 로그인하면 보던 화면으로 돌아갑니다. 고르던 파일이나 입력하던 내용은 저장되지 않았으니 다시 골라 주세요.</p>}
      {MOCK && <p className="mock">연습용 로그인입니다. 아이디에 admin을 넣으면 관리자, 그 밖은 사용자로 들어갑니다.</p>}
      <form onSubmit={async (e) => { e.preventDefault(); setErr(''); setBusy(true); try { await login(u, p); router.replace(next); } catch (x) { setErr((x as Error).message); setBusy(false); } }}>
        <label className="lbl" htmlFor="u">아이디</label>
        <input id="u" className="field" type="text" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required />
        <label className="lbl" htmlFor="p">비밀번호</label>
        <input id="p" className="field" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required={!MOCK} />
        {err && <p className="error" role="alert" style={{ marginTop: 12 }}>{err}</p>}
        <div className="actions" style={{ marginTop: 24 }}><button className="btn solid" type="submit" disabled={busy}>로그인</button></div>
      </form>
      <p className="note" style={{ marginTop: 20 }}>계정은 관리자가 발급합니다. 계정이 없거나 관리자 권한이 필요하면 운영 담당자에게 요청하세요.</p>
    </section></div>
  );
}

export default function Login() {
  return <Suspense fallback={<p className="note">불러오는 중입니다.</p>}><LoginForm /></Suspense>;
}
