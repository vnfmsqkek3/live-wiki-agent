// 단계 3a TextLayerExtract: 디지털 텍스트 추출 + 페이지별 OCR 필요 여부 (docs/04 1.1·1.3)
import { extractText, getDocumentProxy } from "unpdf";
import type { StepInput, StepOutput } from "@hanaeum/schemas";
import type { ObjectStore } from "./store.ts";

export interface TextLayerPage { page_index: number; text: string; char_count: number; broken_ratio: number; needs_ocr: boolean }
export interface TextLayer { doc_id: string; source_ext: string; page_count: number; pages: TextLayerPage[] }

// ponytail: 기준치 고정값, 실측 후 조정 (docs/04 1.3)
export const MIN_CHARS = 50;
export const MAX_BROKEN = 0.2;

const brokenRatio = (s: string) => {
  const chars = [...s.replace(/\s/gu, "")];
  if (!chars.length) return 0;
  return chars.filter((c) => c === "�" || /[\u0000-\u0008\u000E-\u001F]/u.test(c)).length / chars.length;
};

export function page(page_index: number, text: string, forceOcr = false): TextLayerPage {
  const char_count = text.replace(/\s/gu, "").length;
  const broken_ratio = brokenRatio(text);
  return { page_index, text, char_count, broken_ratio, needs_ocr: forceOcr || char_count < MIN_CHARS || broken_ratio > MAX_BROKEN };
}

export async function extractTextLayer(body: Buffer, ext: string, doc_id: string): Promise<TextLayer> {
  let pages: TextLayerPage[];
  switch (ext) {
    case "txt": case "md":
      pages = [page(0, body.toString("utf8"))];
      pages[0]!.needs_ocr = false; // 텍스트 파일은 OCR 대상 아님 (짧아도)
      break;
    case "pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(body));
      const { text } = await extractText(pdf, { mergePages: false });
      pages = text.map((t, i) => page(i, t));
      break;
    }
    case "png": case "jpg": case "jpeg":
      pages = [page(0, "", true)];
      break;
    default:
      // ponytail: DOCX·HWPX 구조 추출은 미구현. 조용히 빈 결과를 내지 않고 실패시킨다
      throw Object.assign(new Error(`지원하지 않는 형식: ${ext}`), { name: "UnsupportedFormat" });
  }
  if (!pages.length) throw new Error("페이지 0개");
  return { doc_id, source_ext: ext, page_count: pages.length, pages };
}

export async function textLayerStep(input: StepInput, store: ObjectStore): Promise<StepOutput> {
  const keys = await store.list(input.bucket, `${input.doc_id}/original.`);
  if (keys.length !== 1) throw new Error(`original 객체가 1개가 아님: ${keys.length}`);
  const ext = keys[0]!.split(".").pop()!.toLowerCase();
  const layer = await extractTextLayer(await store.get(input.bucket, keys[0]!), ext, input.doc_id);
  const output_key = `${input.doc_id}/work/text_layer.json`;
  await store.put(input.bucket, output_key, JSON.stringify(layer));
  return { status: "OK", output_key };
}
