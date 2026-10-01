import { describe, expect, it } from "vitest";
import {
  CheckoutPrStatusSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages";

// CONTRACTS v1.16 (CONTRACT-CHANGE-J7-1): additive, optional wire shapes.
describe("checkout.file-at-commit.get wire shapes", () => {
  it("parses both request forms and refuses malformed targets structurally", () => {
    for (const at of [
      { kind: "commit", sha: "a".repeat(40) },
      { kind: "merge-base", of: ["a".repeat(40), "b".repeat(40)] },
    ]) {
      expect(
        SessionInboundMessageSchema.safeParse({
          type: "checkout.file-at-commit.get.request",
          requestId: "r",
          cwd: "/w",
          at,
          path: "docs/map.json",
          maxBytes: 1_048_576,
        }).success,
      ).toBe(true);
    }
    for (const bad of [
      { at: { kind: "branch", name: "main" } },
      { at: { kind: "merge-base", of: ["a".repeat(40)] } },
      { maxBytes: 1_048_577 },
    ]) {
      expect(
        SessionInboundMessageSchema.safeParse({
          type: "checkout.file-at-commit.get.request",
          requestId: "r",
          cwd: "/w",
          at: { kind: "commit", sha: "a".repeat(40) },
          path: "p",
          ...bad,
        }).success,
      ).toBe(false);
    }
  });

  it("parses every response status, and passes the generated outbound validator", async () => {
    const payloads = [
      { commit: "c".repeat(40), status: "ok", encoding: "utf-8", content: "{}", size: 2 },
      { commit: "c".repeat(40), status: "ok", encoding: "base64", content: "AAE=", size: 2 },
      { commit: "c".repeat(40), status: "missing", encoding: "none" },
      { commit: "c".repeat(40), status: "too_large", encoding: "none", size: 2_000_000 },
      { commit: "c".repeat(40), status: "not_a_file", encoding: "none" },
      { commit: null, status: "error", encoding: "none", error: "cwd is required" },
    ];
    const { validateWSOutboundMessage } = await import("./validation/ws-outbound.js");
    for (const payload of payloads) {
      const message = {
        type: "checkout.file-at-commit.get.response",
        payload: { requestId: "r", cwd: "/w", path: "p", ...payload },
      };
      expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
      expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
    }
  });

  it("keeps baseRefOid and headRefOid optional on PR status", () => {
    const status = {
      url: "u",
      title: "t",
      state: "open",
      baseRefName: "main",
      headRefName: "f",
      isMerged: false,
    };
    expect(CheckoutPrStatusSchema.safeParse(status).success).toBe(true);
    expect(
      CheckoutPrStatusSchema.parse({
        ...status,
        baseRefOid: "a".repeat(40),
        headRefOid: "b".repeat(40),
      }),
    ).toMatchObject({ baseRefOid: "a".repeat(40), headRefOid: "b".repeat(40) });
  });
});
