import { describe, expect, it } from "vitest";
import { canForceTool, converseTool } from "./converse-tool.js";

const reply = (input?: unknown) => ({ output: { message: { role: "assistant" as const, content: input === undefined ? [{ text: "글로만 답함" }] : [{ toolUse: { toolUseId: "t", name: "out", input } }] } } });
const base = { messages: [{ role: "user" as const, content: [{ text: "q" }] }], toolConfig: { tools: [] } };

describe("converseTool", () => {
  it("Haiku 5.5 는 도구 강제, Sonnet 5.5 는 auto", () => {
    expect(canForceTool("us.anthropic.claude-haiku-5-5")).toBe(true);
    expect(canForceTool("us.anthropic.claude-sonnet-5-5")).toBe(false);
  });
  it("auto 에서 글로만 답하면 한 번 더 요청해 도구 결과를 받는다", async () => {
    const sent: unknown[] = []; const answers = [reply(), reply({ a: 1 })];
    const out = await converseTool({ send: async (c) => { sent.push(c.input); return answers.shift() as never; } }, { ...base, modelId: "us.anthropic.claude-sonnet-5-5" }, "out");
    expect(out).toEqual({ a: 1 });
    expect(sent).toHaveLength(2);
    expect((sent[0] as { toolConfig: { toolChoice: unknown } }).toolConfig.toolChoice).toEqual({ auto: {} });
  });
  it("강제 가능한 모델은 1번만 보낸다", async () => {
    const sent: unknown[] = [];
    const out = await converseTool({ send: async (c) => { sent.push(c.input); return reply({ a: 2 }) as never; } }, { ...base, modelId: "us.anthropic.claude-haiku-5-5" }, "out");
    expect(out).toEqual({ a: 2 });
    expect((sent[0] as { toolConfig: { toolChoice: unknown } }).toolConfig.toolChoice).toEqual({ tool: { name: "out" } });
  });
});
