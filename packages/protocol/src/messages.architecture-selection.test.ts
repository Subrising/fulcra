import { expect, it } from "vitest";
import { CheckoutPrStatusRequestSchema } from "./messages.js";
it("retains branch requests and accepts positive selected PRs", () => {
  const legacy = { type: "checkout_pr_status_request", cwd: "/fixture", requestId: "read" };
  expect(CheckoutPrStatusRequestSchema.parse(legacy)).toEqual(legacy);
  expect(CheckoutPrStatusRequestSchema.parse({ ...legacy, pullRequest: 27 }).pullRequest).toBe(27);
  for (const pullRequest of [0, -1, 1.5, Infinity, "27", Number.MAX_SAFE_INTEGER + 1])
    expect(CheckoutPrStatusRequestSchema.safeParse({ ...legacy, pullRequest }).success).toBe(false);
});
