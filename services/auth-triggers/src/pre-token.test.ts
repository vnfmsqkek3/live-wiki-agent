import { expect, it } from "vitest";
import { handler } from "./pre-token.js";

it("adds dept claim to access and id token", async () => {
  const out = await handler({ request: { userAttributes: { "custom:dept": "여신" } }, response: {} });
  const d = out.response.claimsAndScopeOverrideDetails as Record<string, { claimsToAddOrOverride: Record<string, string> }>;
  expect(d.accessTokenGeneration!.claimsToAddOrOverride).toEqual({ dept: "여신" });
  expect(d.idTokenGeneration!.claimsToAddOrOverride).toEqual({ dept: "여신" });
});

it("empty dept when attribute missing", async () => {
  const out = await handler({ request: { userAttributes: {} }, response: {} });
  expect(JSON.stringify(out.response)).toContain('"dept":""');
});
