import { expect, test } from "vitest";
import { RefreshAgentRequestMessageSchema } from "./messages.js";

test("reload omits restore intent, including a confirmation without restore", () => {
  const request = { type: "refresh_agent_request", agentId: "fixture", requestId: "fixture" };
  expect(RefreshAgentRequestMessageSchema.parse(request).restore).toBeUndefined();
  expect(
    RefreshAgentRequestMessageSchema.parse({ ...request, confirmed: true }).restore,
  ).toBeUndefined();
  expect(RefreshAgentRequestMessageSchema.parse({ ...request, restore: true }).restore).toBe(true);
  expect(RefreshAgentRequestMessageSchema.safeParse({ ...request, restore: "true" }).success).toBe(
    false,
  );
});
