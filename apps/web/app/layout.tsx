import type { Metadata, Viewport } from 'next';
import { Gowun_Batang, IBM_Plex_Sans_KR } from 'next/font/google';
import './globals.css';
import { AuthGate, SessionBar, Tabs } from './tabs';

// 한글 폰트는 서브셋이 커서 preload하지 않는다
const batang = Gowun_Batang({ weight: ['400', '700'], subsets: ['latin'], variable: '--font-batang', preload: false, display: 'swap' });
const plex = IBM_Plex_Sans_KR({ weight: ['400', '500', '600', '700'], subsets: ['latin'], variable: '--font-plex', preload: false, display: 'swap' });

export const metadata: Metadata = { title: 'Living Wiki', description: '하나은행(가상 데이터) 지식의 근거와 유효성을 확인하는 Wiki' };
export const viewport: Viewport = {
  width: 'device-width', initialScale: 1,
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#eef1ec' }, { media: '(prefers-color-scheme: dark)', color: '#142030' }],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${batang.variable} ${plex.variable}`}>
      <body>
        <AuthGate />
        <main>
          <SessionBar />
          {children}
          <p className="meta" style={{ marginTop: 40 }}>여기 있는 모든 문서는 시연용 하나은행 가상 데이터(SYNTHETIC)이며, 실제 하나은행의 규정·자료가 아닙니다.</p>
        </main>
        <Tabs />
      </body>
    </html>
  );
}
