import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Tabs } from './tabs';

export const metadata: Metadata = { title: 'Living Wiki · 한빛은행 (SYNTHETIC)', description: '지식의 신뢰성과 유효성을 관리하는 Wiki' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <main>{children}</main>
        <Tabs />
      </body>
    </html>
  );
}
