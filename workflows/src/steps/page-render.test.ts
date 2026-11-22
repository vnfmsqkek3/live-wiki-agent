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

function store(original: string, data: Uint8Array, converted?: Uint8Array) {
  const puts = new Map<string, Uint8Array | string>();
  return {
    puts,
    deps: {
      findOriginal: async () => original,
      get: async () => data,
      tryGet: async (_b: string, k: string) => (k.endsWith("/work/document.pdf") ? converted : undefined),
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
  it("renders ALL pages at 2000px, including the page with a text layer (사용자 결정 11/17: 전부 OCR)", async () => {
    const { puts, deps } = store("doc_1/original.pdf", pdfBytes());
    const out = await makeHandler(deps)(input);
    expect(out).toEqual({ status: "OK", output_key: "doc_1/work/pages/ocr_targets.json" });
    const t = JSON.parse(puts.get(out.output_key!) as string) as OcrTargets;
    expect(t.page_count).toBe(2);
    expect(t.pages.map((p) => [p.page_index, p.reason, p.has_images])).toEqual([[0, "all", false], [1, "all", false]]);
    expect(t.pages[0]!.width).toBe(2000);
    const png = puts.get("doc_1/work/pages/0001.png") as Uint8Array;
    expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    expect(puts.has("doc_1/work/pages/0000.png")).toBe(true);
  });

  it("also renders a text page that contains an image (photo/capture → OCR + ImageDescribe)", async () => {
    const { puts, deps } = store("doc_1/original.pdf", pdfBytes(true));
    const t = JSON.parse(puts.get((await makeHandler(deps)(input)).output_key!) as string) as OcrTargets;
    expect(t.pages.map((p) => [p.page_index, p.reason, p.has_images])).toEqual([[0, "all", true], [1, "all", false]]);
    expect(puts.has("doc_1/work/pages/0000.png")).toBe(true);
  });

  it("uses converted work/document.pdf when present (DOCX → PDF by ConvertToPdf)", async () => {
    const { puts, deps } = store("doc_1/original.docx", new Uint8Array([0x50, 0x4b]), pdfBytes(true));
    const t = JSON.parse(puts.get((await makeHandler(deps)(input)).output_key!) as string) as OcrTargets;
    expect(t.page_count).toBe(2);
    expect(t.pages.map((p) => [p.page_index, p.reason, p.has_images])).toEqual([[0, "all", true], [1, "all", false]]);
  });

  it("copies image original into work/pages (OCR role never reads original)", async () => {
    const { puts, deps } = store("doc_1/original.jpeg", new Uint8Array([1, 2]));
    await makeHandler(deps)(input);
    const t = JSON.parse(puts.get("doc_1/work/pages/ocr_targets.json") as string) as OcrTargets;
    expect(t.pages).toEqual([{ page_index: 0, key: "doc_1/work/pages/0000.jpg", width: 0, height: 0, reason: "image", has_images: true, graphics: true, scan: true }]);
    expect(puts.get("doc_1/work/pages/0000.jpg")).toEqual(new Uint8Array([1, 2]));
  });

  it("no OCR targets for docx", async () => {
    const { puts, deps } = store("doc_1/original.docx", new Uint8Array());
    await makeHandler(deps)(input);
    expect(JSON.parse(puts.get("doc_1/work/pages/ocr_targets.json") as string).pages).toEqual([]);
  });
});

// 쪽마다 본문 스트림을 받아 PDF 를 만든다 (graphics 판정은 실제 openPdf·pdfjs 인코딩을 거쳐야 의미가 있음, 인프라 리뷰 11/20)
function pdfPages(bodies: string[]): Uint8Array {
  const n = bodies.length;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${bodies.map((_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${n} >>`];
  bodies.forEach((_, i) => objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${3 + n + i} 0 R /Resources << /Font << /F1 ${3 + 2 * n} 0 R >> >> >>`));
  bodies.forEach((b) => objs.push(`<< /Length ${b.length} >>\nstream\n${b}\nendstream`));
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let s = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}

describe("graphics 신호 (그림으로 인식 안 된 쪽의 서명·명함, 총괄 11/20)", () => {
  const TEXT = "BT /F1 10 Tf 20 800 Td (SYNTHETIC Hana Bank virtual data) Tj ET ";
  const curves = (k: number) => "2 w 100 400 m " + Array.from({ length: k }, (_, i) => `${110 + i * 20} ${380 + (i % 2) * 40} ${120 + i * 20} ${420 - (i % 2) * 40} ${130 + i * 20} 400 c`).join(" ") + " S";
  const IMG = " q 100 0 0 100 20 600 cm BI /W 1 /H 1 /CS /G /BPC 8 ID A EI Q";
  it("직선 표 false · 곡선 8개 서명 true · 둥근 상자(곡선 4개) false · 글자 있는 쪽의 이미지 true · 글자 없는 이미지 쪽(스캔) false", async () => {
    const pdf = await openPdf(pdfPages([
      TEXT + "20 600 500 150 re S 20 650 m 520 650 l S 20 700 m 520 700 l S", // 직선 표
      TEXT + curves(8),                                                       // 선 그림 서명
      TEXT + curves(4),                                                       // 둥근 상자 정도
      TEXT + IMG,                                                             // 디지털 문서 속 서명·명함 그림
      IMG.trim(),                                                             // 스캔 쪽 (글자 층 없음)
    ]));
    const got = [];
    for (let i = 0; i < pdf.pageCount; i++) got.push(await pdf.inspect(i));
    expect(got).toEqual([
      { has_images: false, graphics: false, scan: false }, { has_images: false, graphics: true, scan: false }, { has_images: false, graphics: false, scan: false },
      { has_images: true, graphics: true, scan: false }, { has_images: true, graphics: false, scan: true },
    ]);
  });
  it("ocr_targets.json 모든 쪽에 graphics 명시", async () => {
    const { puts, deps } = store("doc_1/original.pdf", pdfPages(["BT /F1 10 Tf 20 800 Td (a) Tj ET 100 400 m " + "110 380 120 420 130 400 c ".repeat(8) + "S", "BT /F1 10 Tf 20 800 Td (b) Tj ET"]));
    const out = await makeHandler(deps)(input);
    const t = JSON.parse(puts.get(out.output_key!) as string) as OcrTargets;
    expect(t.pages.map((p) => [p.graphics, p.scan])).toEqual([[true, false], [false, false]]);
  });
});
