import { describe, expect, it } from "vitest";
import { makeHandler, needsOcr, openPdf, type OcrTargets } from "./page-render.js";

// 2페이지 PDF: 1쪽은 텍스트 레이어 충분(withImage 면 1x1 인라인 이미지도 그림), 2쪽은 빈 페이지(스캔본 가정)
function pdfBytes(withImage = false): Uint8Array {
  const text = "SYNTHETIC Hana Bank (virtual data) loan regulation article 12 approval criteria text layer page";
  const body = `BT /F1 10 Tf 20 800 Td (${text}) Tj ET` + (withImage ? " q 100 0 0 100 20 600 cm BI /W 1 /H 1 /CS /G /BPC 8 ID A EI Q" : "");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 7 0 R >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let s = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}

const input = { workflow_id: "wf_1", doc_id: "doc_1", version: 1, bucket: "q", prefix: "doc_1/", actor: { sub: "a", groups: ["AUTHOR"] } };

function store(original: string, data: Uint8Array) {
  const puts = new Map<string, Uint8Array | string>();
  return {
    puts,
    deps: {
      findOriginal: async () => original,
      get: async () => data,
      put: async (_b: string, k: string, body: Uint8Array | string) => { puts.set(k, body); },
      openPdf,
    },
  };
}

describe("needsOcr", () => {
  it("flags short text", () => expect(needsOcr("짧은 글")).toMatch(/chars/));
  it("flags broken text", () => expect(needsOcr("�".repeat(30) + "가".repeat(60))).toMatch(/broken/));
  it("accepts normal text", () => expect(needsOcr("가".repeat(60))).toBeUndefined());
});

describe("PageRender", () => {
  it("renders only the page without text layer at 2000px", async () => {
    const { puts, deps } = store("doc_1/original.pdf", pdfBytes());
    const out = await makeHandler(deps)(input);
    expect(out).toEqual({ status: "OK", output_key: "doc_1/work/pages/ocr_targets.json" });
    const t = JSON.parse(puts.get(out.output_key!) as string) as OcrTargets;
    expect(t.page_count).toBe(2);
    expect(t.pages.map((p) => [p.page_index, p.reason, p.has_images])).toEqual([[1, "chars<50", false]]);
    expect(t.pages[0]!.width).toBe(2000);
    const png = puts.get("doc_1/work/pages/0001.png") as Uint8Array;
    expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    expect(puts.has("doc_1/work/pages/0000.png")).toBe(false);
  });

  it("also renders a text page that contains an image (photo/capture → OCR + ImageDescribe)", async () => {
    const { puts, deps } = store("doc_1/original.pdf", pdfBytes(true));
    const t = JSON.parse(puts.get((await makeHandler(deps)(input)).output_key!) as string) as OcrTargets;
    expect(t.pages.map((p) => [p.page_index, p.reason, p.has_images])).toEqual([[0, "images", true], [1, "chars<50", false]]);
    expect(puts.has("doc_1/work/pages/0000.png")).toBe(true);
  });

  it("copies image original into work/pages (OCR role never reads original)", async () => {
    const { puts, deps } = store("doc_1/original.jpeg", new Uint8Array([1, 2]));
    await makeHandler(deps)(input);
    const t = JSON.parse(puts.get("doc_1/work/pages/ocr_targets.json") as string) as OcrTargets;
    expect(t.pages).toEqual([{ page_index: 0, key: "doc_1/work/pages/0000.jpg", width: 0, height: 0, reason: "image", has_images: true }]);
    expect(puts.get("doc_1/work/pages/0000.jpg")).toEqual(new Uint8Array([1, 2]));
  });

  it("no OCR targets for docx", async () => {
    const { puts, deps } = store("doc_1/original.docx", new Uint8Array());
    await makeHandler(deps)(input);
    expect(JSON.parse(puts.get("doc_1/work/pages/ocr_targets.json") as string).pages).toEqual([]);
  });
});
