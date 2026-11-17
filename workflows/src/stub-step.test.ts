import { expect, it } from "vitest";
import { handler } from "./stub-step.js";

it("stub step returns OK", async () => {
  expect(await handler()).toEqual({ status: "OK" });
});
