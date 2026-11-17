import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Gate, Tabs } from './tabs';

export const metadata: Metadata = { title: 'Hanaeum Wiki', description: 'Hanaeum Wiki — 근거 조문과 검증 상태로 확인하는 사내 업무 지식. 하나은행 가상 데이터 시연 서비스입니다.' };
export const viewport: Viewport = {
  width: 'device-width', initialScale: 1,
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@600;700&amp;display=swap" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&amp;text=0123456789&amp;display=swap" />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css" />
      </head>
      <body>
        <a className="skip-link" href="#content">본문으로 건너뛰기</a>
        <Tabs />
        <main id="content">
          <Gate>{children}</Gate>
          <p className="synthetic-footer">여기 있는 모든 문서는 시연용 하나은행 가상 데이터(SYNTHETIC)이며, 실제 하나은행의 규정·자료가 아닙니다.</p>
        </main>
      </body>
    </html>
  );
}
