import { describe, expect, it, vi } from "vitest";
import { recordReviewWith, repoFromPullRequestUrl, REVIEW_RECORD_RPC } from "./review-inbox";

const HEAD = "a".repeat(40);
const record = {
  workspace: "/work/checkout",
  url: "https://github.com/acme/checkout/pull/42",
  pullRequest: 42,
  headOid: HEAD,
  decision: "request_changes" as const,
  note: " Add a test. ",
};
const client = (answer: unknown) => ({
  invokePluginRpc: vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  }),
});

describe("G4 review record in the Inbox", () => {
  it("reads owner/name from a GitHub pull request URL only", () => {
    expect(repoFromPullRequestUrl("https://github.com/acme/checkout/pull/42")).toBe(
      "acme/checkout",
    );
    expect(repoFromPullRequestUrl("https://github.com/acme/checkout/pull/42/files#diff")).toBe(
      "acme/checkout",
    );
    for (const bad of [
      undefined,
      "",
      "https://gitlab.com/acme/checkout/pull/42",
      "https://github.com/acme/checkout/issues/42",
      "http://github.com/acme/checkout/pull/42",
    ])
      expect(repoFromPullRequestUrl(bad)).toBeNull();
  });

  it("sends exactly the controller's record input through the organization plugin", async () => {
    const c = client({ ok: true, already: false, decisionId: "x" });
    await expect(recordReviewWith(c, "orca-organization", record)).resolves.toBe("recorded");
    expect(c.invokePluginRpc).toHaveBeenCalledWith("orca-organization", REVIEW_RECORD_RPC, {
      workspace: "/work/checkout",
      repo: "acme/checkout",
      number: 42,
      headSha: HEAD,
      choice: "request_changes",
      note: "Add a test.",
      via: "app-mac",
    });
  });

  it("a retry is reported as already recorded; a refusal is refused", async () => {
    await expect(recordReviewWith(client({ ok: true, already: true }), "p", record)).resolves.toBe(
      "already",
    );
    await expect(
      recordReviewWith(client({ ok: false, message: "Invalid review note" }), "p", record),
    ).resolves.toBe("refused");
  });

  it("falls back to the host file (does nothing) without the plugin, the method, a repo URL or a full head commit", async () => {
    const c = client({ ok: true });
    await expect(recordReviewWith(c, null, record)).resolves.toBe("unavailable");
    await expect(recordReviewWith(null, "p", record)).resolves.toBe("unavailable");
    await expect(recordReviewWith(c, "p", { ...record, url: undefined })).resolves.toBe(
      "unavailable",
    );
    await expect(recordReviewWith(c, "p", { ...record, headOid: "abc" })).resolves.toBe(
      "unavailable",
    );
    expect(c.invokePluginRpc).not.toHaveBeenCalled();
    await expect(
      recordReviewWith(client(new Error("Unknown plugin RPC method")), "p", record),
    ).resolves.toBe("unavailable");
  });
});
