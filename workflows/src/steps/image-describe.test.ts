import { describe, expect, it } from "vitest";
import { makeHandler, normBox, pickBoxes, sanitize, snapBox, type Mask } from "./image-describe.js";

describe("pickBoxes", () => {
  it("pairs by vertical order when counts match but boxes do not overlap (portrait page)", () => {
    expect(pickBoxes([[66, 300, 934, 357]], [[98, 461, 907, 525]])).toEqual([{ box: [98, 461, 907, 525], snapped: true }]);
  });
  it("skips a crop when OCR boxes exist but nothing pairs", () => {
    expect(pickBoxes([[66, 300, 934, 357], [10, 10, 50, 50]], [[98, 461, 907, 525]])).toEqual([undefined, undefined]);
  });
  it("uses the model box only when OCR found no figures", () => {
    expect(pickBoxes([[10, 10, 60, 60]], [])).toEqual([{ box: [10, 10, 60, 60], snapped: false }]);
  });
});

describe("snapBox", () => {
  it("uses the overlapping OCR figure box, keeps the model box otherwise", () => {
    expect(snapBox([220, 510, 460, 820], [[241, 558, 491, 868], [562, 558, 813, 869]])).toEqual({ box: [241, 558, 491, 868], snapped: true });
    expect(snapBox([190, 110, 420, 410], [[516, 125, 767, 436]])).toEqual({ box: [190, 110, 420, 410], snapped: false });
  });
});

describe("normBox", () => {
  it("accepts 0-1000 boxes, clamps, rejects tiny or malformed", () => {
    expect(normBox([10, 20, 500, 600])).toEqual([10, 20, 500, 600]);
    expect(normBox([-5, 0, 1200, 400])).toEqual([0, 0, 1000, 400]);
    expect(normBox([10, 10, 20, 500])).toBeUndefined();
    expect(normBox([1, 2, 3])).toBeUndefined();
    expect(normBox("x")).toBeUndefined();
  });
});

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
    listMaskedPages: async () => Object.keys(files).flatMap((k) => /masked\/pages\/(\d{4})\.png$/.exec(k) ? [Number(k.slice(-8, -4))] : []),
    getJson: async <T,>(k: string) => (puts.get(k) ?? files[k]) as T | undefined,
    getBytes: async (k: string) => files[k] as Uint8Array | undefined,
    putJson: async (k: string, b: unknown) => { puts.set(k, b); },
    putPng: async (k: string, b: Uint8Array) => { puts.set(k, b); },
    crop: async (_p: Uint8Array, box: number[]) => new Uint8Array(box),
    describe: async (png: Uint8Array) => (sent.push(png), modelOut),
    mask,
    saveFindings: async (_d: string, _s: string, f: unknown[]) => { saved.push(...f); },
  };
  return { puts, sent, saved, handler: makeHandler(deps) };
}

const masked = new Uint8Array([9]);

describe("sanitize", () => {
  it("drops empty descriptions, coerces unknown kinds, masks PII in every text field", async () => {
    const r = await sanitize({ figures: [
      { kind: "photo", description: "  " },
      { kind: "hologram", description: "고객 010-1234-5678 상담 화면 캡처", overlay_text: "연락처 010-9999-0000", intent: "절차 안내" },
    ] }, mask);
    expect(r.pii).toBe(2);
    expect(r.figures).toEqual([{ kind: "other", description: "고객 [전화번호] 상담 화면 캡처", overlay_text: "연락처 [전화번호]", intent: "절차 안내" }]);
  });
  it("tolerates malformed model output", async () => expect(await sanitize("nope", mask)).toEqual({ figures: [], pii: 0 }));
  it("keeps page_markdown only when the page has figures, masked", async () => {
    const r = await sanitize({ figures: [{ kind: "screenshot", description: "설치 화면" }], page_markdown: "## 설치\n1. **다운로드** 클릭 _(그림 1)_ 010-1234-5678" }, mask);
    expect(r.page_markdown).toContain("1. **다운로드** 클릭 _(그림 1)_");
    expect(r.page_markdown).toContain("[전화번호]");
    expect((await sanitize({ figures: [], page_markdown: "글만" }, mask)).page_markdown).toBeUndefined();
  });
});

describe("ImageDescribe", () => {
  it("sends only the PII-masked image of image pages and merges figures into the masked segment", async () => {
    const w = world({
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

  it("no masked page → no model call, OK (PiiScan already flagged image pages it could not mask)", async () => {
    const w = world({ "doc_1/masked/segments/0001.json": { doc_id: "doc_1", page_index: 1, text: "본문" } }, { figures: [] });
    expect(await w.handler(input)).toEqual({ status: "OK" });
    expect(w.sent).toEqual([]);
  });

  it("PII found in the model's description → masked and REVIEW_REQUIRED", async () => {
    const w = world({ "doc_1/masked/pages/0000.png": masked },
      { figures: [{ kind: "photo", description: "명함 사진, 010-1234-5678" }] });
    const out = await w.handler(input);
    expect(out.findings?.map((f) => f.code)).toEqual(["PII_IN_FIGURE"]);
    expect(JSON.stringify(w.puts.get("doc_1/masked/figures/0000.json"))).not.toContain("1234");
  });

});

describe("shared PII rules (@hanaeum/pii)", () => {
  // 사용자 결정 11/17: 전화번호·이메일은 가리지 않음, 주민번호 등 식별번호는 가림
  it("masks a resident registration number but keeps phone and email in a figure description", async () => {
    const { detectPii, mask: m } = await import("@hanaeum/pii");
    const r = await sanitize({ figures: [{ kind: "photo", description: "신분증 사진 900101-1234568, 담당 02-3456-7890 hana@example.com" }] },
      (t) => { const s = detectPii(t); return { text: s.length ? m(t, s) : t, found: s.length }; });
    expect(r.pii).toBe(1);
    expect(r.figures[0]!.description).not.toContain("1234568");
    expect(r.figures[0]!.description).toContain("02-3456-7890");
    expect(r.figures[0]!.description).toContain("hana@example.com");
  });
});
