import { describe, expect, it } from "vitest";
import { facts, makeHandler, sanitize } from "./explain-findings.js";

const mask = (t: string) => t.replace(/01\d-\d{4}-\d{4}/g, "[전화번호]");
const input = { workflow_id: "wf_1", doc_id: "doc_1", version: 1, bucket: "q", prefix: "doc_1/", actor: { sub: "a", groups: ["AUTHOR"] } };
const embedded = {
  finding_id: "fnd_1", step: "FILE_STRUCTURE", severity: "HIGH" as const, code: "PDF_EMBEDDED_FILE", message: "PDF PDF_EMBEDDED_FILE", evidence_ref: "catalog",
  details: { embedded_files: [{ name: "Content Credentials", subtype: "application/c2pa" }] },
};
const ocr = {
  finding_id: "fnd_2", step: "OCR_IF_NEEDED", severity: "MEDIUM" as const, code: "OCR_LOW_CONFIDENCE", message: "저신뢰", evidence_ref: "x",
  location: { page: 3, bbox: [[1, 2, 3, 4]], excerpt: "연락처 010-1234-5678" },
};
const doc = { ext: "pdf", lifecycle: "BLOCKED", findings: [embedded, ocr] };

describe("facts", () => {
  it("sends only structured, masked facts (page, details, excerpt masked; no bbox coordinates)", () => {
    const f = facts(doc, mask);
    expect(f.findings[0]!.details).toContain("Content Credentials");
    expect(f.findings[1]!).toMatchObject({ page: 3, has_area: true, excerpt: "연락처 [전화번호]" });
    expect(JSON.stringify(f)).not.toContain("1234");
  });
});

describe("sanitize", () => {
  it("keeps only known findings, coerces risk, masks text, drops invalid page", () => {
    const r = sanitize({
      summary: "첨부가 있어 차단됐습니다. 010-1234-5678",
      items: [
        { finding_id: "fnd_1", where: "파일 전체", problem: "출처 서명 첨부", reason: "첨부 PDF 차단 규칙", risk: "낮음", fix: "PDF로 인쇄해 다시 저장" },
        { finding_id: "fnd_2", page: 0, where: "3쪽", problem: "흐림", reason: "인식 불확실", risk: "아주높음", fix: "재스캔" },
        { finding_id: "fnd_made_up", where: "?", problem: "?", reason: "?", risk: "높음", fix: "?" },
      ],
      next_action: "다시 올리세요",
    }, doc, mask);
    expect(r.items.map((i) => i.finding_id)).toEqual(["fnd_1", "fnd_2"]);
    expect(r.items[1]).not.toHaveProperty("page");
    expect(r.items[1]!.risk).toBe("중간");
    expect(r.summary).not.toContain("1234");
  });
});

describe("ExplainFindings", () => {
  it("writes masked/explanation.json for a blocked upload and does not change the verdict", async () => {
    const puts = new Map<string, unknown>();
    const sent: string[] = [];
    const h = makeHandler({
      getDoc: async () => doc,
      explain: async (j) => (sent.push(j), { summary: "s", items: [{ finding_id: "fnd_1", where: "파일 전체", problem: "p", reason: "r", risk: "낮음", fix: "f" }], next_action: "n" }),
      putJson: async (k, b) => { puts.set(k, b); },
      mask, model: "m", now: () => "2026-11-17T00:00:00Z",
    });
    expect(await h(input)).toEqual({ status: "OK", output_key: "doc_1/masked/explanation.json" });
    expect(puts.get("doc_1/masked/explanation.json")).toMatchObject({ doc_id: "doc_1", lifecycle: "BLOCKED", model: "m", items: [{ finding_id: "fnd_1", risk: "낮음" }] });
    expect(sent[0]).not.toContain("1234");
  });

  it("no findings → nothing to explain", async () => {
    const h = makeHandler({ getDoc: async () => ({ findings: [] }), explain: async () => { throw new Error("must not call"); }, putJson: async () => {}, mask, model: "m", now: () => "" });
    expect(await h(input)).toEqual({ status: "OK" });
  });
});
