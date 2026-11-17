// DOCX·HWPX 안의 그림(사진·캡처·도표)을 쪽별로 찾는다 (사용자 결정 11/17: DOCX·HWPX 그림 분석 추가, Owner yoyo0704).
// 쪽 번호는 TextLayerExtract(let522mj services/legal-etl/src/office.ts)의 walk 와 같은 규칙으로 센다
//   (DOCX <w:br w:type="page"/>, HWPX <hp:p pageBreak="1"> + 구역마다 새 쪽, 빈 쪽은 버림) → masked/segments/{nnnn} 와 쪽이 맞는다.
// 그림 참조: DOCX <a:blip r:embed> / <v:imagedata r:id> → word/_rels/document.xml.rels → word/media/*
//            HWPX <hc:img binaryItemIDRef> → Contents/content.hpf <opf:item id href> → BinData/*
import { strFromU8, unzipSync } from "fflate";

export type OfficeFigure = { page_index: number; name: string; data: Uint8Array };

type Page = { text: boolean; refs: string[] };

// office.ts walk 와 같은 토큰 규칙 + 그림 참조 수집
function walk(xml: string, ns: "w" | "hp"): Page[] {
  const pages: Page[] = [];
  let cur: Page = { text: false, refs: [] };
  let inText = false;
  const newPage = () => { pages.push(cur); cur = { text: false, refs: [] }; };
  const re = /<(\/?)([a-zA-Z]+):([a-zA-Z]+)([^>]*?)(\/?)>|([^<]+)/gu;
  for (let m; (m = re.exec(xml));) {
    if (m[6] !== undefined) { if (inText && m[6].trim()) cur.text = true; continue; }
    const [, close, prefix, name, attrs = ""] = m;
    if (!close) {
      const ref = (prefix === "a" && name === "blip" && /r:embed="([^"]+)"/u.exec(attrs)?.[1])
        || (prefix === "v" && name === "imagedata" && /r:id="([^"]+)"/u.exec(attrs)?.[1])
        || (prefix === "hc" && name === "img" && /binaryItemIDRef="([^"]+)"/u.exec(attrs)?.[1]);
      if (ref) cur.refs.push(ref);
    }
    if (prefix !== ns) continue;
    if (name === "t") { inText = !close && !m[5]; continue; }
    if (close) continue;
    if (ns === "w" && name === "br" && /w:type="page"/u.test(attrs)) newPage();
    else if (ns === "hp" && name === "p" && /pageBreak="(1|true)"/u.test(attrs) && cur.text) newPage();
  }
  newPage();
  // office.ts 는 빈 쪽을 버린다. 버려진 쪽의 그림은 바로 앞(없으면 다음) 남은 쪽에 붙인다
  const kept: Page[] = [];
  let orphan: string[] = [];
  for (const p of pages) {
    if (p.text || pages.length === 1) { kept.push({ text: true, refs: [...orphan, ...p.refs] }); orphan = []; }
    else if (kept.length) kept[kept.length - 1]!.refs.push(...p.refs);
    else orphan.push(...p.refs);
  }
  if (orphan.length) kept.push({ text: false, refs: orphan }); // ponytail: 본문 없는 그림만 문서 — 쪽 0 하나로
  return kept;
}

const attr = (s: string, k: string) => new RegExp(`\\b${k}="([^"]+)"`, "u").exec(s)?.[1];

export function officeFigures(bytes: Uint8Array, ext: "docx" | "hwpx"): OfficeFigure[] {
  const z = unzipSync(bytes);
  let pages: Page[];
  let resolve: (ref: string) => string | undefined;
  if (ext === "docx") {
    const doc = z["word/document.xml"];
    if (!doc) return [];
    pages = walk(strFromU8(doc), "w");
    const rels = new Map<string, string>();
    for (const r of strFromU8(z["word/_rels/document.xml.rels"] ?? new Uint8Array()).match(/<Relationship\b[^>]*>/gu) ?? []) {
      const id = attr(r, "Id"), t = attr(r, "Target");
      if (id && t && !/TargetMode="External"/u.test(r)) rels.set(id, t.startsWith("/") ? t.slice(1) : `word/${t}`);
    }
    resolve = (ref) => rels.get(ref);
  } else {
    const names = Object.keys(z).filter((n) => /^Contents\/section\d+\.xml$/u.test(n)).sort((a, b) => Number(/\d+/u.exec(a)![0]) - Number(/\d+/u.exec(b)![0]));
    pages = names.flatMap((n) => walk(strFromU8(z[n]!), "hp")); // 구역마다 새 쪽
    const items = new Map<string, string>();
    for (const it of strFromU8(z["Contents/content.hpf"] ?? new Uint8Array()).match(/<[a-z]*:?item\b[^>]*>/gu) ?? []) {
      const id = attr(it, "id"), href = attr(it, "href");
      if (id && href) items.set(id, href);
    }
    resolve = (ref) => items.get(ref);
  }
  const out: OfficeFigure[] = [];
  pages.forEach((p, page_index) => {
    for (const ref of new Set(p.refs)) {
      const name = resolve(ref);
      const data = name ? z[name] : undefined;
      if (name && data) out.push({ page_index, name, data });
    }
  });
  return out;
}
