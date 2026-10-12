import { describe, expect, it } from "vitest";
import { AskCommandError, DEFAULT_ASK_MODEL, createAskCommand, runAsk } from "./ask.js";

const answer = { output: "hi", account: "Work", model: "claude-haiku-5-5", costUsd: 0.001 };
const input = { prompt: "Say hi", model: "claude-haiku-5-5", timeoutMs: 5000 };
const instant = async () => {};

function client(views: unknown[]) {
  const calls: Array<{ method: string; input: unknown }> = [];
  let polled = 0;
  return {
    calls,
    invokePluginRpc: async (_plugin: string, method: string, body: unknown) => {
      calls.push({ method, input: body });
      if (method === "organization.ask.start")
        return { id: "11111111-1111-4111-8111-111111111111" };
      return views[Math.min(polled++, views.length - 1)];
    },
  };
}

describe("fulcra ask", () => {
  it("starts the call, reads its result until it is done, and returns the answer", async () => {
    const c = client([{ state: "running" }, { state: "done", result: answer }]);
    const result = await runAsk(
      c,
      { ...input, account: "Work", schema: { type: "object" } },
      { sleep: instant },
    );
    expect(result).toEqual(answer);
    expect(c.calls[0]).toEqual({
      method: "organization.ask.start",
      input: {
        prompt: "Say hi",
        model: "claude-haiku-5-5",
        schema: { type: "object" },
        account: "Work",
        timeoutMs: 5000,
      },
    });
    expect(c.calls.map((call) => call.method)).toEqual([
      "organization.ask.start",
      "organization.ask.result",
      "organization.ask.result",
    ]);
  });

  it("fails with the host's code and message when the call failed", async () => {
    const c = client([
      {
        state: "failed",
        error: { code: "ALL_LIMITED", message: "Every usable Claude account is at its limit" },
      },
    ]);
    await expect(runAsk(c, input, { sleep: instant })).rejects.toMatchObject({
      code: "ALL_LIMITED",
      message: "Every usable Claude account is at its limit",
    });
  });

  it("gives up with TIMEOUT when the host never finishes", async () => {
    let time = 0;
    const c = client([{ state: "running" }]);
    const error = await runAsk(c, input, {
      sleep: async () => {
        time += 20_000;
      },
      now: () => time,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AskCommandError);
    expect((error as AskCommandError).code).toBe("TIMEOUT");
  });

  it("defines the command with the model default and the options the apps need", () => {
    const cmd = createAskCommand();
    const names = cmd.options.map((o) => o.long);
    expect(names).toEqual(
      expect.arrayContaining([
        "--model",
        "--output-schema",
        "--timeout",
        "--account",
        "--host",
        "--home",
      ]),
    );
    expect(cmd.options.find((o) => o.long === "--model")?.defaultValue).toBe(DEFAULT_ASK_MODEL);
    expect(DEFAULT_ASK_MODEL).toBe("claude-sonnet-5-5");
  });
});

describe("fulcra run --account", () => {
  const accounts = (list: unknown[]) => ({
    invokePluginRpc: async () => ({ accounts: list }),
    fetchAgent: async () => null,
  });
  const work = { id: "a1", name: "Work", provider: "claude", status: { state: "ok" } };

  it("returns the account's name for a usable account, by name or ID, in any case", async () => {
    const { resolveRunAccount } = await import("./account.js");
    expect(await resolveRunAccount(accounts([work]), "work", "claude")).toBe("Work");
    expect(await resolveRunAccount(accounts([work]), "A1", "claude")).toBe("Work");
  });

  it("fails plainly for an unknown account, a limited one, or one of another provider", async () => {
    const { resolveRunAccount } = await import("./account.js");
    const limited = { ...work, status: { state: "limited", until: "2026-10-13T08:00:00.000Z" } };
    await expect(resolveRunAccount(accounts([work]), "Nobody", "claude")).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    });
    await expect(resolveRunAccount(accounts([limited]), "Work", "claude")).rejects.toMatchObject({
      code: "ACCOUNT_LIMITED",
      message: 'Account "Work" cannot be used now (limited until 2026-10-13T08:00:00.000Z)',
    });
    await expect(resolveRunAccount(accounts([work]), "Work", "codex")).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    });
  });
});

describe("fulcra ask on Windows", () => {
  it("tells the user in --help to send the prompt on stdin and the schema as a file", () => {
    const help = createAskCommand().helpInformation().replace(/\s+/g, " ");
    expect(help).toMatch(/On Windows, send the prompt on standard input/);
    expect(help).toMatch(/On Windows, use a file path/);
  });

  it("measures the whole ask from before the start call, so the host's single deadline is never outlasted", async () => {
    let time = 0;
    let polls = 0;
    const c = {
      invokePluginRpc: async (_plugin: string, method: string) => {
        if (method === "organization.ask.start") {
          time += 20_000; // a slow start
          return { id: "11111111-1111-4111-8111-111111111111" };
        }
        polls += 1;
        return { state: "running" };
      },
    };
    const error = await runAsk(c, input, {
      sleep: async () => {
        time += 20_000;
      },
      now: () => time,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "TIMEOUT" });
    // Deadline = start (0) + 5 s + 30 s margin: the first poll, at 40 s, is already past it.
    expect(polls).toBe(1);
  });
});
