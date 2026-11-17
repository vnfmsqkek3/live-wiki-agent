'use client';

import { Children, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';

type Props = { children: ReactNode; label: string; className?: string; pageKey?: string; pageSize?: number };

function List({ children, label, className, pageKey = 'page', pageSize = 6 }: Props) {
  const params = useSearchParams();
  const entries = Children.toArray(children);
  const pages = Math.max(1, Math.ceil(entries.length / pageSize));
  const raw = params.get(pageKey) ?? '1';
  const requested = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Math.max(1, Number(raw)) : 1;
  const page = Math.min(requested, pages);
  const start = useRef<HTMLDivElement>(null);
  const previous = useRef(page);
  useEffect(() => {
    if (previous.current !== page) {
      start.current?.focus({ preventScroll: true });
      start.current?.scrollIntoView({ block: 'start' });
      previous.current = page;
    }
  }, [page]);
  // 삭제·필터 결과 감소 또는 잘못된 주소도 실제 표시 쪽과 일치시킨다.
  useEffect(() => {
    if (entries.length === 0 || raw === String(page)) return;
    const url = new URL(window.location.href);
    if (page === 1) url.searchParams.delete(pageKey); else url.searchParams.set(pageKey, String(page));
    window.history.replaceState(null, '', url);
  }, [raw, page, pageKey, entries.length]);
  function go(n: number) {
    const url = new URL(window.location.href);
    if (n === 1) url.searchParams.delete(pageKey); else url.searchParams.set(pageKey, String(n));
    window.history.pushState(null, '', url);
  }
  const numbers = [...new Set([1, ...Array.from({ length: 5 }, (_, i) => page - 2 + i).filter((n) => n > 1 && n < pages), pages])];
  return <div className="paginated-list" data-page-key={pageKey}>
    <div ref={start} tabIndex={-1} role="group" aria-label={`${label} 목록 시작`} className="list-start">
      <ul className={className}>{entries.slice((page - 1) * pageSize, page * pageSize)}</ul>
    </div>
    {entries.length > 0 && <nav className="list-pagination" aria-label={`${label} 페이지네이션`}>
      <span className="note" role="status">전체 {entries.length}건 · {page} / {pages}쪽</span>
      <button className="btn" type="button" data-page-prev disabled={page === 1} onClick={() => go(page - 1)}>이전</button>
      {numbers.map((n, i) => <span className="page-number" key={n}>{i > 0 && n - numbers[i - 1]! > 1 && <span aria-hidden="true">…</span>}<button className="btn num" type="button" aria-label={`${n}쪽`} aria-current={n === page ? 'page' : undefined} onClick={() => go(n)}>{n}</button></span>)}
      <button className="btn" type="button" data-page-next disabled={page === pages} onClick={() => go(page + 1)}>다음</button>
    </nav>}
  </div>;
}

export function PaginatedList(props: Props) {
  return <Suspense fallback={<p className="note">목록을 불러오는 중입니다.</p>}><List {...props} /></Suspense>;
}
