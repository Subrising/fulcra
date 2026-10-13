import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  currentLeadEvent,
  eventDispatcherEnabled,
  LeadEventDispatcher,
  LEAD_EVENT_KINDS,
  leadEventsPath,
  readLeadEvents,
  withLeadEvent,
} from "./lead-events.js";

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "lead-events-"));
  homes.push(home);
  const errors: unknown[] = [];
  let enabled = true;
  const dispatcher = new LeadEventDispatcher({
    home,
    enabled: () => enabled,
    now: () => 100,
    onError: (error) => errors.push(error),
  });
  return {
    home,
    dispatcher,
    errors,
    disable: () => {
      enabled = false;
    },
  };
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const finish = { eventId: "turn-1", sourceId: "worker-1", kind: "finished_turn", startedAt: 10 };

describe("deterministic lead events", () => {
  test("counts every accepted cause without message text", () => {
    const f = fixture();
    for (const kind of LEAD_EVENT_KINDS) f.dispatcher.recordTurn("lead-1", kind);
    expect(readLeadEvents(f.home).sessions["lead-1"]?.turns).toEqual(
      Object.fromEntries(LEAD_EVENT_KINDS.map((kind) => [kind, 1])),
    );
    expect(readFileSync(leadEventsPath(f.home), "utf8")).not.toContain("message");
  });
  test("finish events stay visible after a saved delivery", () => {
    const f = fixture();
    expect(f.dispatcher.suppress("lead-1", finish)).toBe(false);
    expect(f.dispatcher.suppress("lead-1", finish)).toBe(false);
    f.dispatcher.noteDelivered("lead-1", finish);
    expect(f.dispatcher.suppress("lead-1", finish)).toBe(false);
    expect(f.dispatcher.suppress("lead-2", finish)).toBe(false);
    expect(f.dispatcher.suppress("lead-1", { ...finish, sourceId: "worker-2" })).toBe(false);
    expect(readLeadEvents(f.home).sessions["lead-1"]?.digest).toEqual([]);
  });
  test.each(["delivery_receipt", "archive_done"])("records %s without a wake", (kind) => {
    const f = fixture();
    expect(f.dispatcher.suppress("lead-1", { ...finish, kind })).toBe(true);
    expect(readLeadEvents(f.home).sessions["lead-1"]?.digest[0]?.reason).toBe(kind);
  });
  test("a confirmed worker report does not suppress a finish notice", () => {
    const f = fixture();
    expect(f.dispatcher.suppress("lead-1", { ...finish, reportedAt: 9 })).toBe(false);
    f.dispatcher.noteReport("lead-1", finish.sourceId);
    expect(
      f.dispatcher.suppress("lead-1", {
        ...finish,
        reportedAt: f.dispatcher.reportAt("lead-1", finish.sourceId),
      }),
    ).toBe(false);
    expect(readLeadEvents(f.home).sessions["lead-1"]?.digest).toEqual([]);
  });
  test.each([
    "unknown_future_event",
    "permission",
    "limit",
    "failed_delivery",
    "worker_report",
    "nudge",
  ])("always delivers %s", (kind) => {
    const f = fixture();
    expect(f.dispatcher.suppress("lead-1", { ...finish, kind, reportedAt: 100 })).toBe(false);
  });
  test("a failed event still reaches the lead after its report", () => {
    const f = fixture();
    f.dispatcher.noteDelivered("lead-1", finish);
    expect(f.dispatcher.suppress("lead-1", { ...finish, failed: true, reportedAt: 100 })).toBe(
      false,
    );
  });
  test("digest and receipts survive a new daemon service", () => {
    const f = fixture();
    f.dispatcher.recordTurn("lead-1", "user");
    f.dispatcher.noteDelivered("lead-1", finish);
    f.dispatcher.suppress("lead-1", { ...finish, kind: "archive_done" });
    const restored = new LeadEventDispatcher({
      home: f.home,
      onError: (error) => f.errors.push(error),
    });
    expect(restored.suppress("lead-1", finish)).toBe(false);
    expect(readLeadEvents(f.home).sessions["lead-1"]?.digest.map((event) => event.reason)).toEqual([
      "archive_done",
    ]);
    expect(readLeadEvents(f.home).sessions["lead-1"]?.turns.user).toBe(1);
  });
  test("turning dispatch off restores delivery and retains counts", () => {
    const f = fixture();
    f.dispatcher.noteDelivered("lead-1", finish);
    f.disable();
    for (const kind of ["finished_turn", "delivery_receipt", "archive_done"])
      expect(f.dispatcher.suppress("lead-1", { ...finish, kind, reportedAt: 100 })).toBe(false);
    f.dispatcher.recordTurn("lead-1", "user");
    expect(readLeadEvents(f.home).sessions["lead-1"]?.turns.user).toBe(1);
  });
  test("unwritable state keeps normal delivery", () => {
    const f = fixture();
    rmSync(f.home, { recursive: true });
    writeFileSync(f.home, "blocking file");
    expect(f.dispatcher.suppress("lead-1", { ...finish, kind: "archive_done" })).toBe(false);
    expect(f.errors).toHaveLength(1);
  });
  test("corrupt state is reported rather than overwritten", () => {
    const f = fixture();
    writeFileSync(leadEventsPath(f.home), "invalid");
    expect(() => readLeadEvents(f.home)).toThrow();
    expect(() => new LeadEventDispatcher({ home: f.home, onError: () => {} })).toThrow();
    expect(readFileSync(leadEventsPath(f.home), "utf8")).toBe("invalid");
  });
  test("the saved switch takes effect without a restart; corrupt settings keep delivery", () => {
    const f = fixture();
    expect(eventDispatcherEnabled(f.home)).toBe(true);
    writeFileSync(
      join(f.home, "config.json"),
      JSON.stringify({ daemon: { eventDispatcherEnabled: false } }),
    );
    expect(eventDispatcherEnabled(f.home)).toBe(false);
    writeFileSync(
      join(f.home, "config.json"),
      JSON.stringify({ daemon: { eventDispatcherEnabled: "false" } }),
    );
    expect(eventDispatcherEnabled(f.home)).toBe(false);
    writeFileSync(join(f.home, "config.json"), "invalid");
    expect(eventDispatcherEnabled(f.home)).toBe(false);
  });
  test("host attribution keeps human input distinct from system notices", () => {
    expect(withLeadEvent("permission", () => currentLeadEvent("human"))).toBe("user");
    expect(withLeadEvent("permission", () => currentLeadEvent("daemon"))).toBe("permission");
    expect(currentLeadEvent("agent")).toBe("worker_report");
    expect(currentLeadEvent("plugin")).toBe("other");
    expect(currentLeadEvent("plugin", () => {})).toBe("queued_delivery");
    expect(currentLeadEvent(undefined)).toBe("other");
  });
});
