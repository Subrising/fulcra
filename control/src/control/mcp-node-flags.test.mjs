import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mcpNodeFlags, NODE_FLAGS_ENV } from "./mcp-node-flags.mjs";
import { canonicalMemoryConfig, CANONICAL_MEMORY_ENTRY } from "../canonical-memory-route.mjs";
import { supervisorServer, INBOX, TOOL_SURFACE } from "./tool-surface.mjs";

// FU-467: the MCP server processes that agents start must not open an inspector on SIGUSR1 (FU-79).
const toolSurface = fileURLToPath(new URL("./tool-surface.mjs", import.meta.url));

// Reads the built config in a fresh process, so each case controls the flags variable at module load.
function inChild(value) {
  const env = { ...process.env };
  delete env[NODE_FLAGS_ENV];
  if (value !== undefined) env[NODE_FLAGS_ENV] = value;
  const script = `const t = await import(${JSON.stringify(toolSurface)});
    const m = await import(${JSON.stringify(new URL("../canonical-memory-route.mjs", import.meta.url).href)});
    console.log(JSON.stringify({ inbox: t.supervisorServer("m").args, memory: m.canonicalMemoryConfig("claude").args, surface: t.TOOL_SURFACE }));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      encoding: "utf8",
    }),
  );
}

test("supervisorServer starts the inbox server with the inspector flag first", () => {
  assert.deepEqual(supervisorServer("m").args, ["--disable-sigusr1", INBOX]);
});

test("canonicalMemoryConfig starts the memory server with the inspector flag first", () => {
  assert.deepEqual(canonicalMemoryConfig("codex").args, [
    "--disable-sigusr1",
    CANONICAL_MEMORY_ENTRY,
  ]);
});

test("an empty flag list from the daemon (gate flavour) gives no flag and no empty entry", () => {
  const out = inChild("[]");
  assert.deepEqual(out.inbox, [INBOX]);
  assert.deepEqual(out.memory, [CANONICAL_MEMORY_ENTRY]);
});

test("only the exact inspector flag is accepted; any other flag gives the default", () => {
  for (const value of [
    JSON.stringify(["--no-warnings"]),
    JSON.stringify(["--inspect=0"]),
    JSON.stringify(["--require=/tmp/x.js"]),
    JSON.stringify(["--disable-sigusr1", "--no-warnings"]),
  ]) {
    assert.deepEqual(inChild(value).inbox, ["--disable-sigusr1", INBOX], value);
  }
});

test("the inspector flag with an extra entry gives the default, not both", () => {
  assert.deepEqual(mcpNodeFlags({ [NODE_FLAGS_ENV]: '["--disable-sigusr1","--inspect"]' }), [
    "--disable-sigusr1",
  ]);
});

test("a missing or malformed flag value fails closed", () => {
  for (const value of [undefined, "", "not json", '"--x"', "[1]", "null"]) {
    assert.deepEqual(inChild(value).inbox, ["--disable-sigusr1", INBOX], String(value));
  }
  assert.deepEqual(mcpNodeFlags({}), ["--disable-sigusr1"]);
});

test("the tool surface digest does not depend on the flags, so live sessions are not refreshed", () => {
  assert.equal(inChild(undefined).surface, inChild("[]").surface);
  assert.equal(inChild(undefined).surface, TOOL_SURFACE);
});
