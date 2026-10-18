import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSenderDaemon, isChatProcess, resolveSender, type ProcessInfo } from "./send-sender";

// Fulcra 0.2.8 reporting lines: the CLI says which chat sends. No stamp means the owner.

const proc = (command: string, args = command): ProcessInfo => ({ pid: 2, ppid: 1, command, args });
const terminal = () => [
  proc("/bin/zsh"),
  proc("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
];
const insideClaude = () => [proc("/bin/zsh"), proc("claude"), proc("/bin/zsh")];

describe("send sender", () => {
  it("stamps the chat from PASEO_AGENT_ID", () => {
    expect(resolveSender({ env: { PASEO_AGENT_ID: " lead-1 " }, ancestors: insideClaude })).toEqual(
      {
        agentId: "lead-1",
      },
    );
  });

  it("treats a send from a terminal with no chat above it as the owner", () => {
    expect(resolveSender({ env: {}, ancestors: terminal })).toBeNull();
  });

  it("refuses a send from inside a chat that has no identity", () => {
    expect(() => resolveSender({ env: {}, ancestors: insideClaude })).toThrow(
      expect.objectContaining({
        code: "SENDER_UNKNOWN",
        message: "This send comes from a chat with no identity; send it from your own chat",
      }),
    );
  });

  it("reads --from as a chat on another computer, and keeps a chat from using another chat's id", () => {
    expect(resolveSender({ from: "book-lead@srv_book", env: {}, ancestors: terminal })).toEqual({
      agentId: "book-lead",
      serverId: "srv_book",
    });
    expect(() =>
      resolveSender({ from: "main-1", env: { PASEO_AGENT_ID: "work-1" }, ancestors: terminal }),
    ).toThrow(expect.objectContaining({ code: "INVALID_FROM" }));
    // A chat cannot use its own id with a made-up server to pass as remote, nor drop its id and use --from.
    expect(() =>
      resolveSender({
        from: "work-1@srv_x",
        env: { PASEO_AGENT_ID: "work-1" },
        ancestors: terminal,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_FROM" }));
    expect(() => resolveSender({ from: "main-1", env: {}, ancestors: insideClaude })).toThrow(
      expect.objectContaining({ code: "INVALID_FROM" }),
    );
    expect(() => resolveSender({ from: "a@b@c", env: {}, ancestors: terminal })).toThrow(
      expect.objectContaining({ code: "INVALID_FROM" }),
    );
  });

  it("knows the provider CLIs, also when they run under node", () => {
    expect(isChatProcess(proc("/opt/homebrew/bin/codex"))).toBe(true);
    expect(
      isChatProcess(
        proc("node", "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
      ),
    ).toBe(true);
    expect(isChatProcess(proc("node", "node /Users/d/app/server.js"))).toBe(false);
    expect(isChatProcess(proc("/bin/zsh"))).toBe(false);
  });
});

it("binds a stamped sender to its own daemon, even with another selected endpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "sender-host-"));
  try {
    await writeFile(join(home, "server-id"), "own-host\n");
    const sender = { agentId: "worker" };
    await assertSenderDaemon({ sender, serverId: "own-host", env: { PASEO_HOME: home } });
    await expect(
      assertSenderDaemon({ sender, serverId: "selected-other-host", env: { PASEO_HOME: home } }),
    ).rejects.toMatchObject({ code: "SENDER_HOST_MISMATCH" });
    await assertSenderDaemon({
      sender: { agentId: "remote", serverId: "original-host" },
      serverId: "selected-other-host",
      env: {},
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
