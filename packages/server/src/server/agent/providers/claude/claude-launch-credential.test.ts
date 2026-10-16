import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";

// Update-7 (Fulcra account pool): an account's token reaches the Claude CLI through the environment the
// agent.session_open hook returns, never through argv. This runs the real SDK query and the real spawn wrapper against
// a stub `claude` that records the argv it was given and the token it saw, so the argv checked is the one the provider
// actually builds. The token is a fake; nothing here touches a real account or the Keychain.
const TOKEN = `sk-ant-oat01-${"T".repeat(48)}`;
let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function waitFor(file: string, timeoutMs = 20000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error("The stub CLI was never started");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The real SDK spawn uses a POSIX executable stub; Windows provider/env adapter coverage remains elsewhere.
describe.runIf(process.platform !== "win32")("Claude launch credential", () => {
  test("a pooled account's token is in the CLI's environment and nowhere in its argv", async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fulcra-claude-argv-")));
    const argvFile = path.join(dir, "argv.json");
    const envFile = path.join(dir, "env.json");
    const stub = path.join(dir, "claude");
    writeFileSync(
      stub,
      `#!${process.execPath}\n` +
        `const fs = require("node:fs");\n` +
        `fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, apiKey: process.env.ANTHROPIC_API_KEY ?? null }));\n` +
        `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(1)));\n` +
        `process.exit(1);\n`,
    );
    chmodSync(stub, 0o700);

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => stub,
    });
    const session = await client.createSession(
      { provider: "claude", cwd: dir },
      // What the pool's session_open hook returns for a pooled Claude launch.
      {
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          FULCRA_ACCOUNT_ID: "00000000-0000-4000-8000-000000000001",
        },
      },
    );
    try {
      await session.run("hello").catch(() => undefined); // the stub is not a real CLI; only its launch matters
      await waitFor(argvFile);
    } finally {
      await session.close().catch(() => undefined);
    }

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const env = JSON.parse(readFileSync(envFile, "utf8")) as {
      token: string | null;
      apiKey: string | null;
    };
    expect(argv.length).toBeGreaterThan(0);
    expect(env.token).toBe(TOKEN);
    expect(env.apiKey).toBe("");
    expect(argv.join("\n")).not.toContain(TOKEN);
    expect(argv.join("\n")).not.toContain("sk-ant-");
  }, 60000);
});

test.runIf(process.platform === "win32")(
  "Windows cannot report a successful Claude turn through a POSIX credential stub",
  async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-posix-stub-windows-")));
    const marker = path.join(dir, "executed");
    const stub = path.join(dir, "claude");
    writeFileSync(stub, `#!/bin/sh\ntouch '${marker}'\n`);
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => stub,
    });
    const session = await client.createSession({ provider: "claude", cwd: dir });
    try {
      await expect(session.run("hello")).rejects.toThrow();
      expect(existsSync(marker)).toBe(false);
    } finally {
      await session.close().catch(() => undefined);
    }
  },
);

describe.runIf(process.platform !== "win32")("API key helper launch", () => {
  test("the real SDK passes only a helper setting and removes API keys from the CLI and tool environment", async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fulcra-api-helper-")));
    const capture = path.join(dir, "capture.json");
    const stub = path.join(dir, "claude");
    const key = `sk-ant-api03-${"SYNTHETIC".repeat(8)}`;
    const helper = "fixture-helper-command";
    const apiAccount = { root: dir, id: "00000000-0000-4000-8000-000000000001", epoch: null };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(dir, "accounts"));
    writeFileSync(
      path.join(dir, "accounts/accounts.json"),
      JSON.stringify({
        accounts: [
          {
            id: apiAccount.id,
            provider: "claude",
            enabled: true,
            auth: "ok",
            credentialKind: "api-key",
          },
        ],
      }),
    );
    writeFileSync(
      stub,
      `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv,env:process.env}));process.exit(1);\n`,
      { mode: 0o700 },
    );
    const savedEnvironment = process.env;
    try {
      process.env = { PATH: savedEnvironment.PATH, HOME: dir, TMPDIR: dir, COPY: key };
      const logs: string[] = [];
      const { default: pino } = await import("pino");
      const client = new ClaudeAgentClient({
        logger: pino(
          { level: "trace" },
          {
            write: (chunk: string) => {
              logs.push(chunk);
            },
          },
        ),
        resolveBinary: async () => stub,
        runtimeSettings: { env: { RUNTIME_COPY: key } },
      });
      const config = {
        provider: "claude" as const,
        cwd: dir,
        providerOptions: {
          settings: { apiKeyHelper: "untrusted-helper", env: { ANTHROPIC_API_KEY: key } },
        },
      };
      await expect(client.createSession(config)).rejects.toThrow("Unrecognized keys");
      const session = await client.createSession(
        { provider: "claude", cwd: dir },
        {
          env: {
            FULCRA_API_KEY_HELPER: helper,
            FULCRA_API_KEY_ACCOUNT: JSON.stringify(apiAccount),
            ANTHROPIC_API_KEY: key,
            ANTHROPIC_AUTH_TOKEN: key,
            CLAUDE_CODE_OAUTH_TOKEN: key,
            REQUEST_COPY: key,
          },
        },
      );
      try {
        await session.run("hello").catch(() => undefined);
      } finally {
        await session.close().catch(() => undefined);
      }
      const observed = JSON.parse(readFileSync(capture, "utf8")) as {
        argv: string[];
        env: Record<string, string>;
      };
      expect(JSON.stringify(observed).includes(key)).toBe(false);
      expect(observed.env.FULCRA_API_KEY_HELPER).toBeUndefined();
      expect(logs.join("").includes(key)).toBe(false);
      expect(JSON.stringify(session.usageSession?.()).includes(key)).toBe(false);
      const settings = JSON.parse(observed.argv[observed.argv.indexOf("--settings") + 1]);
      expect(settings.apiKeyHelper).toBe(helper);
      expect(settings.env).toEqual({});
    } finally {
      process.env = savedEnvironment;
    }
  }, 60000);
});

for (const source of ["user", "project", "local"] as const) {
  test(`an API launch refuses a saved ${source} key before a failing helper can fall back`, async () => {
    const { assertSafeClaudeApiSettings } = await import("./api-key-settings.js");
    const { mkdirSync } = await import("node:fs");
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "api-native-settings-")));
    const home = path.join(dir, "home");
    const cwd = path.join(dir, "project");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    const file =
      source === "user"
        ? path.join(home, ".claude/settings.json")
        : path.join(cwd, `.claude/settings${source === "local" ? ".local" : ""}.json`);
    // A synthetic legacy file tests the migration refusal. It is removed with the scratch home.
    writeFileSync(
      file,
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-SYNTHETIC-LEGACY-ONLY" },
        apiKeyHelper: "false",
      }),
    );
    expect(() => assertSafeClaudeApiSettings(cwd, { HOME: home })).toThrow(
      "Remove authentication from native Claude settings",
    );
    writeFileSync(file, JSON.stringify({ permissions: { allow: ["Read"] }, hooks: {} }));
    expect(() => assertSafeClaudeApiSettings(cwd, { HOME: home })).not.toThrow();
  });
}

for (const field of ["policyHelper", "policyHelpers"] as const) {
  test(`an API launch refuses dynamic ${field} settings`, async () => {
    const { assertSafeClaudeApiSettings } = await import("./api-key-settings.js");
    const { mkdirSync } = await import("node:fs");
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "api-policy-helper-")));
    mkdirSync(path.join(dir, ".claude"));
    writeFileSync(
      path.join(dir, ".claude/settings.json"),
      JSON.stringify({ [field]: { darwin: "fixture-policy-helper" } }),
    );
    expect(() => assertSafeClaudeApiSettings(dir!, { HOME: dir! })).toThrow(
      "Remove authentication",
    );
  });
}

test("the final API command refuses late settings from extraArgs and runtime command overlays", async () => {
  const { assertClaudeApiCommand } = await import("./api-key-settings.js");
  const args = ["--settings", JSON.stringify({ apiKeyHelper: "owned-helper", env: {} })];
  expect(() => assertClaudeApiCommand(args, "owned-helper")).not.toThrow();
  for (const extra of [
    ["--settings", JSON.stringify({ apiKeyHelper: "other-helper" })],
    ["--managed-settings", JSON.stringify({ policyHelpers: { darwin: "other-helper" } })],
    ["--settings=legacy-settings.json"],
  ])
    expect(() => assertClaudeApiCommand([...args, ...extra], "owned-helper")).toThrow(
      "Remove authentication overrides",
    );
});
