'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

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
