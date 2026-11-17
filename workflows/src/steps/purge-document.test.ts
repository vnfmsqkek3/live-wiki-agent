import { describe, expect, it } from "vitest";
import { makeHandler } from "./purge-document.js";

const DOC = "doc_01M7KN4DX76R259HSQAYKKR3WQ";
const input = (doc_id = DOC) => ({ workflow_id: "wf_1", doc_id, version: 1, bucket: "q", prefix: `${doc_id}/`, actor: { sub: "a", groups: ["ADMIN"] } });

function deps(lifecycle: string | undefined) {
  const calls: string[] = [];
  return { calls, h: makeHandler({ lifecycle: async () => lifecycle, purge: async (b, p) => (calls.push(`${b}:${p}`), 2), buckets: { published: "pub", quarantine: "qua" } }) };
}

describe("PurgeDocument", () => {
  it("deleted document → purges published (legal·knowledge) and quarantine prefixes", async () => {
    const { calls, h } = deps("DELETED");
    expect(await h(input())).toEqual({ status: "OK" });
    expect(calls).toEqual([`pub:legal/${DOC}/`, `pub:knowledge/${DOC}/`, `qua:${DOC}/`]);
  });
  it("refuses when the document is not DELETED (published document protected)", async () => {
    const { calls, h } = deps("PUBLISHED");
    await expect(h(input())).rejects.toThrow(/NotDeleted/);
    expect(calls).toEqual([]);
  });
  it("refuses malformed doc_id (no prefix widening)", async () => {
    const { calls, h } = deps("DELETED");
    await expect(h(input(""))).rejects.toThrow(/InvalidDocId/);
    await expect(h(input("doc_*"))).rejects.toThrow(/InvalidDocId/);
    expect(calls).toEqual([]);
  });
});
