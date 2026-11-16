// 단계 3b PageRender (docs/04 1.1·1.3, Owner yoyo0704).
// 텍스트 레이어가 부족한 페이지와 이미지(사진·캡처·도표)가 든 페이지를 PNG(가로 2000px)로 렌더링하고 OCR 대상 목록을 만든다.
// 기준: 페이지 글자 수 < 50 또는 깨진 문자 비율 > 20% (실측 후 조정), 또는 이미지 그리기 연산이 있음.
// 이미지 페이지는 OCR(이미지 속 글자·bbox) → PiiScan 마스킹 이미지 → ImageDescribe(묘사·의도) 로 이어진다 (13항 13).
// 출력: {doc_id}/work/pages/{nnnn}.png, {doc_id}/work/pages/ocr_targets.json
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StepInput, StepOutput } from "./common.js";

export const MIN_CHARS = 50;
export const MAX_BROKEN_RATIO = 0.2;
export const RENDER_WIDTH = 2000;

export type OcrTarget = { page_index: number; key: string; width: number; height: number; reason: string; has_images: boolean };
export type OcrTargets = { doc_id: string; page_count: number; pages: OcrTarget[] };

// U+FFFD(대체 문자), 제어문자, 사설 영역 = 깨진 문자
export function needsOcr(text: string): string | undefined {
  const chars = [...text.replace(/\s/g, "")];
  if (chars.length < MIN_CHARS) return `chars<${MIN_CHARS}`;
  // eslint-disable-next-line no-control-regex -- 제어문자 검출이 목적
  const broken = chars.filter((c) => /[�\u0000-\u001F-]/u.test(c)).length;
  if (broken / chars.length > MAX_BROKEN_RATIO) return `broken>${MAX_BROKEN_RATIO}`;
  return undefined;
}

type NapiCanvas = HTMLCanvasElement & { toBuffer: (mime: "image/png") => Uint8Array };
type Rendered = { png: Uint8Array; width: number; height: number };
export type Pdf = {
  pageCount: number;
  pageText: (i: number) => Promise<string>;
  hasImages: (i: number) => Promise<boolean>;
  render: (i: number) => Promise<Rendered>;
};

export async function openPdf(data: Uint8Array): Promise<Pdf> {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const imageOps = new Set<number>([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat]);
  const doc = await getDocument({ data, disableFontFace: true }).promise;
  return {
    pageCount: doc.numPages,
    pageText: async (i) => {
      const tc = await (await doc.getPage(i + 1)).getTextContent();
      return tc.items.map((it) => ("str" in it ? it.str : "")).join("");
    },
    hasImages: async (i) => (await (await doc.getPage(i + 1)).getOperatorList()).fnArray.some((f) => imageOps.has(f)),
    render: async (i) => {
      const page = await doc.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: RENDER_WIDTH / base.width });
      // pdfjs 타입은 canvasFactory 를 object 로만 선언 (Node 에서는 @napi-rs/canvas 기반 NodeCanvasFactory)
      const factory = doc.canvasFactory as { create: (w: number, h: number) => { canvas: NapiCanvas; context: CanvasRenderingContext2D } };
      const { canvas, context } = factory.create(Math.round(viewport.width), Math.round(viewport.height));
      await page.render({ canvasContext: context, canvas, viewport }).promise;
      return { png: canvas.toBuffer("image/png"), width: canvas.width, height: canvas.height };
    },
  };
}

export type Deps = {
  findOriginal: (bucket: string, doc_id: string) => Promise<string | undefined>;
  get: (bucket: string, key: string) => Promise<Uint8Array>;
  put: (bucket: string, key: string, body: Uint8Array | string, contentType: string) => Promise<void>;
  openPdf: (data: Uint8Array) => Promise<Pdf>;
};

export function makeHandler(d: Deps) {
  return async (e: StepInput): Promise<StepOutput> => {
    const key = await d.findOriginal(e.bucket, e.doc_id);
    if (!key) throw new Error(`OriginalNotFound: ${e.doc_id}`);
    const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
    const pagesDir = `${e.doc_id}/work/pages`;
    const out: OcrTargets = { doc_id: e.doc_id, page_count: 0, pages: [] };

    if (ext === "pdf") {
      const pdf = await d.openPdf(await d.get(e.bucket, key));
      out.page_count = pdf.pageCount;
      for (let i = 0; i < pdf.pageCount; i++) {
        const has_images = await pdf.hasImages(i);
        const reason = needsOcr(await pdf.pageText(i)) ?? (has_images ? "images" : undefined);
        if (!reason) continue;
        const r = await pdf.render(i);
        const pk = `${pagesDir}/${String(i).padStart(4, "0")}.png`;
        await d.put(e.bucket, pk, r.png, "image/png");
        out.pages.push({ page_index: i, key: pk, width: r.width, height: r.height, reason, has_images });
      }
    } else if (ext === "png" || ext === "jpg" || ext === "jpeg") {
      // 이미지는 work/pages/ 로 복사해 OCR 대상으로. OCR(SageMaker) Role 은 원본 경로를 읽지 않는다
      out.page_count = 1;
      const pk = `${pagesDir}/0000.${ext === "jpeg" ? "jpg" : ext}`;
      await d.put(e.bucket, pk, await d.get(e.bucket, key), ext === "png" ? "image/png" : "image/jpeg");
      out.pages.push({ page_index: 0, key: pk, width: 0, height: 0, reason: "image", has_images: true });
    }
    // docx·hwpx 는 구조화 텍스트만 쓰므로 OCR 대상 없음 (TextLayerExtract, let522mj)

    const output_key = `${pagesDir}/ocr_targets.json`;
    await d.put(e.bucket, output_key, JSON.stringify(out), "application/json");
    return { status: "OK", output_key };
  };
}

const s3 = new S3Client({});
export const handler = makeHandler({
  findOriginal: async (bucket, doc_id) =>
    (await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${doc_id}/original.`, MaxKeys: 1 }))).Contents?.[0]?.Key,
  get: async (bucket, key) => (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray(),
  put: async (bucket, key, body, contentType) => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: "aws:kms" }));
  },
  openPdf,
});
