import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Gate, SessionBar, Tabs } from './tabs';

export const metadata: Metadata = { title: 'Hanaeum Wiki', description: 'Hanaeum Wiki — 근거 조문과 검증 상태로 확인하는 사내 업무 지식. 하나은행 가상 데이터 시연 서비스입니다.' };
export const viewport: Viewport = {
  width: 'device-width', initialScale: 1,
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f4f7f8' }, { media: '(prefers-color-scheme: dark)', color: '#101b23' }],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <a className="skip-link" href="#content">본문으로 건너뛰기</a>
        <main id="content">
          <SessionBar />
          <Gate>{children}</Gate>
          <p className="synthetic-footer">여기 있는 모든 문서는 시연용 하나은행 가상 데이터(SYNTHETIC)이며, 실제 하나은행의 규정·자료가 아닙니다.</p>
        </main>
        <Tabs />
      </body>
    </html>
  );
}
