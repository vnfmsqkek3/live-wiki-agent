// 사용자 확인 13항: 문서 속 그림을 모델이 묘사하기 전, 페이지 이미지의 개인정보 구간을 검게 칠한다.
// 입력: 렌더 PNG(work/pages, 원본 등급) + OCR 블록 bbox. 출력 PNG(masked/pages)만 모델 호출 Role이 읽는다.
import { GUARD_SKIP } from './pii.ts';
import { PNG } from 'pngjs';
import { detectPii } from './pii-detect.ts';

export interface OcrBlock { text: string; bbox: [number, number, number, number] }
export interface OcrPage { page_index: number; width: number; height: number; blocks: OcrBlock[] }

/** 개인정보가 들어 있는 OCR 블록 bbox. 규칙(@hanaeum/pii) + (설정 시) Guardrails로 이름·주소까지.
 *  Guardrails는 블록을 한 번에 보내고, 탐지 값(match)이 들어 있는 블록을 가린다 */
export async function piiBoxes(page: OcrPage, guardrail?: (text: string) => Promise<{ text: string; entities?: { type: string; match: string }[] } | undefined>) {
  const hit = page.blocks.map((b) => detectPii(b.text).length > 0);
  if (guardrail && page.blocks.length) {
    // 이미지는 검게 칠해도 원문이 훼손되지 않으므로 Guardrail이 찾은 값이 든 블록은 모두 가린다
    const g = await guardrail(page.blocks.map((b) => b.text).join('\n'));
    // Guardrail의 IP·사용자명·전화·이메일 판정으로는 칠하지 않는다 (사용자 결정 11/17)
    const ms = (g?.entities ?? []).filter((e) => !GUARD_SKIP.has(e.type)).map((e) => e.match);
    page.blocks.forEach((b, i) => { if (ms.some((m) => b.text.includes(m))) hit[i] = true; });
  }
  return page.blocks.filter((_, i) => hit[i]).map((b) => b.bbox);
}

/** '개인정보' 글자 비트맵 (97×26, 1비트, 미리 그려 넣음: 글꼴 없이 PNG 위에 찍기 위해) */
const LABEL = { w: 97, h: 26, bits: Buffer.from('AAAAcAAA4AAA4AAAAAAHOAAAeAAAeAAAAAADnAPgPD/+PA8APB/xzgf8Hh//HgeAHg/45wf/Dw//jwPADwf8c4fHh4B4B4HgB4AOOcPB48A+H8D//8AHHOHAceAfH+B//+ADjnDgOPAfz/A8APADxzhwPHgP8HgeAHgBw/w8HjwPfDwPADwB4f4Pvh4fHx4HgB4A8P8H/g8fB48D//8A8HOA/geHAIeB//+A8DnAAAPCAAPAf//AeBzgAAHgA/gAAPAA+A5wHADwB/+AAHgA+Ac4DgB4D//wADwAeAOcBwAAB4B4AB4AGAHOA4AAB4AeH///gADnAcAAA8APD///wABzgOAAAeAPB///4AA5wH//wH//gAAAAAAc4D//4B//gAAAAAAAcB//8AP/AAAAAAAAAAAAAAAAAAAAAA==', 'base64') };
const labelOn = (x: number, y: number) => { const k = y * LABEL.w + x + (LABEL.bits.length * 8 - LABEL.w * LABEL.h); return (LABEL.bits[k >> 3]! >> (7 - (k & 7))) & 1; };
const GRAY = [200, 200, 200], INK = [85, 85, 85];

/** PNG의 박스 영역을 회색으로 완전히 덮고(투명도 없음) 가운데 '개인정보'를 쓴다. 칸이 작으면 글자는 생략 (사용자 결정 11/17: 블러는 복원 위험이라 제외).
 *  OCR 좌표계가 렌더 크기와 다르면 비율로 맞춘다. 함수 이름은 호출부 호환으로 유지 */
export function blackout(png: Uint8Array, boxes: [number, number, number, number][], ocrSize?: { width: number; height: number }, pad = 3): Uint8Array {
  const img = PNG.sync.read(Buffer.from(png));
  const sx = ocrSize?.width ? img.width / ocrSize.width : 1;
  const sy = ocrSize?.height ? img.height / ocrSize.height : 1;
  const put = (x: number, y: number, c: number[]) => { const i = (y * img.width + x) * 4; img.data[i] = c[0]!; img.data[i + 1] = c[1]!; img.data[i + 2] = c[2]!; img.data[i + 3] = 255; };
  for (const [x0, y0, x1, y1] of boxes) {
    const xa = Math.max(0, Math.floor(x0 * sx) - pad), xb = Math.min(img.width, Math.ceil(x1 * sx) + pad);
    const ya = Math.max(0, Math.floor(y0 * sy) - pad), yb = Math.min(img.height, Math.ceil(y1 * sy) + pad);
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) put(x, y, GRAY);
    // 글자: 칸 너비 85%·높이 60% 안에 맞춘 배율, 글자 높이 8px 미만이면 생략
    const k = Math.min(((xb - xa) * 0.85) / LABEL.w, ((yb - ya) * 0.6) / LABEL.h);
    if (LABEL.h * k < 8) continue;
    const lw = Math.floor(LABEL.w * k), lh = Math.floor(LABEL.h * k);
    const ox = xa + Math.floor((xb - xa - lw) / 2), oy = ya + Math.floor((yb - ya - lh) / 2);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) if (labelOn(Math.floor(x / k), Math.floor(y / k))) put(ox + x, oy + y, INK);
  }
  return new Uint8Array(PNG.sync.write(img));
}
