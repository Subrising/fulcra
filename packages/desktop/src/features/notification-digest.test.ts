import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationDigest, NOTIFICATION_DIGEST_WINDOW_MS } from "./notification-digest.js";

const completion = (agentId: string, title = agentId, serverId = "host") => ({
  title,
  body: "Assistant preview",
  data: { reason: "finished", serverId, agentId, workspaceId: "workspace" },
});

describe("desktop notification digest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces the latest completion per host/session without extending the fixed window", () => {
    const deliver = vi.fn();
    const digest = new NotificationDigest(deliver);
    digest.send(completion("one", "Old title"), "window-1", "digest");
    vi.advanceTimersByTime(20_000);
    digest.send(completion("two", "Second"), "window-2", "digest");
    digest.send(completion("one", "Latest"), "window-1", "digest");
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      {
        title: "Session digest",
        body: "2 recent sessions finished: Second; Latest",
        data: { ...completion("one").data, digestSessionCount: 2 },
      },
      "window-1",
    );
    vi.advanceTimersByTime(NOTIFICATION_DIGEST_WINDOW_MS);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("waits for the chosen digest interval before showing it", () => {
    const deliver = vi.fn();
    const digest = new NotificationDigest(deliver);
    digest.send(completion("one"), "window-1", "digest", 15 * 60_000);
    digest.send(completion("two"), "window-1", "digest", 15 * 60_000);
    vi.advanceTimersByTime(14 * 60_000);
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("bounds retained sessions, body length and click data during a burst", () => {
    const deliver = vi.fn();
    const digest = new NotificationDigest(deliver);
    for (let i = 0; i < 100; i += 1)
      digest.send(completion(String(i), "A".repeat(80)), "window", "digest");
    vi.advanceTimersByTime(NOTIFICATION_DIGEST_WINDOW_MS);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toEqual({
      title: "Session digest",
      body: expect.any(String),
      data: { ...completion("99").data, digestSessionCount: 20 },
    });
    expect(deliver.mock.calls[0][0].body.length).toBeLessThanOrEqual(220);
    expect(deliver.mock.calls[0][0].body).not.toContain("Assistant preview");
  });

  it.each(["permission", "error"])(
    "delivers %s immediately and supersedes a queued completion",
    (reason) => {
      const deliver = vi.fn();
      const digest = new NotificationDigest(deliver);
      digest.send(completion("one"), "window", "digest");
      const attention = { ...completion("one"), data: { ...completion("one").data, reason } };
      digest.send(attention, "window", "digest");
      expect(deliver).toHaveBeenCalledExactlyOnceWith(attention, "window");
      vi.advanceTimersByTime(NOTIFICATION_DIGEST_WINDOW_MS);
      expect(deliver).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps hosts distinct, preserves single-session routing and leaves generic notifications immediate", () => {
    const deliver = vi.fn();
    const digest = new NotificationDigest(deliver);
    const first = completion("same", "One", "host-a");
    digest.send(first, "window", "digest");
    digest.send({ title: "Generic" }, "window", "digest");
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ title: "Generic" }, "window");
    vi.advanceTimersByTime(NOTIFICATION_DIGEST_WINDOW_MS);
    expect(deliver).toHaveBeenLastCalledWith(first, "window");
    digest.send(completion("same", "One", "host-a"), "window", "digest");
    digest.send(completion("same", "Two", "host-b"), "window", "digest");
    vi.advanceTimersByTime(NOTIFICATION_DIGEST_WINDOW_MS);
    expect(deliver.mock.calls[2][0].data.digestSessionCount).toBe(2);
  });

  it("switches back to immediate delivery without leaving a pending timer", () => {
    const deliver = vi.fn();
    const digest = new NotificationDigest(deliver);
    const first = completion("one");
    const second = completion("two");
    digest.send(first, "window", "digest");
    digest.send(second, "window", "immediate");
    expect(deliver.mock.calls).toEqual([
      [first, "window"],
      [second, "window"],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
