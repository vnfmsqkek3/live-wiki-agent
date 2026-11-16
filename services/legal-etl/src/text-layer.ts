// 단계 3a TextLayerExtract: 디지털 텍스트 추출 + 페이지별 OCR 필요 여부 (docs/04 1.1·1.3)
import { extractText, getDocumentProxy } from "unpdf";
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
    case "docx": case "hwpx":
      // 디지털 문서라 OCR 대상 아님. 문서 속 그림은 텍스트가 없으므로 페이지 이미지 파이프라인에서 다룬다
      pages = (ext === "docx" ? docxPages(body) : hwpxPages(body)).map((t, i) => ({ ...page(i, t), needs_ocr: false }));
      break;
    case "png": case "jpg": case "jpeg":
      pages = [page(0, "", true)];
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
  let layer: TextLayer;
  try { layer = await extractTextLayer(await store.get(input.bucket, keys[0]!), ext, input.doc_id); }
  catch (e) { const p = fileProblem(e, ext, keys[0]!); if (p) return p; throw e; }
  const output_key = `${input.doc_id}/work/text_layer.json`;
  await store.put(input.bucket, output_key, JSON.stringify(layer));
  // 스캔 쪽 안내 (디지털 글자 없음 → OCR). PDF에서만: 이미지 파일은 전부 OCR이 당연
  const scanned = ext === "pdf" ? layer.pages.filter((p) => p.needs_ocr) : [];
  const findings = scanned.slice(0, 10).map((p) => finding("SCANNED_PAGE", "LOW",
    `${p.page_index + 1}쪽은 글자 정보가 없는 이미지(스캔)라 문자 인식(OCR)으로 읽습니다. 인식 오류가 있을 수 있습니다.`,
    "가능하면 원본 문서를 'PDF로 저장'해 글자가 선택되는 PDF로 올려 주세요.", output_key, p.page_index + 1));
  return { status: "OK", output_key, ...(findings.length ? { findings } : {}) };
}
