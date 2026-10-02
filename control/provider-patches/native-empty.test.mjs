import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { patchEmptySession } from "./empty-session.mjs";
import { pathToFileURL } from "node:url";
const provider =
  "/Volumes/test-volume/openclaw/projects/orca-paseo-20260911/node_modules/@getpaseo/server/dist/server/server/agent/providers/codex-app-server-agent.js";
const generated = patchEmptySession(
  fs.readFileSync(process.env.ORCA_PROVIDER_BASE ?? provider, "utf8"),
).replace(
  /from (["'])(\.{1,2}\/[^"']+)\1/g,
  (_, q, specifier) =>
    `from ${q}${pathToFileURL(path.resolve(path.dirname(provider), specifier)).href}${q}`,
);
const staged = new URL("../runtime/empty-provider/provider.mjs", import.meta.url);
assert.equal(
  fs.readFileSync(staged, "utf8"),
  generated,
  "Run provider unit tests to stage the exact patch first",
);
const { CodexAppServerAgentSession: Session } = await import(staged.href);
const allowed = new Set([
  "initialize",
  "thread/start",
  "thread/name/set",
  "thread/read",
  "thread/resume",
]);
async function server(home, methods) {
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
  );
  env.CODEX_HOME = home;
  const child = spawn("/opt/homebrew/bin/codex", ["app-server", "--stdio"], {
    cwd: home,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  const pending = new Map();
  let seq = 0;
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const m = JSON.parse(line),
      p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    }
  });
  child.on("exit", () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("App server exited"));
    }
    pending.clear();
  });
  const request = (method, params) => {
    assert(allowed.has(method), "No model-turn method may run");
    methods.push(method);
    return new Promise((resolve, reject) => {
      const id = ++seq,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("RPC timeout"));
        }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  };
  await request("initialize", {
    clientInfo: { name: "orca_native_persistence", version: "1" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  return {
    request,
    child,
    stop: async (signal) => {
      child.kill(signal);
      await exit;
      lines.close();
    },
  };
}
test(
  "actual patched provider retains empty native ID through SIGKILL and repeated restart",
  { timeout: 60000 },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "orca-patched-empty-")),
      methods = [];
    let live = await server(home, methods),
      id;
    try {
      const logger = {
        child() {
          return this;
        },
      };
      const s = new Session(
        {
          model: "gpt-6-astra",
          thinkingOptionId: "medium",
          cwd: home,
          providerOptions: { approval_policy: "never", sandbox_mode: "read-only" },
        },
        undefined,
        logger,
        null,
      );
      s.client = live;
      await s.ensureThread();
      id = s.id;
      assert(id);
      await live.stop("SIGKILL");
      live = null;
      for (let n = 0; n < 2; n++) {
        live = await server(home, methods);
        const r = await live.request("thread/resume", { threadId: id });
        assert.equal(r.thread.id, id);
        assert.equal(r.thread.turns.length, 0);
        const read = await live.request("thread/read", { threadId: id, includeTurns: true });
        assert.equal(read.thread.id, id);
        assert.equal(read.thread.turns.length, 0);
        await live.stop("SIGTERM");
        live = null;
      }
      assert.equal(methods.filter((m) => m === "thread/start").length, 1);
      const report = {
        at: new Date().toISOString(),
        home,
        threadId: id,
        methods,
        modelTurnsStarted: 0,
        gracefulRestarts: 2,
        killedAfterPersistence: true,
        preserved: true,
      };
      fs.writeFileSync(
        new URL("../runtime/native-empty-proof.json", import.meta.url),
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(report));
    } finally {
      if (live) await live.stop("SIGTERM");
    }
  },
);
