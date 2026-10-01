import { expect, test } from "vitest";
import { GitAiDraftRequestSchema, GitAiDraftResponseSchema } from "./git-ai-draft.js";
const id = "00000000-0000-4000-8000-000000000001";
test("Git draft request rejects caller paths, providers and mutating options", () => {
  const input = {
    type: "checkout.git_ai.draft.request",
    requestId: id,
    workspaceId: id,
    kind: "conflict-help",
  };
  expect(GitAiDraftRequestSchema.safeParse(input).success).toBe(true);
  for (const extra of [
    { cwd: "/foreign" },
    { provider: "claude" },
    { commit: true },
    { body: "override" },
  ])
    expect(GitAiDraftRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
});
test("Git draft output preserves subject and text limits and truthful refusal", () => {
  const reply = {
    type: "checkout.git_ai.draft.response",
    payload: {
      requestId: id,
      workspaceId: id,
      kind: "commit-message",
      result: { status: "ok", draft: { kind: "commit-message", message: "x".repeat(73) } },
    },
  };
  expect(GitAiDraftResponseSchema.safeParse(reply).success).toBe(false);
  expect(
    GitAiDraftResponseSchema.safeParse({
      ...reply,
      payload: { ...reply.payload, result: { status: "refused", error: "unavailable" } },
    }).success,
  ).toBe(true);
});
