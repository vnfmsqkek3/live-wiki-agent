import Link from 'next/link';

/** 검색 / 업무 가이드 전환 탭 (사용자 11/23: 무엇을 할 수 있는지 안 보임). 입력한 질문은 그대로 넘긴다 */
export function ModeTabs({ now, q }: { now: 'search' | 'guide'; q: string }) {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  const tab = (k: 'search' | 'guide', title: string, desc: string) => (
    <Link href={`/${k}${qs}`} aria-current={now === k ? 'page' : undefined}><strong>{title}</strong><span>{desc}</span></Link>
  );
  return <nav className="mode-tabs" aria-label="찾는 방법">{tab('search', '검색', '조문·문서 찾기')}{tab('guide', '업무 가이드', 'AI가 절차를 정리')}</nav>;
}
