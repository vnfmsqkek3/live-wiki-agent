import { describe, expect, it } from "vitest";
import { lowConfidence, makeHandler, type Deps } from "./ocr-if-needed.js";
import type { Finding } from "./common.js";

const input = { workflow_id: "wf_1", doc_id: "doc_1", version: 1, bucket: "q", prefix: "doc_1/", actor: { sub: "a", groups: ["AUTHOR"] } };

// 메모리 S3 + 가짜 엔드포인트. complete() 로 SageMaker 가 출력을 쓴 것처럼 만든다.
function fake(pageCount: number, conf = 0.95) {
  const s3 = new Map<string, string>();
  const invoked: string[] = [];
  const saved: Finding[][] = [];
  s3.set("doc_1/work/pages/ocr_targets.json", JSON.stringify({
    doc_id: "doc_1", page_count: pageCount,
    pages: Array.from({ length: pageCount }, (_, i) => ({ page_index: i, key: `doc_1/work/pages/${i}.png`, width: 2000, height: 2800, reason: "chars<50" })),
  }));
  const d: Deps = {
    get: async (k) => s3.get(k),
    put: async (k, b) => { s3.set(k, b); },
    move: async (uri, k) => { if (!s3.has(uri)) return false; s3.set(k, s3.get(uri)!); s3.delete(uri); return true; },
    exists: async (uri) => s3.has(uri),
    invoke: async (inputKey) => { invoked.push(inputKey); return { output: `out/${inputKey}`, failure: `fail/${inputKey}` }; },
    saveFindings: async (_d, _s, f) => { saved.push(f); },
  };
  const complete = () => {
    for (const k of invoked) {
      const req = JSON.parse(s3.get(k)!) as { pages: { page_index: number }[] };
      s3.set(`out/${k}`, JSON.stringify({ model: "m", model_version: "v", pages: req.pages.map((p) => ({ page_index: p.page_index, blocks: [{ confidence: conf }] })).reverse() }));
    }
  };
  return { s3, invoked, saved, d, complete };
}

describe("OcrIfNeeded", () => {
  it("OK immediately when no OCR targets", async () => {
    const f = fake(0);
    expect(await makeHandler(f.d)(input)).toEqual({ status: "OK" });
    expect(f.invoked).toHaveLength(0);
  });

  it("invokes once per 10 pages, then PENDING without re-invoking", async () => {
    const f = fake(23);
    const h = makeHandler(f.d);
    expect((await h(input)).status).toBe("PENDING");
    expect(f.invoked).toHaveLength(3);
    expect((await h(input)).status).toBe("PENDING");
    expect(f.invoked).toHaveLength(3); // 재호출해도 다시 invoke 하지 않음 (멱등)
  });

  it("merges chunks sorted by page and is idempotent after completion", async () => {
    const f = fake(23);
    const h = makeHandler(f.d);
    await h(input);
    f.complete();
    const out = await h(input);
    expect(out).toMatchObject({ status: "OK", output_key: "doc_1/work/ocr/result.json" });
    const r = JSON.parse(f.s3.get("doc_1/work/ocr/result.json")!);
    expect(r.pages.map((p: { page_index: number }) => p.page_index)).toEqual([...Array(23).keys()]);
    expect([...f.s3.keys()].some((k) => k.startsWith("out/"))).toBe(false); // async 출력은 work/ 로 옮겨짐
    expect(await h(input)).toEqual({ status: "OK", output_key: "doc_1/work/ocr/result.json" });
    expect(f.saved).toEqual([[]]);
  });

  it("REVIEW_REQUIRED on low-confidence pages", async () => {
    const f = fake(2, 0.7);
    const h = makeHandler(f.d);
    await h(input);
    f.complete();
    const out = await h(input);
    expect(out.status).toBe("REVIEW_REQUIRED");
    expect(out.findings!.map((x) => x.code)).toEqual(["OCR_LOW_CONFIDENCE", "OCR_LOW_CONFIDENCE"]);
  });

  it("throws when SageMaker reports failure", async () => {
    const f = fake(1);
    const h = makeHandler(f.d);
    await h(input);
    f.s3.set(`fail/${f.invoked[0]}`, "error");
    await expect(h(input)).rejects.toThrow(/OcrChunkFailed/);
  });
});

describe("lowConfidence", () => {
  it("LOW when only some blocks are low but page average is fine", () => {
    const b = (confidence: number, y: number) => ({ confidence, bbox: [40, y, 900, y + 40] });
    const f = lowConfidence("d", [{ page_index: 0, blocks: [b(0.99, 100), b(0.99, 200), b(0.84, 300)] }]);
    expect(f[0]!.severity).toBe("LOW");
  });

  it("tells the uploader which page and where (1-based page, low-confidence block boxes), never the raw text", () => {
    const b = (confidence: number, y: number, text: string) => ({ confidence, bbox: [40, y, 900, y + 40], text });
    const f = lowConfidence("d", [{ page_index: 2, blocks: [b(0.6, 100, "010-1234-5678"), b(0.95, 200, "ok"), b(0.7, 300, "흐림")] }]);
    expect(f[0]!.location).toEqual({ page: 3, bbox: [[40, 100, 900, 140], [40, 300, 900, 340]] });
    expect(f[0]!.user_message).toMatch(/^3쪽에서 .* 2곳/);
    expect(f[0]!.fix_hint).toBeTruthy();
    expect(JSON.stringify(f[0])).not.toContain("1234");
  });
});
