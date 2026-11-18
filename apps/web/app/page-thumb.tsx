'use client';
// 근거가 나온 쪽의 그림 썸네일 (검색 결과·가이드 근거, let522mj search 결과 page). 그림 없는 쪽은 이미지가 없어 아무것도 그리지 않는다
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiBlobUrl } from './lib/api';

export function PageThumb({ docId, page }: { docId: string; page?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!page) return;
    let u: string | null = null;
    apiBlobUrl(`/v1/library/${encodeURIComponent(docId)}/pages/${page}/image`).then((x) => { u = x; setUrl(x); }).catch(() => setUrl(null));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [docId, page]);
  if (!page || !url) return null;
  return (
    <Link className="page-thumb" href={`/library?id=${encodeURIComponent(docId)}&page=${page}`} aria-label={`${page}쪽 그림이 있는 문서 보기`}>
      <img src={url} alt={`${page}쪽 이미지 (개인정보는 가림)`} /><span className="note">{page}쪽</span>
    </Link>
  );
}
