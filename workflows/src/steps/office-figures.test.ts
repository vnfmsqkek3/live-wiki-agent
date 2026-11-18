import { createCanvas } from "@napi-rs/canvas";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeHandler, openPdf, type OcrTargets } from "./page-render.js";
import { officeFigures } from "./office-figures.js";

const png = (w: number, h: number) => { const c = createCanvas(w, h); c.getContext("2d").fillRect(0, 0, w, h); return new Uint8Array(c.toBuffer("image/png")); };
const p = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const pic = (id: string) => `<w:p><w:r><w:drawing><a:blip r:embed="${id}"/></w:drawing></w:r></w:p>`;
const brk = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;

// 1쪽: 글 + 사진, 2쪽: 빈 쪽(그림만) → office.ts 는 빈 쪽을 버리므로 1쪽에 붙음, 3쪽: 글 + EMF + 아이콘
function docx() {
  const body = p("SYNTHETIC 하나은행 가상 데이터") + pic("rId1") + brk + pic("rId2") + brk + p("3쪽 본문") + pic("rId3") + pic("rId4");
  const rels = ["rId1:media/image1.png", "rId2:media/image2.png", "rId3:media/image3.emf", "rId4:media/icon.png"]
    .map((x) => { const [id, t] = x.split(":"); return `<Relationship Id="${id}" Type="image" Target="${t}"/>`; }).join("");
  return zipSync({
    "word/document.xml": strToU8(`<w:document><w:body>${body}</w:body></w:document>`),
    "word/_rels/document.xml.rels": strToU8(`<Relationships>${rels}<Relationship Id="rId9" Target="http://x" TargetMode="External"/></Relationships>`),
    "word/media/image1.png": png(300, 200), "word/media/image2.png": png(120, 90),
    "word/media/image3.emf": new Uint8Array([1, 0, 0, 0, 9, 9]), "word/media/icon.png": png(16, 16),
  });
}

function hwpx() {
  const sec = (s: string) => strToU8(`<hs:sec>${s}</hs:sec>`);
  return zipSync({
    "Contents/section0.xml": sec(`<hp:p><hp:run><hp:t>1구역</hp:t></hp:run></hp:p><hp:p pageBreak="1"><hp:run><hp:t>2쪽</hp:t><hp:pic><hc:img binaryItemIDRef="image1"/></hp:pic></hp:run></hp:p>`),
    "Contents/section1.xml": sec(`<hp:p><hp:run><hp:t>3쪽(구역 2)</hp:t><hp:pic><hc:img binaryItemIDRef="image2"/></hp:pic></hp:run></hp:p>`),
    "Contents/content.hpf": strToU8(`<opf:package><opf:manifest><opf:item id="image1" href="BinData/image1.png" media-type="image/png"/><opf:item id="image2" href="BinData/image2.jpg"/></opf:manifest></opf:package>`),
    "BinData/image1.png": png(200, 100), "BinData/image2.jpg": png(64, 64),
  });
}

describe("officeFigures", () => {
  it("DOCX: maps images to text-layer page numbers (empty page folded into previous)", () => {
    expect(officeFigures(docx(), "docx").map((f) => [f.page_index, f.name])).toEqual([
      [0, "word/media/image1.png"], [0, "word/media/image2.png"], [1, "word/media/image3.emf"], [1, "word/media/icon.png"],
    ]);
  });
  it("HWPX: pageBreak and each section start a new page", () => {
    expect(officeFigures(hwpx(), "hwpx").map((f) => [f.page_index, f.name])).toEqual([[1, "BinData/image1.png"], [2, "BinData/image2.jpg"]]);
  });
});

describe("PageRender DOCX", () => {
  it("one PNG per page with figures; unsupported format → Finding with page; tiny icon skipped", async () => {
    const puts = new Map<string, Uint8Array | string>();
    const saved: unknown[] = [];
    const out = await makeHandler({
      findOriginal: async () => "doc_1/original.docx", get: async () => docx(), tryGet: async () => undefined,
      put: async (_b, k, body) => { puts.set(k, body); }, openPdf,
      saveFindings: async (_d, _s, f) => { saved.push(...f); },
    })({ workflow_id: "wf", doc_id: "doc_1", version: 1, bucket: "q", prefix: "doc_1/", actor: { sub: "a", groups: [] } });
    expect(out.status).toBe("REVIEW_REQUIRED");
    const t = JSON.parse(puts.get("doc_1/work/pages/ocr_targets.json") as string) as OcrTargets;
    expect(t.pages.map((x) => [x.page_index, x.reason, x.has_images, x.width])).toEqual([[0, "embedded_images", true, 300]]);
    expect(t.pages[0]!.height).toBe(200 + 24 + 90);
    expect(out.findings).toHaveLength(1);
    expect(out.findings![0]).toMatchObject({ code: "FIGURE_FORMAT_UNSUPPORTED", location: { page: 2 } });
    expect(out.findings![0]!.user_message).toContain("image3.emf");
    expect(saved).toHaveLength(1);
  });
});
