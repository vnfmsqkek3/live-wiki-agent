// OCR 결과 보정 (13항 12번 실측: PaddleOCR 한국어가 항 번호 원문자 ①③을 "1" "3"으로 읽어 조문 구조가 무너짐).
// 보정은 순서 근거가 있을 때만: 조 머리 바로 뒤의 1, 또는 줄 머리에서 "직전 항 번호 + 1"인 숫자만 원문자로 되돌린다.
// "1. 최근 3년간"(호, 점 있음)·"3년간 보관"(숫자+단위)은 바꾸지 않는다.
// 조 제목 괄호 뒤 공백 누락(쪽 첫 줄에서 실측)도 조 번호 순서가 맞을 때만 되돌린다.
const CIRCLED = [..."①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"];
const UNIT = "년월일개회명인원억만천차세시분초주쪽장건%";
const NUM_AHEAD = new RegExp(`^(\\d{1,2})(?:\\s+|(?=[가-힣「(]))(?![${UNIT}])(.*)$`, "u");
const PARTICLE = /^(에서|에게|에도|에는|에|의|을|를|와|과|및|으로|로|부터|까지|에\s)/u;
const ARTICLE = /^(제\d+조(?:의\d+)?(?:\s*\((?:[^()]|\([^()]*\))*\))?)\s*(.*)$/u;

export function restoreCircled(text: string): string {
  let last = 0; // 현재 조에서 마지막 항 번호
  let lastArticle = 0; // 마지막 조 번호 (부칙에서 다시 1부터)
  return text.split("\n").map((line) => {
    if (/^부\s*칙/u.test(line)) { lastArticle = 0; last = 0; return line; }
    const art = ARTICLE.exec(line);
    // 조 머리: 번호가 앞으로 가고(직전보다 큼, 가지 조는 같아도 됨) 괄호 바로 뒤가 조사가 아닐 때만.
    // OCR이 괄호 뒤 공백을 빼먹으면("제13조(심사 기록)심사") 되돌린다. 본문 속 인용("제10조(특례)에 따른")은 조사로 걸러진다
    const no = art ? Number(/^제(\d+)조/u.exec(line)![1]) : 0;
    const forward = no > lastArticle || (no === lastArticle && /^제\d+조의\d+/u.test(line));
    if (art && forward && !PARTICLE.test(art[2]!)) {
      lastArticle = no; last = 0;
      const rest = art[2]!;
      const m = NUM_AHEAD.exec(rest);
      if (m && Number(m[1]) === 1) { last = 1; return `${art[1]} ① ${m[2]}`; }
      if (CIRCLED.includes([...rest][0] ?? "")) last = CIRCLED.indexOf([...rest][0]!) + 1;
      return rest ? `${art[1]} ${rest}` : art[1]!;
    }
    const first = [...line][0] ?? "";
    if (CIRCLED.includes(first)) { last = CIRCLED.indexOf(first) + 1; return line; }
    const m = NUM_AHEAD.exec(line);
    if (m && Number(m[1]) === last + 1 && last + 1 <= CIRCLED.length) { last++; return `${CIRCLED[last - 1]} ${m[2]}`; }
    return line;
  }).join("\n");
}

export interface OcrBox { text: string; bbox: number[] }
/** OCR 블록을 같은 줄끼리 묶는다 (세로 중심이 줄 높이 절반 안이면 같은 줄), 왼→오른·위→아래 순 */
export function ocrRows(blocks: OcrBox[]): string[] {
  const items = blocks.filter((b) => b.bbox?.length === 4)
    .map((b) => ({ t: b.text, x: b.bbox[0]!, yc: (b.bbox[1]! + b.bbox[3]!) / 2, h: b.bbox[3]! - b.bbox[1]! })).sort((a, b) => a.yc - b.yc);
  const out: { yc: number; h: number; parts: typeof items }[] = [];
  for (const it of items) {
    const last = out.at(-1);
    if (last && Math.abs(it.yc - last.yc) < Math.max(last.h, it.h) / 2) last.parts.push(it); else out.push({ yc: it.yc, h: it.h, parts: [it] });
  }
  return out.map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.t).join(" "));
}
