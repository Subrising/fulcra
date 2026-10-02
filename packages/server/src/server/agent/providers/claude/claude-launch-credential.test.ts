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
