import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { imageToPdf, makeHandler, pageCount, type Deps, type Finding } from "./handler.ts";

const input = { workflow_id: "wf_1", doc_id: "doc_1", version: 1, bucket: "q", prefix: "doc_1/", actor: { sub: "a", groups: [] } };
// 1x1 PNG
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
async function pdfOf(n: number) { const p = await PDFDocument.create(); for (let i = 0; i < n; i++) p.addPage(); return p.save(); }

function deps(original: string, data: Uint8Array, office?: Deps["office"]) {
  const objects = new Map<string, Uint8Array>([[original, data]]);
  const saved: Finding[][] = [];
  const d: Deps = {
    findOriginal: async () => original, get: async (_b, k) => objects.get(k)!,
    copy: async (_b, f, t) => { objects.set(t, objects.get(f)!); }, put: async (_b, k, b) => { objects.set(k, b); },
    office: office ?? (async () => pdfOf(2)), saveFindings: async (_d, _s, f) => { saved.push(f); }, newId: () => "01TEST",
  };
  return { d, objects, saved };
}

describe("ConvertToPdf", () => {
  it("PDF is copied as-is to work/document.pdf", async () => {
    const src = await pdfOf(3);
    const { d, objects } = deps("doc_1/original.pdf", src);
    expect(await makeHandler(d)(input)).toEqual({ status: "OK", output_key: "doc_1/work/document.pdf" });
    expect(objects.get("doc_1/work/document.pdf")).toBe(src);
  });
  it("PNG becomes a 1-page PDF of the image size", async () => {
    expect(await pageCount(await imageToPdf(PNG, "png"))).toBe(1);
    const { d, objects } = deps("doc_1/original.png", PNG);
    expect((await makeHandler(d)(input)).status).toBe("OK");
    expect(await pageCount(objects.get("doc_1/work/document.pdf")!)).toBe(1);
  });
  it("DOCX goes through LibreOffice", async () => {
    const { d, objects } = deps("doc_1/original.docx", new Uint8Array([0x50, 0x4b]));
    expect((await makeHandler(d)(input)).output_key).toBe("doc_1/work/document.pdf");
    expect(await pageCount(objects.get("doc_1/work/document.pdf")!)).toBe(2);
  });
  it("DOCX conversion failure → BLOCKED with a readable reason", async () => {
    const { d, saved } = deps("doc_1/original.docx", new Uint8Array([1]), async () => { throw new Error("ENOENT in.pdf"); });
    const out = await makeHandler(d)(input);
    expect(out.status).toBe("BLOCKED");
    expect(out.findings![0]).toMatchObject({ code: "CONVERT_FAILED", severity: "HIGH" });
    expect(out.findings![0]!.user_message).toContain("PDF");
    expect(saved[0]).toHaveLength(1);
  });
  it("HWPX conversion failure → OK without document.pdf (기존 XML 방식으로 계속)", async () => {
    const { d, objects } = deps("doc_1/original.hwpx", new Uint8Array([1]), async () => { throw new Error("no filter"); });
    expect(await makeHandler(d)(input)).toEqual({ status: "OK" });
    expect(objects.has("doc_1/work/document.pdf")).toBe(false);
  });
  it("TXT is not converted", async () => {
    const { d, objects } = deps("doc_1/original.txt", new Uint8Array([65]));
    expect(await makeHandler(d)(input)).toEqual({ status: "OK" });
    expect(objects.size).toBe(1);
  });
  it("unreadable conversion result → BLOCKED", async () => {
    const { d } = deps("doc_1/original.docx", new Uint8Array([1]), async () => new TextEncoder().encode("not a pdf"));
    expect((await makeHandler(d)(input)).findings![0]!.code).toBe("CONVERT_EMPTY");
  });
});
