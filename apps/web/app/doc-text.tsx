import { Fragment, type ReactNode } from 'react';
import type { Mark } from './lib/api';

type Range = { start: number; end: number };
export type DocBlock = Range & { kind: 'heading' | 'clause' | 'list' | 'quote' | 'paragraph' | 'blank' | 'table'; level: number; prefix: string; cells?: Range[] };

/** UTF-16 offsets match String.slice and API marks. Never trim/normalize the source.
 * Self-check fixtures: '# 제목\r\n**굵게** [주민등록번호]\n- 항목\n' →
 * visible '제목굵게 [주민등록번호]항목' (line breaks are block boundaries).
 * '|a|b|\n|c|d|' → cells 'a','b','c','d', each source character once.
 * Marks [2, 16) spanning these lines must keep their original number in each block.
 */
export function parseDocText(text: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const end = offset + line.length;
    const heading = /^(#{1,3}) /.exec(line);
    const list = /^(\s*)([①-⑳]\s*|\d+[.)]\s+|[-*]\s+|·\s*)/.exec(line);
    const clause = /^제\s*\d+\s*(?:조(?:의\d+)?(?:\([^)]*\))?|장|절)/.test(line);
    const table = /^\s*\|.*\|\s*$/.test(line);
    let kind: DocBlock['kind'] = !line.trim() ? 'blank' : heading ? 'heading' : clause ? 'clause' : list ? 'list' : line.startsWith('> ') ? 'quote' : 'paragraph';
    const prefix = heading?.[0] ?? list?.[0] ?? (kind === 'quote' ? '> ' : '');
    const block: DocBlock = { kind, start: offset + prefix.length, end, prefix, level: heading?.[1]?.length ?? (list ? Math.floor(list[1]!.length / 2) : 0) };
    if (table) {
      kind = 'table'; block.kind = kind;
      const pipes = [...line.matchAll(/\|/g)].map((m) => m.index!);
      block.cells = pipes.slice(0, -1).map((p, i) => ({ start: offset + p + 1, end: offset + pipes[i + 1]! }));
    }
    blocks.push(block); offset += raw.length + 1;
  }
  // Only consecutive pipe rows are a table; isolated pipes stay plain text.
  return blocks.map((b, i) => b.kind === 'table' && blocks[i - 1]?.kind !== 'table' && blocks[i + 1]?.kind !== 'table' ? { ...b, kind: 'paragraph', cells: undefined } : b);
}

type Numbered = { m: Mark; n: number };
export function DocText({ text, marks = [], active = 0, onPick = () => {} }: { text: string; marks?: Numbered[]; active?: number; onPick?: (n: number) => void }) {
  const spans = marks.filter(({ m }) => m.start !== null && m.end !== null).slice().sort((a, b) => a.m.start! - b.m.start!);
  function marked(start: number, end: number): ReactNode {
    const out: ReactNode[] = [];
    let at = start;
    for (const { m, n } of spans) {
      const s = Math.max(at, m.start!, start), e = Math.min(end, m.end!);
      if (s >= e) continue;
      out.push(text.slice(at, s));
      out.push(<mark key={`${s}-${n}`} role="button" tabIndex={0} aria-label={`${n}번 확인할 내용`} className={`hl${active === n ? ' on' : ''}`} onClick={() => onPick(n)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPick(n); } }}>{text.slice(s, e)}<sup>{n}</sup></mark>);
      at = e;
    }
    out.push(text.slice(at, end)); return out;
  }
  function inline(start: number, end: number): ReactNode {
    const out: ReactNode[] = [];
    const source = text.slice(start, end);
    const pattern = /\*\*([^\n]+?)\*\*|\[[^\]\n]+\]/g;
    let at = start;
    for (const match of source.matchAll(pattern)) {
      const s = start + match.index!;
      out.push(<Fragment key={`plain-${at}`}>{marked(at, s)}</Fragment>);
      out.push(match[1] !== undefined ? <strong key={s}>{inline(s + 2, s + match[0].length - 2)}</strong> : <span className="pii" key={s}>{marked(s, s + match[0].length)}</span>);
      at = s + match[0].length;
    }
    out.push(<Fragment key={`tail-${at}`}>{marked(at, end)}</Fragment>); return out;
  }
  const blocks = parseDocText(text);
  const out: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!, key = b.start;
    const content = inline(b.start, b.end);
    if (b.kind === 'table') {
      const rows: DocBlock[] = [b];
      while (blocks[i + 1]?.kind === 'table') rows.push(blocks[++i]!);
      out.push(<div className="doc-table" key={key}><table><tbody>{rows.map((row) => <tr key={row.start}>{row.cells!.map((cell) => <td key={cell.start}>{inline(cell.start, cell.end)}</td>)}</tr>)}</tbody></table></div>);
    } else if (b.kind === 'heading') {
      out.push(b.level === 1 ? <h2 key={key}>{content}</h2> : b.level === 2 ? <h3 key={key}>{content}</h3> : <h4 key={key}>{content}</h4>);
    } else if (b.kind === 'clause') {
      const number = /^제\s*\d+\s*(?:조(?:의\d+)?|장|절)/.exec(text.slice(b.start, b.end))!;
      out.push(<h3 className="doc-clause" key={key}><span>{inline(b.start, b.start + number[0].length)}</span>{inline(b.start + number[0].length, b.end)}</h3>);
    } else if (b.kind === 'list') {
      out.push(<div className="doc-list" role="list" key={key}><div role="listitem" style={{ paddingLeft: `${Math.min(b.level, 6)}em` }}><span className="doc-bullet" aria-hidden="true">{b.prefix.trim().replace(/^[-*]$/, '•')}</span>{content}</div></div>);
    } else if (b.kind === 'quote') out.push(<blockquote key={key}>{content}</blockquote>);
    else if (b.kind === 'blank') out.push(<div className="doc-break" key={key} />);
    else out.push(<p key={key}>{content}</p>);
  }
  return <div className="page-text doc-text">{out}</div>;
}
