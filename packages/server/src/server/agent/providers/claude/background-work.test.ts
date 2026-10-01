import { describe, expect, test } from "vitest";
import { ClaudeBackgroundWorkTracker } from "./background-work.js";

// Recorded shapes of Claude Code's task protocol (see subagents/live-source.ts for the wire notes).
const started = (taskId: string, taskType: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: `toolu_${taskId}`,
  description: "npm run build",
  task_type: taskType,
  ...extra,
});
const notification = (taskId: string, status = "completed") => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  tool_use_id: `toolu_${taskId}`,
  status,
});
const updated = (taskId: string, patch: Record<string, unknown>) => ({
  type: "system",
  subtype: "task_updated",
  task_id: taskId,
  patch,
});

function tracker() {
  let clock = Date.parse("2026-09-27T09:00:00.000Z");
  const t = new ClaudeBackgroundWorkTracker(() => new Date(clock));
  return { t, advance: (ms: number) => (clock += ms) };
}

describe("ClaudeBackgroundWorkTracker", () => {
  test("a backgrounded shell counts until its notification closes it", () => {
    const { t, advance } = tracker();
    expect(t.observe(started("b1", "local_bash"))).toBe(true);
    expect(t.snapshot()).toMatchObject({
      count: 1,
      kinds: ["shell"],
      source: "provider",
      since: "2026-09-27T09:00:00.000Z",
    });
    advance(60_000);
    expect(t.observe(notification("b1"))).toBe(true);
    expect(t.snapshot()).toBeNull();
  });

  test("any notification status closes the task, and a repeat changes nothing", () => {
    const { t } = tracker();
    for (const status of ["completed", "failed", "stopped", "killed"]) {
      t.observe(started(status, "local_bash"));
      expect(t.observe(notification(status, status))).toBe(true);
    }
    expect(t.snapshot()).toBeNull();
    expect(t.observe(notification("completed"))).toBe(false);
  });

  test("a terminal task_updated closes the task too", () => {
    const { t } = tracker();
    t.observe(started("w1", "local_workflow"));
    expect(t.observe(updated("w1", { status: "completed" }))).toBe(true);
    expect(t.snapshot()).toBeNull();
  });

  test("subagents and housekeeping are not background work", () => {
    const { t } = tracker();
    expect(t.observe(started("a1", "local_agent", { subagent_type: "general-purpose" }))).toBe(
      false,
    );
    expect(t.observe(started("h1", "local_bash", { skip_transcript: true }))).toBe(false);
    expect(t.observe({ type: "assistant", task_id: "x" })).toBe(false);
    expect(t.snapshot()).toBeNull();
  });

  test("shells and workflows are counted together, oldest first", () => {
    const { t, advance } = tracker();
    t.observe(started("b1", "local_bash"));
    advance(5_000);
    t.observe(started("w1", "local_workflow"));
    expect(t.snapshot()).toMatchObject({
      count: 2,
      kinds: ["shell", "workflow"],
      since: "2026-09-27T09:00:00.000Z",
    });
  });

  test("a canceled turn drops foreground workflows and keeps backgrounded work", () => {
    const { t } = tracker();
    t.observe(started("b1", "local_bash"));
    t.observe(started("w1", "local_workflow"));
    t.observe(started("w2", "local_workflow"));
    t.observe(updated("w2", { is_backgrounded: true }));
    expect(t.cancelForeground()).toBe(true);
    expect(t.snapshot()).toMatchObject({ count: 2, kinds: ["shell", "workflow"] });
    expect(t.cancelForeground()).toBe(false);
  });

  test("the Claude process exiting ends every job", () => {
    const { t } = tracker();
    t.observe(started("b1", "local_bash"));
    expect(t.clear()).toBe(true);
    expect(t.snapshot()).toBeNull();
    expect(t.clear()).toBe(false);
  });
});
