// 단계 3a TextLayerExtract: 쪽 수와 쪽별 OCR 여부 (docs/04 1.1·1.3)
// 사용자 결정 11/17: PDF·이미지·DOCX·HWPX는 디지털 글자를 추출하지 않고 모든 쪽을 OCR한다
// (디지털 글자는 깨지거나 다른 글자로 바뀌어 있을 수 있고, 섞인 쪽의 사진 속 글자·숨긴 글자 문제도 OCR 본문이면 생기지 않음).
// ConvertToPdf(yoyo0704)가 만든 {doc}/work/document.pdf가 있으면 그 쪽 수를 쓴다. TXT·MD만 글자를 그대로 읽는다.
import { getDocumentProxy } from "unpdf";
import { newId } from "@hanaeum/schemas";
import type { Finding, StepInput, StepOutput } from "@hanaeum/schemas";
import type { ObjectStore } from "./store.ts";
import { docxPages, hwpxPages } from "./office.ts";

export interface TextLayerPage { page_index: number; text: string; char_count: number; broken_ratio: number; needs_ocr: boolean }
export interface TextLayer { doc_id: string; source_ext: string; page_count: number; pages: TextLayerPage[] }

// ponytail: 기준치 고정값, 실측 후 조정 (docs/04 1.3)
export const MIN_CHARS = 50;
export const MAX_BROKEN = 0.2;

const brokenRatio = (s: string) => {
  const chars = [...s.replace(/\s/gu, "")];
  if (!chars.length) return 0;
  // 깨진 문자: 대체 문자(U+FFFD) 또는 탭·줄바꿈 외 제어 문자
  const broken = (c: string) => { const n = c.codePointAt(0)!; return n === 0xfffd || n <= 0x08 || (n >= 0x0e && n <= 0x1f); };
  return chars.filter(broken).length / chars.length;
};

export function page(page_index: number, text: string, forceOcr = false): TextLayerPage {
  const char_count = text.replace(/\s/gu, "").length;
  const broken_ratio = brokenRatio(text);
  return { page_index, text, char_count, broken_ratio, needs_ocr: forceOcr || char_count < MIN_CHARS || broken_ratio > MAX_BROKEN };
}

/** 모든 쪽 OCR 대상 (글자는 비움) */
const ocrPages = (n: number): TextLayerPage[] => Array.from({ length: n }, (_, i) => page(i, "", true));
const pdfPageCount = async (b: Buffer) => (await getDocumentProxy(new Uint8Array(b))).numPages;

/** converted: ConvertToPdf 결과(document.pdf). DOCX·HWPX는 이것이 없을 때만(변환 단계 배포 전) 지금처럼 XML 글자를 쓴다 */
export async function extractTextLayer(body: Buffer, ext: string, doc_id: string, converted?: Buffer): Promise<TextLayer> {
  let pages: TextLayerPage[];
  switch (ext) {
    case "txt": case "md":
      pages = [page(0, body.toString("utf8"))];
      pages[0]!.needs_ocr = false; // 텍스트 파일은 OCR 대상 아님 (짧아도)
      break;
    case "pdf":
      pages = ocrPages(await pdfPageCount(converted ?? body)); // 원본 PDF도 열어 본다 (암호·손상은 여기서 사유와 함께 차단)
      break;
    case "docx": case "hwpx":
      if (converted) { pages = ocrPages(await pdfPageCount(converted)); break; }
      // ponytail: ConvertToPdf 배포 전 호환 경로. 배포되면 지운다
      pages = (ext === "docx" ? docxPages(body) : hwpxPages(body)).map((t, i) => ({ ...page(i, t), needs_ocr: false }));
      break;
    case "png": case "jpg": case "jpeg":
      pages = converted ? ocrPages(await pdfPageCount(converted)) : ocrPages(1);
      break;
    default:
      // 허용 목록 밖 형식: 조용히 빈 결과를 내지 않고 실패시킨다
      throw Object.assign(new Error(`지원하지 않는 형식: ${ext}`), { name: "UnsupportedFormat" });
  }
  if (!pages.length) throw Object.assign(new Error("페이지 0개"), { name: "EmptyDocument" });
  return { doc_id, source_ext: ext, page_count: pages.length, pages };
}

const finding = (code: string, severity: Finding["severity"], user_message: string, fix_hint: string, evidence_ref: string, page?: number): Finding => ({
  finding_id: newId("fnd"), step: "TextLayerExtract", severity, code, message: user_message, evidence_ref,
  ...(page ? { location: { page } } : {}), user_message, fix_hint,
});

/** 파일 자체 문제(형식·손상·암호)는 예외 대신 BLOCKED + 올린 사람용 사유·조치 (사용자 지시 11/17) */
function fileProblem(e: unknown, ext: string, key: string): StepOutput | undefined {
  const n = (e as Error).name;
  const block = (code: string, msg: string, fix: string): StepOutput => ({ status: "BLOCKED", findings: [finding(code, "HIGH", msg, fix, key)] });
  if (n === "UnsupportedFormat") return block("UNSUPPORTED_FORMAT", `.${ext} 형식은 등록할 수 없습니다.`, "PDF·DOCX·HWPX·PNG·JPG 중 하나로 저장해 다시 올려 주세요.");
  if (n === "PasswordException") return block("ENCRYPTED_PDF", "암호가 걸린 PDF라 내용을 읽을 수 없습니다.", "PDF 암호를 해제한 뒤 다시 올려 주세요.");
  if (ext === "pdf" && /InvalidPDF|FormatError|UnknownError/u.test(n)) return block("CORRUPT_PDF", "PDF 파일 구조가 손상되어 열 수 없습니다.", "원본 프로그램에서 'PDF로 저장'으로 다시 만든 뒤 올려 주세요.");
  if (ext === "docx" || ext === "hwpx") return block("CORRUPT_OFFICE", `${ext.toUpperCase()} 파일이 손상됐거나 본문이 없습니다.`, "원본 프로그램에서 다시 저장하거나 PDF로 저장해 올려 주세요.");
  if (n === "EmptyDocument") return block("EMPTY_DOCUMENT", "문서에 쪽이 하나도 없습니다.", "내용이 있는 원본 파일을 올려 주세요.");
  return undefined;
}

export async function textLayerStep(input: StepInput, store: ObjectStore): Promise<StepOutput> {
  const keys = await store.list(input.bucket, `${input.doc_id}/original.`);
  if (keys.length !== 1) throw new Error(`original 객체가 1개가 아님: ${keys.length}`);
  const ext = keys[0]!.split(".").pop()!.toLowerCase();
  const convKey = `${input.doc_id}/work/document.pdf`;
  const converted = (await store.list(input.bucket, convKey)).includes(convKey) ? await store.get(input.bucket, convKey) : undefined;
  let layer: TextLayer;
  try { layer = await extractTextLayer(await store.get(input.bucket, keys[0]!), ext, input.doc_id, converted); }
  catch (e) { const p = fileProblem(e, ext, keys[0]!); if (p) return p; throw e; }
  const output_key = `${input.doc_id}/work/text_layer.json`;
  await store.put(input.bucket, output_key, JSON.stringify(layer));
  return { status: "OK", output_key };
}
