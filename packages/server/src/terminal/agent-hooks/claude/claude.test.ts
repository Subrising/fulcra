import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlatform } from "../../../test-utils/platform.js";
import { buildTerminalEnvironment } from "../../terminal.js";
import { buildAgentHookShellCommand, installAgentHooks } from "../agent-hook-installer.js";
import {
  AGENT_HOOK_PROVIDERS,
  installRegisteredAgentHooks,
  registeredAgentHooksAreInstalled,
  uninstallRegisteredAgentHooks,
} from "../provider-registry.js";

const temporaryDirs: string[] = [];
afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function createFakeCliBinDir(): string {
  const dir = createTempDir("paseo-cli-bin-");
  writeFileSync(join(dir, "paseo"), "");
  return dir;
}

interface TestClaudeSettings {
  hooks?: Record<string, unknown>;
  theme?: string;
}

function readSettings(configDir: string): TestClaudeSettings {
  return JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as {
    hooks?: Record<string, unknown>;
    theme?: string;
  };
}

function hookCommands(settings: { hooks?: Record<string, unknown> }, event: string): string[] {
  const entries = settings.hooks?.[event];
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      return [];
    }
    return entry.hooks
      .map((hook) => (isRecord(hook) ? hook.command : undefined))
      .filter((command): command is string => typeof command === "string");
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("Claude terminal agent hooks", () => {
  it("adopts unchanged shipped hook-only settings and upgrades their hooks", () => {
    const configDir = createTempDir("paseo-shipped-hooks-");
    const file = join(configDir, "settings.json");
    const shipped = readFileSync(new URL("./fixtures/shipped-settings.json", import.meta.url));
    writeFileSync(file, shipped);
    installRegisteredAgentHooks({ configDir });
    const record = join(configDir, ".settings.json.paseo-installed.sha256");
    expect(readFileSync(record, "utf8")).toMatch(/^[a-f0-9]{64}\n$/);
    const provider = AGENT_HOOK_PROVIDERS.claude;
    installAgentHooks(
      { ...provider, events: [...provider.events, { event: "TestBundledEvent" }] },
      { configDir },
    );
    expect(hookCommands(readSettings(configDir), "TestBundledEvent")).not.toHaveLength(0);
  });
  it("installs registered provider hooks idempotently", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const provider = AGENT_HOOK_PROVIDERS.claude;
    const install = provider.install;

    installRegisteredAgentHooks({ configDir });
    installRegisteredAgentHooks({ configDir });

    const settings = readSettings(configDir);
    for (const event of provider.events) {
      const paseoCommands = hookCommands(settings, event.event).filter((command) =>
        command.includes(install.hookMarker),
      );
      expect(paseoCommands).toHaveLength(1);
      expect(paseoCommands[0]).toBe(
        `if [ -n "$PASEO_TERMINAL_ID" ]; then "\${PASEO_HOOK_CLI:-paseo}" hooks ${provider.id} ${event.event}; fi`,
      );
    }
    expect(registeredAgentHooksAreInstalled({ configDir })).toBe(true);
  });

  it("preserves an existing settings file without an installation record", () => {
    const configDir = createTempDir("paseo-claude-config-preserve-");
    writeFileSync(
      join(configDir, "settings.json"),
      `${JSON.stringify(
        {
          theme: "dark",
          hooks: {
            Stop: [
              {
                matcher: "",
                hooks: [{ type: "command", command: "say done", timeout: 5 }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    installRegisteredAgentHooks({ configDir });

    const settings = readSettings(configDir);
    expect(settings.theme).toBe("dark");
    expect(hookCommands(settings, "Stop")).toContain("say done");
    expect(
      hookCommands(settings, "Stop").some((command) => command.includes("hooks claude Stop")),
    ).toBe(false);
  });

  it("preserves local settings edits during uninstall", () => {
    const configDir = createTempDir("paseo-claude-config-uninstall-");
    installRegisteredAgentHooks({ configDir });
    const settings = readSettings(configDir);
    settings.hooks = {
      ...settings.hooks,
      Stop: [
        ...(Array.isArray(settings.hooks?.Stop) ? settings.hooks.Stop : []),
        {
          matcher: "",
          hooks: [{ type: "command", command: "say still-here", timeout: 5 }],
        },
      ],
    };
    writeFileSync(join(configDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

    const editedBytes = readFileSync(join(configDir, "settings.json"), "utf8");
    uninstallRegisteredAgentHooks({ configDir });

    expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe(editedBytes);
    const nextSettings = readSettings(configDir);
    expect(hookCommands(nextSettings, "Stop")).toContain("say still-here");
    expect(registeredAgentHooksAreInstalled({ configDir })).toBe(false);
  });

  it("keeps edited settings through repeated installer runs", () => {
    const configDir = createTempDir("paseo-claude-edited-");
    installRegisteredAgentHooks({ configDir });
    const file = join(configDir, "settings.json");
    const settings = readSettings(configDir);
    settings.theme = "local-theme";
    const local = `${JSON.stringify(settings, null, 2)}\n`;
    writeFileSync(file, local);
    installRegisteredAgentHooks({ configDir });
    installRegisteredAgentHooks({ configDir });
    expect(readFileSync(file, "utf8")).toBe(local);
  });

  it("does not adopt user settings when the generated hooks already match", () => {
    const configDir = createTempDir("paseo-claude-owned-");
    installRegisteredAgentHooks({ configDir });
    const file = join(configDir, "settings.json");
    const record = join(configDir, ".settings.json.paseo-installed.sha256");
    const installedHash = readFileSync(record, "utf8");
    const settings = readSettings(configDir);
    settings.theme = "local-theme";
    const local = `${JSON.stringify(settings, null, 2)}\n`;
    writeFileSync(file, local);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      installRegisteredAgentHooks({ configDir });
      installRegisteredAgentHooks({ configDir });
      expect(readFileSync(file, "utf8")).toBe(local);
      expect(readFileSync(record, "utf8")).toBe(installedHash);
      expect(warn.mock.calls.filter((args) => args.includes(file))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps edited settings and offers changed hooks once", () => {
    const configDir = createTempDir("paseo-claude-update-offer-");
    installRegisteredAgentHooks({ configDir });
    const file = join(configDir, "settings.json");
    const settings = readSettings(configDir);
    settings.theme = "local-theme";
    settings.hooks = {};
    const local = `${JSON.stringify(settings, null, 2)}\n`;
    writeFileSync(file, local);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      installRegisteredAgentHooks({ configDir });
      installRegisteredAgentHooks({ configDir });
      expect(readFileSync(file, "utf8")).toBe(local);
      const proposed = JSON.parse(readFileSync(`${file}.new`, "utf8"));
      expect(proposed.theme).toBeUndefined();
      expect(Object.keys(proposed.hooks)).not.toHaveLength(0);
      expect(warn.mock.calls.filter((args) => args.includes(file))).toHaveLength(1);
      settings.theme = "another local theme";
      writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
      installRegisteredAgentHooks({ configDir });
      expect(warn.mock.calls.filter((args) => args.includes(file))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("builds a minimal gated hook command", () => {
    const provider = AGENT_HOOK_PROVIDERS.claude;
    const command = buildAgentHookShellCommand(provider, provider.events[0]);

    expect(command).toBe(
      'if [ -n "$PASEO_TERMINAL_ID" ]; then "${PASEO_HOOK_CLI:-paseo}" hooks claude UserPromptSubmit; fi',
    );
  });

  it.skipIf(isPlatform("win32")).each(AGENT_HOOK_PROVIDERS.claude.events)(
    "$event hook command exits 0 when PASEO_TERMINAL_ID is unset",
    (event) => {
      const provider = AGENT_HOOK_PROVIDERS.claude;
      const command = buildAgentHookShellCommand(provider, event);

      const result = spawnSync("/bin/sh", ["-c", command], {
        env: { PATH: process.env.PATH ?? "", PASEO_HOOK_CLI: "paseo" },
        stdio: "ignore",
      });

      expect(result.status).toBe(0);
    },
  );

  it("keeps provider names out of the generic server bootstrap", () => {
    const source = readFileSync(
      new URL("../../../server/bootstrap.ts", import.meta.url),
      "utf8",
    ).toLowerCase();

    for (const providerId of Object.keys(AGENT_HOOK_PROVIDERS)) {
      expect(source).not.toContain(providerId);
    }
  });

  it("prepends the paseo CLI directory and injects the hook CLI path", () => {
    const cliBinDir = createFakeCliBinDir();
    const hookCliPath = join(cliBinDir, "paseo");

    const env = buildTerminalEnvironment({
      shell: "/bin/sh",
      env: { PATH: ["/usr/bin", "/bin"].join(delimiter) },
      paseoCliBinDir: cliBinDir,
      paseoHookCliPath: hookCliPath,
    });

    expect(env.PATH?.split(delimiter)).toEqual([cliBinDir, "/usr/bin", "/bin"]);
    expect(env.PASEO_HOOK_CLI).toBe(hookCliPath);
  });

  it("leaves terminal PATH unchanged when the CLI directory cannot be resolved", () => {
    const env = buildTerminalEnvironment({
      shell: "/bin/sh",
      env: { PATH: ["/usr/bin", "/bin"].join(delimiter) },
      paseoCliBinDir: null,
    });

    expect(env.PATH?.split(delimiter)).toEqual(["/usr/bin", "/bin"]);
  });
});
