import { expect, test, vi } from "vitest";
import type { AgentManager } from "./agent/agent-manager.js";
import { FINAL_INPUT_CHECK, type AgentTimelineItem } from "./agent/agent-sdk-types.js";
import {
  assertFinalInputCheck,
  failFinalInputHandoff,
  recordFinalInputHandoff,
} from "./agent/final-input-check.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { IDLE_TURN_PROMPT, IdleTurnRecovery, unfinishedIdleTurn } from "./idle-turn-recovery.js";

const user = (text = "finish the work"): AgentTimelineItem => ({ type: "user_message", text });
const text = (value: string): AgentTimelineItem => ({ type: "assistant_message", text: value });
const tool: AgentTimelineItem = {
  type: "tool_call",
  callId: "job",
  name: "shell",
  status: "completed",
  error: null,
  detail: { type: "unknown", output: "job started" },
};

test("unfinishedIdleTurn detects tool or waiting endings and excludes current-turn result lines", () => {
  expect(unfinishedIdleTurn([user(), tool])).toEqual({ retried: false });
  expect(unfinishedIdleTurn([user(), text("I'll wait for the background job notice.")])).toEqual({
    retried: false,
  });
  expect(unfinishedIdleTurn([user(IDLE_TURN_PROMPT), tool])).toEqual({ retried: true });
  for (const result of ["DONE", "BLOCKED", "DECISION", "QUESTION", "RISK"]) {
    expect(unfinishedIdleTurn([user(), text(`${result}: result`), tool])).toBeNull();
  }
  expect(unfinishedIdleTurn([user(), text("The answer is 42.")])).toBeNull();
  expect(unfinishedIdleTurn([user(), text("I will wait for your approval.")])).toBeNull();
  expect(unfinishedIdleTurn([user(), text("DONE old task"), user(), tool])).toEqual({
    retried: false,
  });
  expect(unfinishedIdleTurn([])).toBeNull();
  // FU-611: a deliberate WAITING line is not an unfinished turn, also when a tool call follows.
  expect(unfinishedIdleTurn([user(), text("WAITING for the worker job q123"), tool])).toBeNull();
  expect(unfinishedIdleTurn([user(), text("**WAITING** q123")])).toBeNull();
});

function fixture() {
  const live = {
    id: "worker",
    instanceId: "instance",
    lifecycle: "idle",
    internal: false,
    archivedAt: undefined as string | undefined,
    lastUserMessageAt: new Date("2026-10-25T00:00:00Z"),
    labels: {} as Record<string, string>,
  };
  let items = [user(), tool];
  let allowed = true;
  let stopped = false;
  const pending: Array<{ id: string }> = [];
  const blocked = vi.fn(async (_id: string, _reason: string) => {});
  const manager = {
    getAgent: () => live,
    getTimeline: () => items,
    hasInFlightRun: () => false,
    canRunUnscopedLimitResume: () => allowed,
    getPendingPermissions: () => pending,
    runAgent: vi.fn(async (_id, _prompt, options) => {
      assertFinalInputCheck(options[FINAL_INPUT_CHECK]);
      recordFinalInputHandoff(options[FINAL_INPUT_CHECK]);
      return {} as never;
    }),
  };
  const deps = {
    agentManager: manager as unknown as AgentManager,
    logger: createTestLogger(),
    stopped: () => stopped,
    blocked,
  };
  return {
    live,
    manager,
    deps,
    blocked,
    pending,
    setItems: (next: AgentTimelineItem[]) => {
      items = next;
    },
    setAllowed: (next: boolean) => {
      allowed = next;
    },
    stop: () => {
      stopped = true;
    },
  };
}

test("handle continues once, ignores duplicate endings, and retains the retry fence through service recreation", async () => {
  const f = fixture();
  const recovery = new IdleTurnRecovery(f.deps);
  expect(await recovery.handle("worker")).toBe(true);
  expect(await recovery.handle("worker")).toBe(true);
  expect(f.manager.runAgent).toHaveBeenCalledTimes(1);
  expect(f.manager.runAgent.mock.calls[0]![1]).toBe(IDLE_TURN_PROMPT);
  f.setItems([user(), tool, user(IDLE_TURN_PROMPT), text("I will wait for the background job.")]);
  const restarted = new IdleTurnRecovery(f.deps);
  await restarted.handle("worker");
  await restarted.handle("worker");
  expect(f.manager.runAgent).toHaveBeenCalledTimes(1);
  expect(f.blocked).toHaveBeenCalledTimes(1);
  expect(f.blocked.mock.calls[0]![1]).toContain("after one automatic continuation");
});

test("continueOne withdraws at the final write when input safety changes during provider preparation, without a BLOCKED notice", async () => {
  for (const change of [
    "message",
    "instance",
    "archive",
    "owner",
    "permission",
    "hold",
    "limit",
    "stop",
  ]) {
    const f = fixture();
    f.manager.runAgent.mockImplementation(async (_id, _prompt, options) => {
      switch (change) {
        case "message":
          f.live.lastUserMessageAt = new Date("2026-10-25T00:01:00Z");
          break;
        case "instance":
          f.live.instanceId = "replacement";
          break;
        case "archive":
          f.live.archivedAt = "now";
          break;
        case "owner":
          f.setAllowed(false);
          break;
        case "permission":
          f.pending.push({ id: "request" });
          break;
        case "hold":
          f.live.labels["fulcra.hold"] = "paused";
          break;
        case "limit":
          f.live.labels["fulcra.limit-resume"] = "off";
          break;
        case "stop":
          f.stop();
          break;
      }
      assertFinalInputCheck(options[FINAL_INPUT_CHECK]);
      recordFinalInputHandoff(options[FINAL_INPUT_CHECK]);
      return {} as never;
    });
    expect(await new IdleTurnRecovery(f.deps).handle("worker")).toBe(true);
    expect(f.blocked).not.toHaveBeenCalled();
  }
});

test("FU-611: an idle lead whose continuation the safety check refuses gets no BLOCKED notice", async () => {
  for (const ending of [tool, text("I will wait for the worker to finish the job.")]) {
    const f = fixture();
    f.setItems([user(), ending]);
    f.setAllowed(false);
    expect(await new IdleTurnRecovery(f.deps).handle("worker")).toBe(true);
    expect(f.manager.runAgent).not.toHaveBeenCalled();
    expect(f.blocked).not.toHaveBeenCalled();
  }
});

test("FU-611: a real failure of an allowed continuation still sends BLOCKED", async () => {
  const f = fixture();
  f.manager.runAgent.mockImplementation(async (_id, _prompt, options) => {
    failFinalInputHandoff(options[FINAL_INPUT_CHECK], new Error("transport closed"));
    return {} as never;
  });
  await new IdleTurnRecovery(f.deps).handle("worker");
  expect(f.blocked).toHaveBeenCalledTimes(1);
  expect(f.blocked.mock.calls[0]![1]).toContain("could not be continued safely");
});
