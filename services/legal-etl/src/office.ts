// DOCX·HWPX 본문 텍스트 추출 (3a TextLayerExtract). 둘 다 ZIP 안의 XML이다.
//   DOCX: word/document.xml — 문단 <w:p>, 글자 <w:t>, 탭 <w:tab/>, 줄바꿈 <w:br/>, 쪽 나눔 <w:br w:type="page"/>
//   HWPX(OWPML): Contents/section{n}.xml — 문단 <hp:p pageBreak="1"?>, 글자 <hp:t>, 탭 <hp:tab/>, 줄바꿈 <hp:lineBreak/>. 구역(section)도 새 쪽
// 표 안의 문단도 같은 순서로 나온다(셀마다 줄). 문서 속 그림은 텍스트가 없으므로 여기서 다루지 않는다 (페이지 이미지 파이프라인 담당).
import { unzipSync, strFromU8 } from "fflate";

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m);

/** 태그를 순서대로 훑어 페이지별 텍스트를 만든다 (문단 중첩·표 안 문단도 순서 유지) */
function walk(xml: string, ns: "w" | "hp"): string[] {
  const pages: string[] = [];
  let cur = ""; let inText = false;
  const newPage = () => { pages.push(cur.replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim()); cur = ""; };
  const re = /<(\/?)([a-zA-Z]+):([a-zA-Z]+)([^>]*?)(\/?)>|([^<]+)/gu;
  for (let m; (m = re.exec(xml));) {
    if (m[6] !== undefined) { if (inText) cur += unescape(m[6]); continue; }
    const [, close, prefix, name, attrs = "", self] = m;
    if (prefix !== ns) continue;
    if (name === "t") { inText = !close && !self; continue; }
    if (close) { if (name === "p") cur += "\n"; continue; }
    if (name === "tab") cur += "\t";
    else if (ns === "w" && name === "br") { if (/w:type="page"/u.test(attrs)) newPage(); else cur += "\n"; }
    else if (ns === "hp" && name === "lineBreak") cur += "\n";
    else if (ns === "hp" && name === "p" && /pageBreak="(1|true)"/u.test(attrs) && cur.trim()) newPage();
  }
  newPage();
  return pages.filter((p, i, a) => p || a.length === 1);
}

export function docxPages(body: Buffer): string[] {
  const z = unzipSync(new Uint8Array(body), { filter: (f) => f.name === "word/document.xml" });
  const doc = z["word/document.xml"];
  if (!doc) throw Object.assign(new Error("DOCX 본문(word/document.xml) 없음"), { name: "InvalidOfficeFile" });
  return walk(strFromU8(doc), "w");
}

export function hwpxPages(body: Buffer): string[] {
  const z = unzipSync(new Uint8Array(body), { filter: (f) => /^Contents\/section\d+\.xml$/u.test(f.name) });
  const names = Object.keys(z).sort((a, b) => Number(/\d+/u.exec(a)![0]) - Number(/\d+/u.exec(b)![0]));
  if (!names.length) throw Object.assign(new Error("HWPX 본문(Contents/section*.xml) 없음"), { name: "InvalidOfficeFile" });
  return names.flatMap((n) => walk(strFromU8(z[n]!), "hp")); // 구역마다 새 쪽
}
