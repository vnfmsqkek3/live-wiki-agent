'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getSession, logout, MOCK, type Session } from './lib/api';

const ROLE: Record<string, string> = { USER: '직원', AUTHOR: '작성자', REG_APPROVER: '승인자', SECURITY_REVIEWER: '보안 검토자', PLATFORM_OPERATOR: '운영자' };

/** 로그인하지 않았으면 로그인 화면으로 (돌아올 주소 포함). 권한 판단은 서버가 한다 */
export function AuthGate() {
  const path = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (MOCK || path === '/login' || getSession()) return;
    router.replace(`/login?next=${encodeURIComponent(path + window.location.search)}`);
  }, [path, router]);
  return null;
}

/** 현재 사용자·역할과 로그아웃 */
export function SessionBar() {
  const path = usePathname();
  const router = useRouter();
  const [s, setS] = useState<Session | undefined>();
  useEffect(() => setS(getSession()), [path]);
  if (path === '/login') return null;
  if (!s) return <p className="session-bar"><Link href="/login">로그인</Link></p>;
  return (
    <p className="session-bar">
      <span>{s.username} · {s.groups.map((g) => ROLE[g] ?? g).join(', ')}</span>
      <button type="button" onClick={() => { logout(); setS(undefined); router.push('/login'); }}>로그아웃</button>
    </p>
  );
}

const I = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const TABS = [
  { href: '/', label: '홈', icon: I('M4 10.5 12 4l8 6.5V20h-5v-6H9v6H4z') },
  { href: '/search', label: '검색', icon: I('M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.5-4.5') },
  { href: '/library', label: '보관함', icon: I('M4 5h16v4H4zM5 9v10h14V9M10 13h4') },
  { href: '/upload', label: '등록', icon: I('M6 3h9l4 4v14H6zM15 3v4h4M12.5 17v-6M9.5 14l3-3 3 3') },
  { href: '/admin', label: '관리', icon: I('M5 4h14v16H5zM8 9h8M8 13h8M8 17h5') },
];

export function Tabs() {
  const path = usePathname();
  if (path === '/login') return null;
  return (
    <nav className="tabs" aria-label="주요 메뉴">
      <span className="wordmark">Living<br />Wiki</span>
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} aria-current={(t.href === '/' ? path === '/' : path.startsWith(t.href)) ? 'page' : undefined}>
          {t.icon}{t.label}
        </Link>
      ))}
    </nav>
  );
}
