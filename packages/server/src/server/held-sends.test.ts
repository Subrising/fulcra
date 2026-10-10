import { describe, expect, test } from "vitest";
import type { AgentManagerEvent } from "./agent/agent-manager.js";
import { deliveryWithReceipt, HeldSends } from "./held-sends.js";

const TARGET = "33333333-3333-4333-8333-333333333333";

function fixture() {
  const busy = new Set<string>();
  let listener: ((event: AgentManagerEvent) => void) | null = null;
  const warnings: unknown[] = [];
  const held = new HeldSends({
    isBusy: (id) => busy.has(id),
    subscribe: (next) => {
      listener = next;
      return () => (listener = null);
    },
    logger: { warn: (...args: unknown[]) => warnings.push(args), info: () => undefined },
  });
  const delivered: string[] = [];
  /** A delivery starts a turn on the target, as a real send does. */
  const deliver = (label: string) => async () => {
    delivered.push(label);
    busy.add(TARGET);
  };
  const endTurn = () => {
    busy.delete(TARGET);
    listener?.({
      type: "agent_stream",
      agentId: TARGET,
      event: { type: "turn_completed", provider: "claude" },
    } as AgentManagerEvent);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { held, busy, delivered, deliver, endTurn, settle, warnings };
}

describe("held sends", () => {
  test("a send to an idle target is delivered at once", async () => {
    const f = fixture();
    f.held.hold(TARGET, f.deliver("a"));
    await f.settle();
    expect(f.delivered).toEqual(["a"]);
  });

  test("sends to a busy target wait for each turn to end and keep their order", async () => {
    const f = fixture();
    f.busy.add(TARGET);
    f.held.hold(TARGET, f.deliver("a"));
    f.held.hold(TARGET, f.deliver("b"));
    f.held.hold(TARGET, f.deliver("c"));
    await f.settle();
    expect(f.delivered).toEqual([]);
    expect(f.held.pending(TARGET)).toBe(3);
    f.endTurn();
    await f.settle();
    expect(f.delivered).toEqual(["a"]);
    f.endTurn();
    await f.settle();
    f.endTurn();
    await f.settle();
    expect(f.delivered).toEqual(["a", "b", "c"]);
    expect(f.held.pending(TARGET)).toBe(0);
  });

  test("a send that finds a new turn at delivery stays first in line", async () => {
    const f = fixture();
    let tries = 0;
    f.held.hold(TARGET, async () => {
      tries += 1;
      if (tries === 1) {
        f.busy.add(TARGET);
        throw Object.assign(new Error("busy"), { code: "STEER_UNAVAILABLE" });
      }
      f.delivered.push("a");
    });
    f.held.hold(TARGET, f.deliver("b"));
    await f.settle();
    expect(f.delivered).toEqual([]);
    f.endTurn();
    await f.settle();
    expect(f.delivered).toEqual(["a", "b"]);
    expect(f.warnings).toEqual([]);
  });

  test("a held message that the reporting line refuses at delivery tells the sender why", async () => {
    const f = fixture();
    const told: string[] = [];
    let line: string | null = null;
    f.busy.add(TARGET);
    f.held.hold(
      TARGET,
      deliveryWithReceipt({
        recheck: async () => line,
        deliver: f.deliver("a"),
        tellSender: (reason) => told.push(reason),
      }),
    );
    // The line changes while the message waits.
    line = "Send this to your lead, Lead (11111111).";
    f.endTurn();
    await f.settle();
    expect(f.delivered).toEqual([]);
    expect(told).toEqual(["Send this to your lead, Lead (11111111)."]);
  });

  test("a held message whose delivery fails tells the sender; a target busy again keeps it waiting", async () => {
    const f = fixture();
    const told: string[] = [];
    let tries = 0;
    f.held.hold(
      TARGET,
      deliveryWithReceipt({
        recheck: async () => null,
        deliver: async () => {
          tries += 1;
          if (tries === 1) {
            f.busy.add(TARGET);
            throw Object.assign(new Error("busy"), { code: "STEER_UNAVAILABLE" });
          }
          throw new Error("Agent is archived");
        },
        tellSender: (reason) => told.push(reason),
      }),
    );
    await f.settle();
    expect(told).toEqual([]);
    f.endTurn();
    await f.settle();
    expect(told).toEqual(["Agent is archived"]);
    expect(f.warnings).toEqual([]);
  });
});
