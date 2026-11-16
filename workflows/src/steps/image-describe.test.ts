import { describe, expect, it } from "vitest";
import { makeHandler, sanitize, type Mask } from "./image-describe.js";

const input = { workflow_id: "wf_1", doc_id: "doc_1", version: 1, bucket: "q", prefix: "doc_1/", actor: { sub: "a", groups: ["AUTHOR"] } };
// 테스트용 마스크: 전화번호만 (실제 규칙은 dhxorb96 pii-detect)
const mask: Mask = (t) => {
  let found = 0;
  return { text: t.replace(/01\d-\d{4}-\d{4}/g, () => (found++, "[전화번호]")), found };
};

function world(files: Record<string, unknown>, modelOut: unknown) {
  const puts = new Map<string, unknown>();
  const sent: Uint8Array[] = [];
  const saved: unknown[] = [];
  const deps = {
    getJson: async <T,>(k: string) => (puts.get(k) ?? files[k]) as T | undefined,
    getBytes: async (k: string) => files[k] as Uint8Array | undefined,
    putJson: async (k: string, b: unknown) => { puts.set(k, b); },
    describe: async (png: Uint8Array) => (sent.push(png), modelOut),
    mask,
    saveFindings: async (_d: string, _s: string, f: unknown[]) => { saved.push(...f); },
  };
  return { puts, sent, saved, handler: makeHandler(deps) };
}

const targets = {
  doc_id: "doc_1", page_count: 2,
  pages: [
    { page_index: 0, key: "doc_1/work/pages/0000.png", width: 2000, height: 2800, reason: "images", has_images: true },
    { page_index: 1, key: "doc_1/work/pages/0001.png", width: 2000, height: 2800, reason: "chars<50", has_images: false },
  ],
};
const masked = new Uint8Array([9]);

describe("sanitize", () => {
  it("drops empty descriptions, coerces unknown kinds, masks PII in every text field", () => {
    const r = sanitize({ figures: [
      { kind: "photo", description: "  " },
      { kind: "hologram", description: "고객 010-1234-5678 상담 화면 캡처", overlay_text: "연락처 010-9999-0000", intent: "절차 안내" },
    ] }, mask);
    expect(r.pii).toBe(2);
    expect(r.figures).toEqual([{ kind: "other", description: "고객 [전화번호] 상담 화면 캡처", overlay_text: "연락처 [전화번호]", intent: "절차 안내" }]);
  });
  it("tolerates malformed model output", () => expect(sanitize("nope", mask)).toEqual({ figures: [], pii: 0 }));
});

describe("ImageDescribe", () => {
  it("sends only the PII-masked image of image pages and merges figures into the masked segment", async () => {
    const w = world({
      "doc_1/work/pages/ocr_targets.json": targets,
      "doc_1/masked/pages/0000.png": masked,
      "doc_1/masked/segments/0000.json": { doc_id: "doc_1", page_index: 0, text: "제5조 담보평가" },
    }, { figures: [{ kind: "screenshot", description: "담보평가 시스템 입력 화면", overlay_text: "감정가 입력", intent: "입력 위치 안내" }] });
    const out = await w.handler(input);
    expect(out).toEqual({ status: "OK", output_key: "doc_1/masked/figures/" });
    expect(w.sent).toEqual([masked]); // 텍스트만 부족한 1쪽은 보내지 않음
    expect(w.puts.get("doc_1/masked/segments/0000.json")).toEqual({
      doc_id: "doc_1", page_index: 0, text: "제5조 담보평가",
      figures: [{ kind: "screenshot", description: "담보평가 시스템 입력 화면", overlay_text: "감정가 입력", intent: "입력 위치 안내" }],
    });
  });

  it("never sends an unmasked page: missing masked image → REVIEW_REQUIRED, no model call", async () => {
    const w = world({ "doc_1/work/pages/ocr_targets.json": targets }, { figures: [] });
    const out = await w.handler(input);
    expect(w.sent).toEqual([]);
    expect(out.status).toBe("REVIEW_REQUIRED");
    expect(out.findings?.map((f) => f.code)).toEqual(["FIGURE_NOT_ANALYZED"]);
  });

  it("PII found in the model's description → masked and REVIEW_REQUIRED", async () => {
    const w = world({ "doc_1/work/pages/ocr_targets.json": targets, "doc_1/masked/pages/0000.png": masked },
      { figures: [{ kind: "photo", description: "명함 사진, 010-1234-5678" }] });
    const out = await w.handler(input);
    expect(out.findings?.map((f) => f.code)).toEqual(["PII_IN_FIGURE"]);
    expect(JSON.stringify(w.puts.get("doc_1/masked/figures/0000.json"))).not.toContain("1234");
  });

  it("fails without OCR targets (PageRender must run first)", async () => {
    await expect(world({}, {}).handler(input)).rejects.toThrow(/OcrTargetsNotFound/);
  });
});
