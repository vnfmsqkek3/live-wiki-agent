// OCR 결과 보정 (13항 12번 실측: PaddleOCR 한국어가 항 번호 원문자 ①③을 "1" "3"으로 읽어 조문 구조가 무너짐).
// 보정은 순서 근거가 있을 때만: 조 머리 바로 뒤의 1, 또는 줄 머리에서 "직전 항 번호 + 1"인 숫자만 원문자로 되돌린다.
// "1. 최근 3년간"(호, 점 있음)·"3년간 보관"(숫자+단위)은 바꾸지 않는다.
// 조 제목 괄호 뒤 공백 누락(쪽 첫 줄에서 실측)도 조 번호 순서가 맞을 때만 되돌린다.
const CIRCLED = [..."①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"];
const UNIT = "년월일개회명인원억만천차세시분초주쪽장건%";
const NUM_AHEAD = new RegExp(`^(\\d{1,2})(?:\\s+|(?=[가-힣「(]))(?![${UNIT}])(.*)$`, "u");
const PARTICLE = /^(에서|에게|에도|에는|에|의|을|를|와|과|및|으로|로|부터|까지|에\s)/u;
const ARTICLE = /^(제\d+조(?:의\d+)?(?:\s*\((?:[^()]|\([^()]*\))*\))?)\s*(.*)$/u;

/** 쪽을 넘어 이어지는 문맥 (조·항이 다음 쪽으로 넘어가도 "2"를 ②로 되돌릴 수 있게) */
export interface CircledState { last: number; lastArticle: number }
// OCR은 "제 10 조", "제 1 항제 3 호"처럼 번호 앞뒤에 공백을 넣기도 한다(11/17 DOCX→PDF→OCR 실측) → 붙인다
// 단위 글자 뒤가 경계(공백·괄호·조사·다음 번호·원문자·문장부호)일 때만 붙인다: "제 1 조정위원회", "제2 관리자"는 그대로 (PR #28 리뷰)
const SPACED_NO = /제\s*(\d+)\s*(조|항|호|장|절|편|관)(?:\s*의\s*(\d+))?(?=\s|$|\(|제\s*\d|의|에|및|부터|까지|와|과|[①-⑳,.·])/gu;
/** 쪽 번호 꼬리말("2 / 15", "3-15")은 항 번호로 보지 않는다 */
const PAGE_NO = /^\s*\d+\s*[/-]\s*\d+\s*$/u;

export function restoreCircled(text: string, st: CircledState = { last: 0, lastArticle: 0 }): string {
  return text.split("\n").map((line0) => {
    if (PAGE_NO.test(line0)) return line0;
    const line = line0.replace(SPACED_NO, (_, n: string, u: string, br?: string) => `제${n}${u}${br ? `의${br}` : ""}`);
    if (/^부\s*칙/u.test(line)) { st.lastArticle = 0; st.last = 0; return line; }
    const art = ARTICLE.exec(line);
    // 조 머리: 번호가 앞으로 가고(직전보다 큼, 가지 조는 같아도 됨) 괄호 바로 뒤가 조사가 아닐 때만.
    // OCR이 괄호 뒤 공백을 빼먹으면("제13조(심사 기록)심사") 되돌린다. 본문 속 인용("제10조(특례)에 따른")은 조사로 걸러진다
    const no = art ? Number(/^제(\d+)조/u.exec(line)![1]) : 0;
    const forward = no > st.lastArticle || (no === st.lastArticle && /^제\d+조의\d+/u.test(line));
    if (art && forward && !PARTICLE.test(art[2]!)) {
      st.lastArticle = no; st.last = 0;
      const rest = art[2]!;
      const m = NUM_AHEAD.exec(rest);
      if (m && Number(m[1]) === 1) { st.last = 1; return `${art[1]} ① ${m[2]}`; }
      if (CIRCLED.includes([...rest][0] ?? "")) st.last = CIRCLED.indexOf([...rest][0]!) + 1;
      return rest ? `${art[1]} ${rest}` : art[1]!;
    }
    const first = [...line][0] ?? "";
    if (CIRCLED.includes(first)) { st.last = CIRCLED.indexOf(first) + 1; return line; }
    const m = NUM_AHEAD.exec(line);
    if (m && Number(m[1]) === st.last + 1 && st.last + 1 <= CIRCLED.length) { st.last++; return `${CIRCLED[st.last - 1]} ${m[2]}`; }
    return line;
  }).join("\n");
}

export interface OcrBox { text: string; bbox: number[] }
/** OCR 블록을 같은 줄끼리 묶는다 (세로 중심이 줄 높이 절반 안이면 같은 줄), 왼→오른·위→아래 순 */
export function ocrRows(blocks: OcrBox[]): string[] {
  return ocrRowsY(blocks).map((r) => r.text);
}
// ponytail: 좌우 분리 기준 (글자 높이 배수). 표처럼 칸이 넓은 줄은 표 변환(마크다운)이 따로 처리
const GAP_RATIO = 8;
/** 왼쪽 덩어리가 구조 머리(조·항·호·목·삭제)이거나 오른쪽이 꼬리표(<개정 …>, [본조신설 …], (…))면 떨어져 있어도 같은 글 (PR #39 리뷰) */
// 덩어리 전체가 머리일 때만 (예 "제1조(목적)", "1.", "제5조 삭제"). "1. 다운로드 자료실 접속" 같은 완결 문장은 해당 없음 (PR #39 재리뷰)
const HEAD = /^(제\s*\d+\s*조(?:\s*의\s*\d+)?(?:\s*\([^)]*\))?(?:\s*삭제)?|[①-⑳]|\d+\.|[가-힣]\.|삭제)$/u;
const TAIL = /^[<[(]/u;
/** ocrRows와 같지만 줄의 세로 위치(yc)도 돌려줌 (표를 제자리에 끼워 넣을 때) */
export function ocrRowsY(blocks: OcrBox[]): { yc: number; text: string }[] {
  const items = blocks.filter((b) => b.bbox?.length === 4)
    .map((b) => ({ t: b.text, x: b.bbox[0]!, x1: b.bbox[2]!, yc: (b.bbox[1]! + b.bbox[3]!) / 2, h: b.bbox[3]! - b.bbox[1]! })).sort((a, b) => a.yc - b.yc);
  const out: { yc: number; h: number; parts: typeof items }[] = [];
  for (const it of items) {
    const last = out.at(-1);
    if (last && Math.abs(it.yc - last.yc) < Math.max(last.h, it.h) / 2) last.parts.push(it); else out.push({ yc: it.yc, h: it.h, parts: [it] });
  }
  // 같은 줄이라도 글자 높이의 8배 넘게 떨어진 덩어리는 좌우로 나란한 다른 글(그림 설명 두 개 등)이라 " / "로 구분 (과천 12쪽 실측)
  // 간격은 앞에서 본 오른쪽 끝(최대 x1) 기준, 높이는 줄 안 최소 높이 (큰 덩어리 하나로 기준이 부풀지 않게)
  return out.map((r) => {
    const ps = r.parts.sort((a, b) => a.x - b.x);
    const h = Math.min(...ps.map((p) => p.h));
    let right = -Infinity;
    const text = ps.map((p, i) => {
      const sep = i > 0 && p.x - right > GAP_RATIO * h && !HEAD.test(ps[i - 1]!.t.trim()) && !TAIL.test(p.t.trim()) ? " / " : " ";
      right = Math.max(right, p.x1);
      return i === 0 ? p.t : `${sep}${p.t}`;
    }).join("");
    return { yc: r.yc, text };
  });
}
