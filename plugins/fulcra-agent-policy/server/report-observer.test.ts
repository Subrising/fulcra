import { describe, expect, test } from "vitest";
import { ReportUpObserver, type ReportTurnEnd } from "./report-observer.mjs";

function fixture() {
  const ends: ReportTurnEnd[] = [];
  const permissions: string[] = [];
  const observer = new ReportUpObserver({
    now: () => 1000,
    noticePrefix: "daemon-finish:",
    isSystemInjectedEnvelope: (text) => text.startsWith("<paseo-system>"),
    onStarted: () => {},
    onEnded: (end) => ends.push(end),
    onPermission: (_id, request) => permissions.push(request.id),
  });
  return { observer, ends, permissions };
}

describe("report observer provenance", () => {
  test("a real prompt keeps its provenance with either native event order", () => {
    for (const firstMessageFirst of [false, true]) {
      const f = fixture();
      const message = { type: "user_message", text: "start the task" };
      if (firstMessageFirst) f.observer.firstMessage("worker", message);
      f.observer.turnStarted("worker");
      f.observer.firstMessage("worker", message);
      f.observer.firstMessage("worker", message);
      f.observer.turnEnded("worker", "completed");
      expect(f.ends).toMatchObject([{ fromNotice: false, fromNudge: false }]);
    }
  });

  test("nudge and notice replies keep their provenance", () => {
    const f = fixture();
    for (const message of [
      { type: "user_message", clientMessageId: "daemon-finish:idle-nudge:one" },
      { type: "user_message", clientMessageId: "daemon-finish:report-up:two" },
      { type: "user_message", text: "<paseo-system>notice</paseo-system>" },
    ]) {
      f.observer.turnStarted("worker");
      f.observer.firstMessage("worker", message);
      f.observer.turnEnded("worker", "completed");
    }
    expect(f.ends.map((end) => end.fromNotice)).toEqual([true, true, true]);
    expect(f.ends.map((end) => end.fromNudge)).toEqual([true, false, false]);
  });

  test("notice turns keep permission and failed-turn observations", () => {
    const f = fixture();
    f.observer.turnStarted("worker");
    f.observer.firstMessage("worker", {
      type: "user_message",
      clientMessageId: "daemon-finish:idle-nudge:one",
    });
    f.observer.permissionRequested("worker", { id: "request", name: "Bash", input: {} });
    f.observer.permissionRequested("worker", { id: "request", name: "Bash", input: {} });
    f.observer.turnEnded("worker", "failed", "usage limit");
    expect(f.permissions).toEqual(["request"]);
    expect(f.ends).toMatchObject([{ failed: true, failure: "usage limit", fromNudge: true }]);
  });
});

test("resolution and close invalidate the exact pending request", () => {
  const f = fixture();
  const first = { id: "same", name: "Bash" };
  const second = { id: "same", name: "AskUserQuestion" };
  f.observer.permissionRequested("worker", first);
  expect(f.observer.hasPermission("worker", first)).toBe(true);
  f.observer.permissionResolved("worker", first.id);
  f.observer.permissionRequested("worker", second);
  expect(f.observer.hasPermission("worker", first)).toBe(false);
  expect(f.observer.hasPermission("worker", second)).toBe(true);
  f.observer.close("worker");
  expect(f.observer.hasPermission("worker", second)).toBe(false);
});
