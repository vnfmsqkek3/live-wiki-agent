import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { ASL_PATH, buildIngestAsl, render } from "./asl.js";
import { makeHandler as failureCatcher } from "./failure-catcher.js";
import { makeHandler as stubStep } from "./stub-step.js";

type S = { Type: string; Next?: string; Default?: string; Choices?: { Next: string }[]; Catch?: { Next: string }[]; Branches?: unknown[] };

describe("ingest ASL", () => {
  const asl = buildIngestAsl();
  const states = asl.States as Record<string, S>;

  it("committed JSON is up to date (run: node workflows/src/asl.ts)", () => {
    expect(readFileSync(ASL_PATH, "utf8")).toBe(render());
  });

  it("every transition target exists", () => {
    for (const [name, s] of Object.entries(states)) {
      const targets = [s.Next, s.Default, ...(s.Choices ?? []).map((c) => c.Next), ...(s.Catch ?? []).map((c) => c.Next)];
      for (const t of targets.filter(Boolean)) expect(states, `${name} -> ${t}`).toHaveProperty(t as string);
    }
  });

  it("happy path visits all 14 steps in order", () => {
    const order: string[] = [];
    let cur: string | undefined = asl.StartAt;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const s: S = states[cur]!;
      if (s.Type === "Task" || s.Type === "Parallel") order.push(cur);
      cur = s.Type === "Choice" ? s.Default ?? s.Choices?.[0]?.Next : s.Next;
      if (cur === "Rejected") cur = "Promote"; // 승인 분기는 APPROVE 경로로
    }
    const steps = order.filter((n) => !n.startsWith("Record_"));
    expect(steps).toEqual([
      "MalwareCheck", "FileStructureCheck", "ParallelPreprocess", "OcrIfNeeded", "SegmentBuild", "PiiScan",
      "InjectionScan", "Classify", "TrustGate", "WaitForApproval", "Promote", "KbIngest", "GraphUpsert", "Finalize",
    ]);
  });

  it("every Lambda task has a Catch to a HandleError state", () => {
    for (const [name, s] of Object.entries(states)) {
      if ((s.Type === "Task" && !name.startsWith("Record_") && !name.startsWith("HandleError_")) || s.Type === "Parallel") {
        expect(s.Catch?.[0]?.Next, name).toMatch(/^HandleError_/);
      }
    }
  });

  it("BLOCKED and REJECTED end at Finalize, not Promote", () => {
    expect(states.Blocked!.Next).toBe("Finalize");
    expect(states.Rejected!.Next).toBe("Finalize");
    expect(states.Check_TrustGate!.Choices![0]!.Next).toBe("Blocked");
  });
});

describe("failure-catcher", () => {
  it("records execution failure without cause", async () => {
    const sent: PutItemCommand[] = [];
    const h = failureCatcher(async (c) => sent.push(c), "t");
    await h({ detail: { executionArn: "arn:x", name: "wf_1", status: "TIMED_OUT", stopDate: 0, error: "States.Timeout" } });
    const item = sent[0]!.input.Item!;
    expect(item.pk!.S).toBe("WF#wf_1");
    expect(item.status!.S).toBe("TIMED_OUT");
    expect(item).not.toHaveProperty("cause");
  });
});

describe("stub-step", () => {
  it("returns OK for normal steps", async () => {
    const h = stubStep(async () => undefined, "t");
    expect(await h({ workflow_id: "wf_1", doc_id: "doc_1" })).toEqual({ status: "OK" });
  });
  it("stores task token for approval step", async () => {
    const sent: PutItemCommand[] = [];
    const h = stubStep(async (c) => sent.push(c), "t");
    await h({ workflow_id: "wf_1", doc_id: "doc_1", task_token: "tok" });
    expect(sent[0]!.input.Item!.task_token!.S).toBe("tok");
  });
});
