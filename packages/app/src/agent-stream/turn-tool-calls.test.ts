import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { orderTailForStreamRenderStrategy } from "./strategy";
import { resolveStreamRenderStrategy } from "./strategy-resolver";
import { collectTurnToolCalls } from "./turn-tool-calls";

const at = new Date("2026-10-07T00:00:00.000Z");
const user = (id: string): StreamItem => ({ kind: "user_message", id, text: id, timestamp: at });
const assistant = (id: string): StreamItem => ({
  kind: "assistant_message",
  id,
  text: id,
  timestamp: at,
});
const shell = (id: string, command: string): StreamItem => ({
  kind: "tool_call",
  id,
  timestamp: at,
  payload: {
    source: "agent",
    data: {
      provider: "claude",
      callId: id,
      name: "Bash",
      status: "completed",
      error: null,
      detail: { type: "shell", command },
    },
  },
});

const chronological = [
  user("u1"),
  shell("t0", "earlier turn"),
  assistant("a0"),
  user("u2"),
  shell("t1", "ls"),
  assistant("a1"),
  shell("t2", "npm test"),
  assistant("a2"),
];

describe("collectTurnToolCalls", () => {
  it("returns only the closing turn's tool calls, oldest first, in either stream order", () => {
    const forward = resolveStreamRenderStrategy({ platform: "web", isMobileBreakpoint: false });
    const commands = (items: StreamItem[], strategy: typeof forward) =>
      collectTurnToolCalls({
        strategy,
        items,
        startIndex: items.findIndex((item) => item.id === "a2"),
      }).map((call) => (call.detail.type === "shell" ? call.detail.command : call.name));
    expect(commands(chronological, forward)).toEqual(["ls", "npm test"]);

    const inverted = resolveStreamRenderStrategy({
      platform: "android",
      isMobileBreakpoint: false,
    });
    const invertedItems = orderTailForStreamRenderStrategy({
      strategy: inverted,
      streamItems: chronological,
    });
    expect(commands(invertedItems, inverted)).toEqual(["ls", "npm test"]);
  });

  it("is empty for a turn without tools", () => {
    const forward = resolveStreamRenderStrategy({ platform: "web", isMobileBreakpoint: false });
    expect(
      collectTurnToolCalls({
        strategy: forward,
        items: [user("u"), assistant("a")],
        startIndex: 1,
      }),
    ).toEqual([]);
  });
});
