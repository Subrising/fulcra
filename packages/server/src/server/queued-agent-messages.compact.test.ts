import { describe, expect, test } from "vitest";
import { compactDelivered } from "./queued-agent-messages.js";

const base: Record<string, unknown> = {
  id: "r1",
  agentId: "a1",
  sessionId: null,
  localServerId: null,
  request: {
    text: "a long report",
    messageId: "m1",
    sender: { agentId: "s1" },
    images: [{ data: "x", mimeType: "image/png" }],
  },
};

function record(state: string, settledAt?: number) {
  return structuredClone({
    ...base,
    state,
    ...(settledAt ? { settledAt } : {}),
  });
}

describe("compactDelivered", () => {
  const now = 10_000_000;
  test("drops the payload of a delivered record after the resend window and keeps the IDs", () => {
    const r = record("delivered", now - 11 * 60_000);
    compactDelivered(r, now);
    expect(r.compact).toBe(true);
    expect(r.request).toEqual({
      text: "",
      messageId: "m1",
      sender: { agentId: "s1" },
    });
  });
  test("keeps a delivered record inside the resend window", () => {
    const r = record("delivered", now - 60_000);
    compactDelivered(r, now);
    expect(r.compact).toBeUndefined();
    expect(r.request.text).toBe("a long report");
  });
  test.each(["queued", "dispatching", "uncertain", "refused"])(
    "never compacts %s",
    (state) => {
      const r = record(state, now - 60 * 60_000);
      compactDelivered(r, now);
      expect(r.compact).toBeUndefined();
      expect(r.request.text).toBe("a long report");
    }
  );
});
