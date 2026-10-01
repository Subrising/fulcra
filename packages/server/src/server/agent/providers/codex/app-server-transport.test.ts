import { createFinalInputCheck } from "../../final-input-check.js";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  createCodexAppServerChildProcess,
  createFakeCodexAppServer,
} from "./test-utils/fake-app-server.js";
import { CodexAppServerClient } from "./app-server-transport.js";

describe("Codex app-server transport", () => {
  test("ignores non-JSON stdout lines without dropping pending requests", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());

    const request = client.request("model/list", {});
    child.stdout.write("Codex ha iniciado en modo localizado\n");
    child.stdout.write('{"id":1,"result":{"data":[]}}\n');

    await expect(request).resolves.toEqual({ data: [] });
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  test("dispose rejects pending requests instead of leaving them hanging", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());

    const request = client.request("initialize", {});
    await client.dispose();

    await expect(request).rejects.toThrow("Codex app-server client is closed");
  });

  test("dispose rejects until the child has actually exited", async () => {
    vi.useFakeTimers();
    const child = createCodexAppServerChildProcess();
    child.kill = () => true;
    const client = new CodexAppServerClient(child, createTestLogger());
    try {
      for (let i = 0; i < 2; i++) {
        const closing = expect(client.dispose()).rejects.toThrow(
          "did not report exit after SIGKILL",
        );
        await vi.advanceTimersByTimeAsync(3_000);
        await closing;
      }
      child.exitCode = 0;
      child.emit("exit", 0, null);
      await expect(client.dispose()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      child.stdout.end();
      child.stderr.end();
    }
  });

  test.each([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "tool/requestUserInput",
  ])("answers server-initiated %s requests through registered handlers", async (method) => {
    const codex = createFakeCodexAppServer();
    const client = new CodexAppServerClient(codex.child, createTestLogger());
    const handlerCalls: unknown[] = [];
    client.setRequestHandler(method, async (params) => {
      handlerCalls.push(params);
      return { ok: true };
    });

    const response = codex.nextResponse();
    codex.child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: {} })}\n`);

    await expect(response).resolves.toBe('{"id":7,"result":{"ok":true}}\n');
    expect(handlerCalls).toEqual([{}]);
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });

  test("forks a Codex thread through thread/fork", async () => {
    const codex = createFakeCodexAppServer({
      "thread/fork": (params) => ({
        thread: {
          id: "forked-thread",
          sessionId: "forked-session",
          forkedFromId: (params as { threadId?: string }).threadId,
          turns: [],
        },
        model: "gpt-5.4",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace/project",
        runtimeWorkspaceRoots: [],
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: null,
        sandbox: { type: "workspaceWrite", networkAccess: false },
        activePermissionProfile: null,
        reasoningEffort: null,
      }),
    });
    const client = new CodexAppServerClient(codex.child, createTestLogger());

    const forked = await client.forkThread({
      threadId: "source-thread",
      cwd: "/workspace/project",
      excludeTurns: true,
    });

    expect(forked.thread.id).toBe("forked-thread");
    expect(forked.thread.forkedFromId).toBe("source-thread");
    codex.assertNoErrors();
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });

  test("rolls back a Codex thread by N turns", async () => {
    const codex = createFakeCodexAppServer({
      "thread/rollback": (params) => {
        expect(params).toEqual({ threadId: "forked-thread", numTurns: 2 });
        return {
          thread: {
            id: "forked-thread",
            sessionId: "forked-session",
            turns: [{ id: "remaining-turn" }],
          },
        };
      },
    });
    const client = new CodexAppServerClient(codex.child, createTestLogger());

    const rolledBack = await client.rollbackThread({
      threadId: "forked-thread",
      numTurns: 2,
    });

    expect(rolledBack.thread.id).toBe("forked-thread");
    expect(rolledBack.thread.turns).toEqual([{ id: "remaining-turn" }]);
    codex.assertNoErrors();
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });
});

// Real JSON-RPC transport over fake process streams: no provider process or credentials.
describe("native queued transport boundary", () => {
  async function fixture() {
    const { createNativeQueuedDispatch, nativeQueuedAcceptance, isNativeQueuedRefusal } =
      await import("../../native-queued-dispatch.js");
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const writes: Array<{ id: number; method: string; params: unknown }> = [];
    child.stdin.on("data", (chunk) => writes.push(JSON.parse(String(chunk))));
    return {
      child,
      client,
      writes,
      createNativeQueuedDispatch,
      nativeQueuedAcceptance,
      isNativeQueuedRefusal,
      cleanup() {
        child.stdout.end();
        child.stderr.end();
        child.stdin.end();
      },
    };
  }
  test("fresh authority is adjacent to the synchronous captured write and response ID", async () => {
    const f = await fixture();
    const order: string[] = [];
    f.child.stdin.on("data", () => {
      order.push("write");
      f.child.stdout.write(
        JSON.stringify({
          id: 1,
          result: { turn: { id: "native-turn", status: "inProgress", error: null } },
        }) + "\n",
      );
    });
    const capability = f.createNativeQueuedDispatch(() => order.push("authority"));
    try {
      const pending = f.client.requestNativeQueuedTurn(
        { threadId: "captured-thread", input: [{ type: "text", text: "throwaway" }] },
        capability,
        () => order.push("prepared"),
      );
      expect(order).toEqual(["authority", "prepared", "write"]);
      await expect(pending).resolves.toEqual({
        requestId: 1,
        threadId: "captured-thread",
        turnId: "native-turn",
      });
      expect(f.writes).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
  test.each(["revoked", "prepared-replaced", "spoof"])(
    "%s refuses before a single byte is written",
    async (mode) => {
      const f = await fixture();
      const capability =
        mode === "spoof"
          ? () => {}
          : f.createNativeQueuedDispatch(() => {
              if (mode === "revoked") throw new Error("revoked");
            });
      try {
        await expect(
          f.client.requestNativeQueuedTurn({ threadId: "thread" }, capability, () => {
            if (mode === "prepared-replaced") throw new Error("prepared replacement");
          }),
        ).rejects.toThrow();
        expect(f.writes).toHaveLength(0);
      } finally {
        f.cleanup();
      }
    },
  );
  test.each(["authority", "prepared"])(
    "asynchronous %s callback cannot cross the synchronous effect boundary",
    async (mode) => {
      const f = await fixture();
      const capability = f.createNativeQueuedDispatch(
        mode === "authority" ? async () => {} : () => {},
      );
      try {
        await expect(
          f.client.requestNativeQueuedTurn(
            { threadId: "thread" },
            capability,
            mode === "prepared" ? async () => {} : () => {},
          ),
        ).rejects.toThrow("synchronous");
        expect(f.writes).toHaveLength(0);
      } finally {
        f.cleanup();
      }
    },
  );
  test.each([
    {},
    { turn: { id: "native", status: "failed", error: null } },
    { turn: { id: "native", status: "inProgress", error: { message: "failure" } } },
    { threadId: "other", turn: { id: "native", status: "inProgress", error: null } },
    { turn: { id: "", status: "inProgress", error: null } },
  ])("malformed or negative response %j cannot claim native acceptance", async (result) => {
    const f = await fixture();
    const capability = f.createNativeQueuedDispatch(() => {});
    try {
      const pending = f.client.requestNativeQueuedTurn(
        { threadId: "thread" },
        capability,
        () => {},
      );
      f.child.stdout.write(JSON.stringify({ id: 1, result }) + "\n");
      await expect(pending).rejects.toThrow("acknowledgement invalid");
      expect(f.writes).toHaveLength(1);
      expect(f.nativeQueuedAcceptance(capability)).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });
  test("an unrelated response cannot satisfy this attempted request; timeout cannot replay", async () => {
    const f = await fixture();
    const capability = f.createNativeQueuedDispatch(() => {});
    try {
      const pending = f.client.requestNativeQueuedTurn(
        { threadId: "thread" },
        capability,
        () => {},
        10,
      );
      f.child.stdout.write(
        JSON.stringify({
          id: 99,
          result: { turn: { id: "wrong", status: "inProgress", error: null } },
        }) + "\n",
      );
      await expect(pending).rejects.toThrow("timed out");
      await expect(
        f.client.requestNativeQueuedTurn({ threadId: "thread" }, capability, () => {}),
      ).rejects.toThrow("already attempted");
      expect(f.writes).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
  test("transport loss after submission remains uncertain; a late callback cannot submit again", async () => {
    const f = await fixture();
    const capability = f.createNativeQueuedDispatch(() => {});
    try {
      const pending = f.client.requestNativeQueuedTurn(
        { threadId: "thread" },
        capability,
        () => {},
      );
      f.child.emit("exit", 1, null);
      await expect(pending).rejects.toThrow("exited");
      expect(f.nativeQueuedAcceptance(capability)).toBeUndefined();
      expect(f.writes).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
});

describe("private final notice transport", () => {
  test.each(["spoof", "async", "serialization-revoke", "prepared-async"])(
    "%s refuses before any write",
    async (mode) => {
      const server = createFakeCodexAppServer();
      const client = new CodexAppServerClient(server.child, createTestLogger());
      let allowed = true;
      const handle =
        mode === "spoof"
          ? {}
          : createFinalInputCheck(
              mode === "async"
                ? async () => {}
                : () => {
                    if (!allowed) throw new Error("superseded");
                  },
            );
      const params =
        mode === "serialization-revoke"
          ? {
              toJSON() {
                allowed = false;
                return {};
              },
            }
          : {};
      try {
        await expect(
          client.requestWithFinalInputCheck(
            "turn/steer",
            params,
            handle,
            mode === "prepared-async" ? async () => {} : () => {},
          ),
        ).rejects.toThrow();
        expect(server.requests()).toHaveLength(0);
      } finally {
        await client.dispose();
      }
    },
  );
});
