import { describe, expect, it } from "vitest";
import { makeHandler, pageInput, sanitize } from "./page-summarize.js";

const mask = (t: string) => t.replace(/01\d-\d{4}-\d{4}/g, "[전화번호]");
const input = { workflow_id: "wf_1", doc_id: "doc_1", version: 2, bucket: "q", prefix: "doc_1/", actor: { sub: "a", groups: ["AUTHOR"] } };
const segs: Record<string, unknown> = {
  "doc_1/masked/segments/0000.json": { page_index: 0, text: "제12조(승인한도) ① 여신 승인은 한도 내에서 한다." },
  "doc_1/masked/segments/0001.json": { page_index: 1, text: "", figures: [{ kind: "chart", description: "월별 연체율 막대그래프" }] },
  "doc_1/masked/segments/0002.json": { page_index: 2, text: "   " },
};

describe("sanitize", () => {
  it("drops clause refs not in the page text, masks, caps lists, coerces page_type", () => {
    const r = sanitize({ summary: "문의 010-1234-5678", keywords: ["여신", "여신", "승인한도"], clause_refs: ["제12조", "제99조", "별표"], page_type: "소설" }, "제12조(승인한도)", mask);
    expect(r).toEqual({ summary: "문의 [전화번호]", keywords: ["여신", "승인한도"], clause_refs: ["제12조"], page_type: "기타" });
  });
});

describe("pageInput", () => {
  it("includes figure descriptions with page number", () => {
    expect(pageInput(segs["doc_1/masked/segments/0001.json"] as never)).toContain('<page number="2">');
    expect(pageInput(segs["doc_1/masked/segments/0001.json"] as never)).toContain("월별 연체율");
  });
});

describe("PageSummarize", () => {
  it("writes one summary per non-empty page (same page number as segment) and a document index", async () => {
    const puts = new Map<string, unknown>();
    const sent: string[] = [];
    const h = makeHandler({
      listSegments: async () => [2, 0, 1],
      getJson: async <T>(k: string) => segs[k] as T,
      putJson: async (k, b) => { puts.set(k, b); },
      summarize: async (x) => (sent.push(x), { summary: "요약", keywords: ["여신"], clause_refs: ["제12조"], page_type: "본문" }),
      mask, model: "haiku", now: () => "2026-11-17T00:00:00Z",
    });
    expect(await h(input)).toEqual({ status: "OK", output_key: "doc_1/masked/summary.json" });
    expect(sent).toHaveLength(2); // 빈 쪽(3쪽) 제외
    expect(puts.get("doc_1/masked/summaries/0000.json")).toMatchObject({ page: 1, clause_refs: ["제12조"], segment_key: "doc_1/masked/segments/0000.json", char_count: 24 });
    expect(puts.get("doc_1/masked/summaries/0001.json")).toMatchObject({ page: 2, clause_refs: [], figure_count: 1 });
    expect(puts.get("doc_1/masked/summary.json")).toMatchObject({ version: 2, page_count: 2, pages: [{ page: 1 }, { page: 2 }] });
  });

  it("empty model summary is a failure, not silent success", async () => {
    const h = makeHandler({
      listSegments: async () => [0], getJson: async <T>(k: string) => segs[k] as T, putJson: async () => {},
      summarize: async () => ({}), mask, model: "m", now: () => "",
    });
    await expect(h(input)).rejects.toThrow(/EmptySummary/);
  });
});
