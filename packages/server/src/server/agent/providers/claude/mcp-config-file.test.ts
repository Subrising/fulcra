import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import type { Query, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { moveMcpConfigOffArgv } from "./mcp-config-file.js";
import { claudeQuery, type ClaudeOptions } from "./query.js";

// FU-349 review round 2: the agent's MCP bearer token must not appear in the process list. These tests count the
// token in `ps` output and never print it.

// Built at run time from a repeated character: a fixed look-alike secret would trip the secret scanner.
const TOKEN = `fake-${"x".repeat(32)}`;
const INLINE = JSON.stringify({
  mcpServers: {
    paseo: {
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
  },
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test("moves inline MCP JSON out of argv into a file only the owner can read, and removes it", () => {
  const moved = moveMcpConfigOffArgv(["--print", "--mcp-config", INLINE, "--model", "opus"]);
  cleanups.push(moved.cleanup);
  expect(moved.args.join(" ")).not.toContain(TOKEN);
  expect(moved.args.join(" ")).not.toContain("Bearer");
  const file = moved.args[moved.args.indexOf("--mcp-config") + 1]!;
  expect(readFileSync(file, "utf8")).toContain(TOKEN);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(moved.args.slice(0, 2)).toEqual(["--print", "--mcp-config"]);
  expect(moved.args.slice(-2)).toEqual(["--model", "opus"]);
  moved.cleanup();
  expect(existsSync(file)).toBe(false);
  moved.cleanup(); // safe to repeat
});

test("handles the = form and several values, and leaves a path value alone", () => {
  const moved = moveMcpConfigOffArgv([
    `--mcp-config=${INLINE}`,
    "--mcp-config",
    "/etc/own.json",
    INLINE,
  ]);
  cleanups.push(moved.cleanup);
  expect(moved.args.join(" ")).not.toContain(TOKEN);
  expect(moved.args[0]).toMatch(/^--mcp-config=.*mcp-1\.json$/);
  expect(moved.args[2]).toBe("/etc/own.json");
  expect(moved.args[3]).toMatch(/mcp-2\.json$/);
});

test("a spawned Claude process shows no token in the process list, and its config file is removed on exit", async () => {
  let captured: ClaudeOptions | undefined;
  claudeQuery({ prompt: "x", options: {} } as never, {
    queryFactory: (input) => {
      captured = input.options;
      return {} as Query;
    },
  });
  // A stand-in for the claude binary: it stays alive and receives the arguments the SDK would pass.
  const spawnOptions = {
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 20000)", "--", "--mcp-config", INLINE],
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string | undefined>,
    signal: new AbortController().signal,
  } as unknown as SpawnOptions;
  const child = captured!.spawnClaudeCodeProcess!(spawnOptions) as unknown as {
    pid: number;
    kill: (signal?: NodeJS.Signals) => boolean;
    once: (event: string, listener: () => void) => void;
  };
  cleanups.push(() => child.kill("SIGKILL"));
  const exited = new Promise<void>((resolve) => child.once("exit", resolve));

  const ps = execFileSync("ps", ["-axww", "-o", "args="], { encoding: "utf8" });
  const own = ps.split("\n").filter((line) => line.includes("setTimeout(() => {}, 20000)"));
  expect(own.length).toBeGreaterThan(0); // the stand-in process is in the list
  const tokenHits = ps.split("\n").filter((line) => line.includes(TOKEN)).length;
  expect(tokenHits).toBe(0);
  const filePath = own[0]!.match(/(\S+mcp-1\.json)/)?.[1];
  expect(filePath).toBeTruthy();
  expect(readFileSync(filePath!, "utf8")).toContain(TOKEN);
  expect(statSync(filePath!).mode & 0o777).toBe(0o600);

  child.kill("SIGTERM");
  await exited;
  await vi.waitFor(() => expect(existsSync(filePath!)).toBe(false));
});
