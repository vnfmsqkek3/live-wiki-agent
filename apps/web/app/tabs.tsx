'use client';
import Link from 'next/link';
import { Icon } from './icons';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getSession, logout, type Session } from './lib/api';
import { accountLabel, can, needLabel } from './lib/roles';

/** 첫 화면부터 로그인 필수. 로그인 전에는 본문을 그리지 않는다(내용이 잠깐 보이는 것 방지). 그룹에 없는 화면은 안내만 */
export function Gate({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [s, setS] = useState<Session | undefined | null>(null); // null = 확인 전
  useEffect(() => {
    const cur = getSession();
    setS(cur);
    if (!cur && path !== '/login') router.replace(`/login?next=${encodeURIComponent(path + window.location.search)}`);
  }, [path, router]);
  if (path === '/login') return <>{children}</>;
  if (!s) return null;
  if (!can(s.groups, path)) {
    return (
      <section>
        <h1 className="title">볼 수 없는 화면입니다</h1>
        <p>이 화면은 {needLabel(path)}만 열 수 있습니다. 지금 계정은 {accountLabel(s.groups)}입니다.</p>
        <p className="note">권한이 필요하면 운영 담당자에게 요청하세요.</p>
        <Link className="btn" href="/">홈으로</Link>
      </section>
    );
  }
  return <>{children}</>;
}

/** 현재 사용자·역할과 로그아웃 */
export function SessionBar() {
  const path = usePathname();
  const router = useRouter();
  const [s, setS] = useState<Session | undefined>();
  useEffect(() => setS(getSession()), [path]);
  if (path === '/login') return null;
  if (!s) return <div className="session-bar"><Link href="/login">로그인</Link></div>;
  return (
    <div className="session-bar">
      <span><Icon name="user" /> {s.username} · {accountLabel(s.groups)}</span>
      <button type="button" onClick={() => { logout(); setS(undefined); router.push('/login'); }}>로그아웃</button>
    </div>
  );
}

const TABS = [
  { href: '/', label: '홈', icon: <Icon name="home" /> },
  { href: '/search', label: '검색', icon: <Icon name="search" /> },
  { href: '/library', label: '보관함', icon: <Icon name="library" /> },
  { href: '/guide', label: '가이드', icon: <Icon name="guide" /> },
  { href: '/upload', label: '등록', icon: <Icon name="upload" /> },
  { href: '/admin', label: '결재함', icon: <Icon name="approval" /> },
];

export function Tabs() {
  const path = usePathname();
  const [s, setS] = useState<Session | undefined>();
  useEffect(() => setS(getSession()), [path]);
  if (path === '/login' || !s) return null;
  const tabs = TABS.filter((t) => can(s.groups, t.href));
  return (
    <nav className="tabs" aria-label="주요 메뉴" style={{ ['--tab-n' as string]: tabs.length }}>
      <span className="wordmark"><span className="brand-symbol"><Icon name="guide" /></span><span>Hanaeum Wiki<small>근거로 연결하는 업무 지식</small></span></span>
      <div className="nav-links">{tabs.map((t) => (
        <Link key={t.href} href={t.href} aria-current={(t.href === '/' ? path === '/' : path.startsWith(t.href)) ? 'page' : undefined}>
          {t.icon}{t.label}
        </Link>
      ))}</div>
      <SessionBar />
    </nav>
  );
}
