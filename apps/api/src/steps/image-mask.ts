// 사용자 확인 13항: 문서 속 그림을 모델이 묘사하기 전, 페이지 이미지의 개인정보 구간을 검게 칠한다.
// 입력: 렌더 PNG(work/pages, 원본 등급) + OCR 블록 bbox. 출력 PNG(masked/pages)만 모델 호출 Role이 읽는다.
import { PNG } from 'pngjs';
import { detectPii } from './pii-detect.ts';

export interface OcrBlock { text: string; bbox: [number, number, number, number] }
export interface OcrPage { page_index: number; width: number; height: number; blocks: OcrBlock[] }

/** 개인정보가 들어 있는 OCR 블록 bbox */
export const piiBoxes = (page: OcrPage) => page.blocks.filter((b) => detectPii(b.text).length > 0).map((b) => b.bbox);

/** PNG의 박스 영역을 검게 칠한다 (여백 pad px). OCR 좌표계가 렌더 크기와 다르면 비율로 맞춘다 */
export function blackout(png: Uint8Array, boxes: [number, number, number, number][], ocrSize?: { width: number; height: number }, pad = 3): Uint8Array {
  const img = PNG.sync.read(Buffer.from(png));
  const sx = ocrSize?.width ? img.width / ocrSize.width : 1;
  const sy = ocrSize?.height ? img.height / ocrSize.height : 1;
  for (const [x0, y0, x1, y1] of boxes) {
    const xa = Math.max(0, Math.floor(x0 * sx) - pad), xb = Math.min(img.width, Math.ceil(x1 * sx) + pad);
    const ya = Math.max(0, Math.floor(y0 * sy) - pad), yb = Math.min(img.height, Math.ceil(y1 * sy) + pad);
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(img));
}
