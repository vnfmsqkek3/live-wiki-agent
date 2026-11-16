'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const I = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={d} /></svg>;
const TABS = [
  { href: '/', label: '홈', icon: I('M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z') },
  { href: '/search', label: '검색', icon: I('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4') },
  { href: '/upload', label: '등록', icon: I('M12 16V4m-5 5 5-5 5 5M4 20h16') },
  { href: '/admin', label: '관리', icon: I('M4 6h16M4 12h16M4 18h10') },
];

export function Tabs() {
  const path = usePathname();
  if (path === '/login') return null;
  return (
    <nav className="tabs" aria-label="주요 메뉴">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} aria-current={(t.href === '/' ? path === '/' : path.startsWith(t.href)) ? 'page' : undefined}>
          {t.icon}{t.label}
        </Link>
      ))}
    </nav>
  );
}
