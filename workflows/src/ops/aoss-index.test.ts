import { describe, expect, it } from "vitest";
import { ensureIndex } from "./aoss-index.js";

const noSleep = async () => {};

describe("ensureIndex", () => {
  it("leaves existing index alone", async () => {
    const calls: string[] = [];
    const r = await ensureIndex(async (m) => { calls.push(m); return { status: 200, text: "" }; }, "{}", noSleep);
    expect(r).toBe("exists");
    expect(calls).toEqual(["HEAD"]);
  });
  it("creates when missing", async () => {
    const calls: string[] = [];
    const r = await ensureIndex(async (m) => { calls.push(m); return m === "HEAD" ? { status: 404, text: "" } : { status: 200, text: "" }; }, "{}", noSleep);
    expect(r).toBe("created");
    expect(calls).toEqual(["HEAD", "PUT"]);
  });
  it("retries while access policy propagates (403)", async () => {
    let n = 0;
    const r = await ensureIndex(async (m) => {
      n++;
      if (m === "HEAD") return { status: n < 3 ? 403 : 404, text: "" };
      return { status: 200, text: "" };
    }, "{}", noSleep);
    expect(r).toBe("created");
  });
  it("fails on other create errors", async () => {
    await expect(ensureIndex(async (m) => (m === "HEAD" ? { status: 404, text: "" } : { status: 400, text: "bad mapping" }), "{}", noSleep)).rejects.toThrow(/400/);
  });
});
