'use client';
// 문서보관함 '폴더' 보기 (사용자 11/23): 업무 분류 경로로 접고 펴는 트리. WAI-ARIA tree 패턴(화살표·Enter·Home/End)
import Link from 'next/link';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { LibraryCard } from './lib/api';
import { FreshnessFlag, Scheduled } from './seal';

type Folder = { name: string; path: string; docs: LibraryCard[]; subs: Map<string, Folder> };
const KIND: Record<string, string> = { REGULATION: '규정', KNOWHOW: '노하우', MANUAL: '매뉴얼' };
const AUTH: Record<string, [string, string]> = { VERIFIED: ['검증됨', 'ok'], UNVERIFIED: ['미검증', 'wait'], REJECTED: ['반려', 'bad'] };

function build(items: LibraryCard[]): Folder {
  const root: Folder = { name: '', path: '', docs: [], subs: new Map() };
  for (const d of items) {
    const parts = d.category_path?.split('/').filter(Boolean) ?? (d.business_path.length ? d.business_path : ['미분류']);
    let f = root;
    for (const p of parts) {
      const path = `${f.path}/${p}`;
      if (!f.subs.has(p)) f.subs.set(p, { name: p, path, docs: [], subs: new Map() });
      f = f.subs.get(p)!;
    }
    f.docs.push(d);
  }
  return root;
}
const total = (f: Folder): number => f.docs.length + [...f.subs.values()].reduce((n, s) => n + total(s), 0);

export function LibraryTree({ items }: { items: LibraryCard[] }) {
  const root = build(items);
  // 처음에는 1단계 폴더만 펼친다
  const [open, setOpen] = useState<Set<string>>(() => new Set([...root.subs.values()].map((f) => f.path)));
  const ref = useRef<HTMLUListElement>(null);
  const toggle = (p: string, v?: boolean) => setOpen((s) => { const n = new Set(s); if (v ?? !n.has(p)) n.add(p); else n.delete(p); return n; });

  function onKey(e: KeyboardEvent<HTMLUListElement>) {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? [])].filter((x) => x.offsetParent !== null);
    const cur = document.activeElement?.closest<HTMLElement>('[role=treeitem]');
    const i = cur ? all.indexOf(cur) : -1;
    const go = (j: number) => { all[Math.max(0, Math.min(all.length - 1, j))]?.focus(); e.preventDefault(); };
    const path = cur?.dataset.path;
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
    else if (e.key === 'ArrowRight' && path) { if (!open.has(path)) toggle(path, true); else go(i + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') {
      if (path && open.has(path)) { toggle(path, false); e.preventDefault(); }
      else go(all.indexOf(cur?.parentElement?.closest<HTMLElement>('[role=treeitem]') ?? cur!));
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (path) { toggle(path); e.preventDefault(); } else if (e.key === 'Enter') cur?.querySelector('a')?.click();
    }
  }

  const doc = (d: LibraryCard) => {
    const [a, tone] = AUTH[d.authority_status] ?? ['미검증', 'wait'];
    return (
      <li key={d.doc_id} role="treeitem" tabIndex={-1} className="tree-doc">
        <Link href={`/library?id=${encodeURIComponent(d.doc_id)}`} tabIndex={-1}>{d.title}</Link>
        <span className="kind-tag">{KIND[d.document_type ?? 'KNOWHOW']}</span>
        <span className={`auth ${tone}`}>{a}</span>
        <Scheduled date={d.effective_from} />
        <FreshnessFlag freshness={d.freshness} />
      </li>
    );
  };
  const folder = (f: Folder, first: boolean) => {
    const exp = open.has(f.path);
    return (
      <li key={f.path} role="treeitem" aria-expanded={exp} data-path={f.path} tabIndex={first ? 0 : -1} className="tree-folder">
        <span className="tree-name" onClick={() => toggle(f.path)}><span aria-hidden="true">{exp ? '▾' : '▸'}</span> {f.name} <span className="note">{total(f)}건</span></span>
        {exp && <ul role="group">{[...f.subs.values()].map((s) => folder(s, false))}{f.docs.map(doc)}</ul>}
      </li>
    );
  };
  return (
    <ul role="tree" aria-label="업무 분류 폴더" className="lib-tree" ref={ref} onKeyDown={onKey}>
      {[...root.subs.values()].map((f, i) => folder(f, i === 0))}
      {root.docs.map(doc)}
    </ul>
  );
}
