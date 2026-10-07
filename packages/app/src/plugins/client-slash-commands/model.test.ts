import { describe, expect, it, vi } from "vitest";
import {
  executePluginClientSlashCommand,
  mergeSlashCommandSources,
  resolvePluginClientSlashCommand,
  unhandledSlashCommandError,
} from "./model";

describe("plugin client slash commands", () => {
  it("keeps leading absolute file paths as prompts, including attachments", () => {
    for (const text of [
      "/Volumes/x",
      "/Volumes/work/repo/foo.ts fix this",
      "/tmp/x.log why did this fail",
    ]) {
      expect(
        unhandledSlashCommandError({ text, hasAttachments: false, providerCommands: [] }),
      ).toBeNull();
      expect(
        unhandledSlashCommandError({ text, hasAttachments: true, providerCommands: [] }),
      ).toBeNull();
    }
  });
  it("refuses unknown or unavailable account commands before model submission", () => {
    const input = {
      hasAttachments: false,
      providerCommands: [{ name: "compact" }, { name: "account" }],
    };
    expect(unhandledSlashCommandError({ ...input, text: "/unknown details" })).toContain(
      "Unknown slash command",
    );
    expect(unhandledSlashCommandError({ ...input, text: "/foo" })).toContain(
      "Unknown slash command",
    );
    expect(unhandledSlashCommandError({ ...input, text: "/account Personal" })).toContain(
      "Account switching is unavailable",
    );
    expect(unhandledSlashCommandError({ ...input, text: "/compact" })).toBeNull();
    expect(unhandledSlashCommandError({ ...input, text: "hello /unknown" })).toBeNull();
    expect(
      unhandledSlashCommandError({ ...input, text: "/account list", hasAttachments: true }),
    ).toContain("Remove them");
  });
  it("uses built-in, plugin, then provider precedence", () => {
    const collision = vi.fn();
    const result = mergeSlashCommandSources({
      builtIn: [{ name: "clear", aliases: ["new"] }],
      plugins: [
        { name: "clear", pluginId: "review" },
        { name: "new", pluginId: "alias-collision" },
        { name: "review", pluginId: "alpha" },
        { name: "review", pluginId: "beta" },
      ],
      provider: [{ name: "review" }, { name: "usage" }],
      onPluginCollision: collision,
    });

    expect(result.map(({ source, command }) => `${source}:${command.name}`)).toEqual([
      "built-in:clear",
      "plugin:review",
      "provider:usage",
    ]);
    expect(collision).toHaveBeenCalledTimes(3);
  });

  it("passes the trimmed raw remainder as args", () => {
    const command = { name: "review" };
    expect(
      resolvePluginClientSlashCommand({
        text: "  /review   foo bar  ",
        hasAttachments: false,
        commands: [command],
      }),
    ).toEqual({ command, args: "foo bar" });
    expect(
      resolvePluginClientSlashCommand({
        text: "/review foo",
        hasAttachments: true,
        commands: [command],
      }),
    ).toBeNull();
  });

  it("runs the client handler and reports failures", async () => {
    const run = vi.fn(async (_args: string) => undefined);
    const onError = vi.fn();
    await executePluginClientSlashCommand({ command: { run }, args: "foo", onError });
    expect(run).toHaveBeenCalledWith("foo");
    expect(onError).not.toHaveBeenCalled();

    const failure = new Error("review failed");
    await executePluginClientSlashCommand({
      command: { run: vi.fn().mockRejectedValue(failure) },
      args: "bar",
      onError,
    });
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("does not make the composer wait for a never-resolving handler", () => {
    const run = vi.fn(() => new Promise<void>(() => undefined));

    expect(
      executePluginClientSlashCommand({ command: { run }, args: "foo", onError: vi.fn() }),
    ).toBeUndefined();
    expect(run).toHaveBeenCalledWith("foo");
  });
});
