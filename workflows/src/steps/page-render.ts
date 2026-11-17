// 단계 3b PageRender (docs/04 1.1·1.3, Owner yoyo0704).
// 텍스트 레이어가 부족한 페이지와 이미지(사진·캡처·도표)가 든 페이지를 PNG(가로 2000px)로 렌더링하고 OCR 대상 목록을 만든다.
// 11/17 사용자 결정 이후: work/document.pdf(ConvertToPdf) 또는 원본 PDF 의 모든 쪽을 렌더링(reason "all"). 아래 needsOcr 기준은 TextLayerExtract 호환용으로만 남김.
// 이미지 페이지는 OCR(이미지 속 글자·bbox) → PiiScan 마스킹 이미지 → ImageDescribe(묘사·의도) 로 이어진다 (13항 13).
// DOCX·HWPX 는 본문 글은 구조화 텍스트(TextLayerExtract)로 쓰고, 안에 든 그림만 쪽별로 세로로 이어 붙여 PNG 한 장으로 만든다
//   → 같은 OCR → PiiScan 마스킹 → ImageDescribe 경로 (사용자 결정 11/17). 분석할 수 없는 형식(EMF·WMF 등)은 Finding 으로 알린다.
// 출력: {doc_id}/work/pages/{nnnn}.png, {doc_id}/work/pages/ocr_targets.json
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { finding, type Finding, type StepInput, type StepOutput } from "./common.js";
import { findingsStore, type FindingsStore } from "./findings-store.js";
import { officeFigures, type OfficeFigure } from "./office-figures.js";

export const STEP = "PageRender";
export const MIN_FIGURE_PX = 48; // ponytail: 이보다 작은 그림(글머리 아이콘·구분선)은 분석하지 않음. 놓치는 그림이 보고되면 낮춤

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

// 한 쪽의 그림들을 세로로 이어 붙인 PNG (가로 최대 RENDER_WIDTH). 읽을 수 없는 형식·아주 작은 그림은 skipped
export async function composeFigures(figs: OfficeFigure[]): Promise<{ rendered?: Rendered; skipped: { name: string; reason: "format" | "small" }[] }> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const imgs: Awaited<ReturnType<typeof loadImage>>[] = [];
  const skipped: { name: string; reason: "format" | "small" }[] = [];
  for (const f of figs) {
    try {
      const img = await loadImage(Buffer.from(f.data));
      if (img.width < MIN_FIGURE_PX || img.height < MIN_FIGURE_PX) skipped.push({ name: f.name, reason: "small" });
      else imgs.push(img);
    } catch { skipped.push({ name: f.name, reason: "format" }); }
  }
  if (!imgs.length) return { skipped };
  const width = Math.min(RENDER_WIDTH, Math.max(...imgs.map((i) => i.width)));
  const GAP = 24;
  const sizes = imgs.map((i) => { const s = Math.min(1, width / i.width); return [Math.round(i.width * s), Math.round(i.height * s)] as const; });
  const height = sizes.reduce((h, [, ih]) => h + ih + GAP, -GAP);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  imgs.forEach((img, k) => { const [w, h] = sizes[k]!; ctx.drawImage(img, 0, y, w, h); y += h + GAP; });
  return { rendered: { png: new Uint8Array(canvas.toBuffer("image/png")), width, height }, skipped };
}

export type Deps = {
  saveFindings?: FindingsStore;
  findOriginal: (bucket: string, doc_id: string) => Promise<string | undefined>;
  get: (bucket: string, key: string) => Promise<Uint8Array>;
  /** 없으면 undefined (ConvertToPdf 결과 work/document.pdf 확인용) */
  tryGet: (bucket: string, key: string) => Promise<Uint8Array | undefined>;
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
    const findings: Finding[] = [];

    // 사용자 결정 11/17 "모든 형식을 PDF 로 변환한 뒤 전부 OCR": ConvertToPdf 결과(work/document.pdf), 없으면 원본 PDF 의 **모든 쪽** 렌더링.
    // 텍스트 레이어는 쓰지 않는다(디지털 글자가 다른 글자로 바뀐 경우·섞인 쪽의 사진 속 글자·숨긴 글자를 텍스트 레이어로는 못 잡음, let522mj dev 실측)
    const converted = await d.tryGet(e.bucket, `${e.doc_id}/work/document.pdf`);
    if (converted || ext === "pdf") {
      const pdf = await d.openPdf(converted ?? await d.get(e.bucket, key));
      out.page_count = pdf.pageCount;
      for (let i = 0; i < pdf.pageCount; i++) {
        const has_images = await pdf.hasImages(i);
        const reason = "all";
        const r = await pdf.render(i);
        const pk = `${pagesDir}/${String(i).padStart(4, "0")}.png`;
        await d.put(e.bucket, pk, r.png, "image/png");
        out.pages.push({ page_index: i, key: pk, width: r.width, height: r.height, reason, has_images });
      }
    } else if (ext === "png" || ext === "jpg" || ext === "jpeg") {
      // (ConvertToPdf 배포 전 호환) 이미지는 work/pages/ 로 복사해 OCR 대상으로. OCR(SageMaker) Role 은 원본 경로를 읽지 않는다
      out.page_count = 1;
      const pk = `${pagesDir}/0000.${ext === "jpeg" ? "jpg" : ext}`;
      await d.put(e.bucket, pk, await d.get(e.bucket, key), ext === "png" ? "image/png" : "image/jpeg");
      out.pages.push({ page_index: 0, key: pk, width: 0, height: 0, reason: "image", has_images: true });
    } else if (ext === "docx" || ext === "hwpx") {
      // (ConvertToPdf 가 변환하지 못한 경우 호환) 본문 글은 TextLayerExtract(let522mj). 여기서는 그림만. 손상 파일은 TextLayerExtract 가 차단 사유로 안내
      let figs: OfficeFigure[] = [];
      try { figs = officeFigures(await d.get(e.bucket, key), ext); } catch { /* 손상 ZIP: TextLayerExtract CORRUPT_OFFICE */ }
      const byPage = new Map<number, OfficeFigure[]>();
      for (const f of figs) byPage.set(f.page_index, [...(byPage.get(f.page_index) ?? []), f]);
      out.page_count = byPage.size ? Math.max(...byPage.keys()) + 1 : 0;
      for (const [i, list] of [...byPage].sort((a, b) => a[0] - b[0])) {
        const { rendered: r, skipped } = await composeFigures(list);
        const bad = skipped.filter((s) => s.reason === "format");
        if (bad.length) {
          const names = bad.map((s) => s.name.slice(s.name.lastIndexOf("/") + 1)).join(", ");
          findings.push(finding(STEP, "MEDIUM", "FIGURE_FORMAT_UNSUPPORTED", `${i + 1}쪽 그림 ${bad.length}개 형식 미지원(${names})`, `${e.doc_id}/original.${ext}#page=${i + 1}`, {
            location: { page: i + 1 },
            user_message: `${i + 1}쪽 그림 ${bad.length}개(${names})는 형식(EMF·WMF 등)을 읽을 수 없어 AI 그림 분석과 그림 속 개인정보 확인에서 빠졌습니다. 검토자가 직접 확인합니다.`,
            fix_hint: "원본 프로그램에서 그림을 PNG·JPG로 바꿔 넣거나, 문서를 PDF로 저장해 올리면 그림까지 분석됩니다.",
          }));
        }
        if (!r) continue;
        const pk = `${pagesDir}/${String(i).padStart(4, "0")}.png`;
        await d.put(e.bucket, pk, r.png, "image/png");
        out.pages.push({ page_index: i, key: pk, width: r.width, height: r.height, reason: "embedded_images", has_images: true });
      }
    }

    const output_key = `${pagesDir}/ocr_targets.json`;
    await d.put(e.bucket, output_key, JSON.stringify(out), "application/json");
    await d.saveFindings?.(e.doc_id, STEP, findings);
    return { status: findings.length ? "REVIEW_REQUIRED" : "OK", output_key, ...(findings.length ? { findings } : {}) };
  };
}

const s3 = new S3Client({});
export const handler = makeHandler({
  saveFindings: findingsStore(),
  findOriginal: async (bucket, doc_id) =>
    (await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${doc_id}/original.`, MaxKeys: 1 }))).Contents?.[0]?.Key,
  get: async (bucket, key) => (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray(),
  tryGet: async (bucket, key) => {
    try { return await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray(); }
    catch (err) { if ((err as { name?: string }).name === "NoSuchKey") return undefined; throw err; }
  },
  put: async (bucket, key, body, contentType) => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: "aws:kms" }));
  },
  openPdf,
});
