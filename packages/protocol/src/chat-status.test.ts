import { describe, expect, it } from "vitest";
import { chatStatusWord, effectiveChatStatus, lastKnownStatusLine } from "./chat-status";

describe("chat status words", () => {
  it("names each chat-list status the same way for the sidebar and the Leads page", () => {
    expect(lastKnownStatusLine("running")).toBe("Working · last known");
    expect(lastKnownStatusLine("idle")).toBe("Idle · last known");
    expect(lastKnownStatusLine("initializing")).toBe("Starting · last known");
    expect(lastKnownStatusLine("error")).toBe("Needs attention · last known");
    expect(lastKnownStatusLine("closed")).toBe("Saved");
  });

  it("says the status is unknown when the chat list has none or an unknown value", () => {
    expect(lastKnownStatusLine(undefined)).toBe("Status unknown");
    expect(lastKnownStatusLine("weird")).toBe("Status unknown");
    expect(chatStatusWord("weird")).toBeNull();
  });
});

describe("a chat that waits for permission", () => {
  it("says so, whatever its run state, until it is closed", () => {
    const waiting = { requiresAttention: true, attentionReason: "permission" };
    expect(effectiveChatStatus({ status: "running", ...waiting })).toBe("waiting-permission");
    expect(effectiveChatStatus({ status: "idle", ...waiting })).toBe("waiting-permission");
    expect(effectiveChatStatus({ status: "closed", ...waiting })).toBe("closed");
    expect(
      effectiveChatStatus({
        status: "running",
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe("running");
    expect(effectiveChatStatus({ status: "running" })).toBe("running");
    expect(lastKnownStatusLine("waiting-permission")).toBe("Waiting for permission · last known");
  });
});
