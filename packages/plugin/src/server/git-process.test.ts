import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  execGitCommand,
  gitArguments,
  gitEnvironment,
  withGitFetchPolicy,
  spawnGitProcess,
  GIT_CHILD_LIMIT,
} from "./git-process.js";
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function repo() {
  const p = await mkdtemp(path.join(tmpdir(), "fulcra-git-"));
  roots.push(p);
  await execGitCommand(["init", "--quiet"], { cwd: p });
  return p;
}

test("owned git overrides inherited prompt controls without changing the caller environment", () => {
  const base = {
    GIT_TERMINAL_PROMPT: "1",
    GCM_INTERACTIVE: "always",
    GIT_ASKPASS: "bad",
    SSH_ASKPASS: "bad",
    git_askpass: "bad",
    GIT_SSH_COMMAND: "bad",
    KEEP: "yes",
  };
  const env = gitEnvironment(base);
  expect(env).toMatchObject({
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS_REQUIRE: "never",
    KEEP: "yes",
  });
  expect(env.GIT_ASKPASS).toBeUndefined();
  expect(env.SSH_ASKPASS).toBeUndefined();
  expect(env.git_askpass).toBeUndefined();
  expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
  expect(base.GIT_ASKPASS).toBe("bad");
  expect(gitArguments(["fetch"])).toEqual([
    "-c",
    "credential.interactive=false",
    "-c",
    "core.askPass=",
    "fetch",
  ]);
});
test("concurrent fetches share a result across the same repository and subdirectory", async () => {
  const cwd = await repo();
  await mkdir(path.join(cwd, "sub"));
  let release!: (value: number) => void;
  const operation = vi.fn(() => new Promise<number>((r) => (release = r)));
  const a = withGitFetchPolicy(cwd, ["fetch"], operation);
  const b = withGitFetchPolicy(path.join(cwd, "sub"), ["fetch"], operation);
  await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
  release(42);
  expect(await a).toBe(42);
  await b;
});
test("different fetch arguments serialize without losing the second refspec", async () => {
  const cwd = await repo();
  let release!: () => void;
  const first = vi.fn(() => new Promise<void>((r) => (release = r)));
  const second = vi.fn(async () => 2);
  const a = withGitFetchPolicy(cwd, ["fetch", "one"], first);
  await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
  const b = withGitFetchPolicy(cwd, ["fetch", "two"], second);
  expect(second).not.toHaveBeenCalled();
  release();
  await a;
  expect(await b).toBe(2);
});
test("failed fetches back off exponentially and auth failures stop until explicit retry", async () => {
  const cwd = await repo();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const fail = vi.fn(async () => {
    throw new Error("network unavailable");
  });
  await expect(withGitFetchPolicy(cwd, ["fetch"], fail)).rejects.toThrow("network unavailable");
  clock.mockReturnValue(30_999);
  await expect(withGitFetchPolicy(cwd, ["fetch"], fail)).rejects.toThrow("paused");
  clock.mockReturnValue(31_000);
  await expect(withGitFetchPolicy(cwd, ["fetch"], fail)).rejects.toThrow("network unavailable");
  clock.mockReturnValue(90_999);
  await expect(withGitFetchPolicy(cwd, ["fetch"], fail)).rejects.toThrow("paused");
  clock.mockReturnValue(91_000);
  const auth = vi.fn(async () => {
    throw new Error("fatal: could not read Username: terminal prompts disabled");
  });
  await expect(withGitFetchPolicy(cwd, ["fetch"], auth)).rejects.toThrow(
    "terminal prompts disabled",
  );
  clock.mockReturnValue(999_999_999);
  await expect(withGitFetchPolicy(cwd, ["fetch"], auth)).rejects.toThrow("requires credentials");
  expect(auth).toHaveBeenCalledTimes(1);
  expect(await withGitFetchPolicy(cwd, ["fetch"], async () => 7, true)).toBe(7);
  clock.mockRestore();
});
test("accepted nonzero fetch status still pauses authentication retries", async () => {
  const cwd = await repo();
  await withGitFetchPolicy(cwd, ["fetch"], async () => ({
    exitCode: 128,
    stderr: "Authentication failed",
  }));
  await expect(withGitFetchPolicy(cwd, ["fetch"], async () => 1)).rejects.toThrow(
    "requires credentials",
  );
});
test("real git timeout kills a hook and its child before the next command", async () => {
  const cwd = await repo();
  const childFile = path.join(cwd, "child.pid");
  // A Node hook keeps one descendant alive. Git invokes hooks on every supported platform.
  const script = path.join(cwd, "hook.cjs");
  await writeFile(
    script,
    `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(childFile)},String(c.pid)); setInterval(()=>{},1000);`,
  );
  await execGitCommand(["config", "user.name", "Test"], { cwd });
  await execGitCommand(["config", "user.email", "test@example.invalid"], { cwd });
  await writeFile(
    path.join(cwd, ".git", "hooks", "pre-commit"),
    `#!/bin/sh\nnode '${script.replaceAll("\\", "/")}'\n`,
    { mode: 0o755 },
  );
  await expect(
    execGitCommand(["commit", "--allow-empty", "-m", "test"], { cwd, timeout: 1500 }),
  ).rejects.toThrow();
  const { readFile } = await import("node:fs/promises");
  const pid = Number(await readFile(childFile, "utf8"));
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
  expect((await execGitCommand(["status", "--porcelain"], { cwd })).stdout).toContain("hook.cjs");
});
test("global child cap refuses excess work and recovers after children close", async () => {
  const cwd = await repo();
  const children = Array.from({ length: GIT_CHILD_LIMIT }, () =>
    spawnGitProcess(["hash-object", "--stdin"], { cwd, stdio: "pipe", timeout: 5000 }),
  );
  expect(() => spawnGitProcess(["status"], { cwd })).toThrow("child limit");
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", () => resolve());
          child.stdin!.end();
        }),
    ),
  );
  expect((await execGitCommand(["status", "--porcelain"], { cwd })).stdout).toBe("");
});

test("global options still use one fetch, and distinct stdin stays separate", async () => {
  const cwd = await repo();
  const args = ["-C", cwd, "-c", "fetch.negotiationAlgorithm=noop", "fetch", "--stdin"];
  let release!: () => void;
  const first = vi.fn(() => new Promise<void>((r) => (release = r)));
  const second = vi.fn(async () => 2);
  const a = withGitFetchPolicy(cwd, args, first, false, "one\n");
  await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
  const b = withGitFetchPolicy(cwd, args, second, false, "two\n");
  expect(second).not.toHaveBeenCalled();
  release();
  await a;
  expect(await b).toBe(2);
});
test("missing-ref fallback can continue, while authentication still pauses", async () => {
  const cwd = await repo();
  await withGitFetchPolicy(
    cwd,
    ["fetch", "missing"],
    async () => ({ exitCode: 128, stderr: "fatal: couldn't find remote ref missing" }),
    true,
    undefined,
    true,
  );
  expect(await withGitFetchPolicy(cwd, ["fetch", "valid"], async () => 7)).toBe(7);
  await withGitFetchPolicy(
    cwd,
    ["fetch"],
    async () => ({ exitCode: 128, stderr: "Authentication failed" }),
    false,
    undefined,
    true,
  );
  await expect(withGitFetchPolicy(cwd, ["fetch"], async () => 1)).rejects.toThrow(
    "requires credentials",
  );
});
test("synchronous git keeps output and shares paused fetch state", async () => {
  const { execGitCommandSync } = await import("./git-process.js");
  const cwd = await repo();
  expect(
    execGitCommandSync(["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim(),
  ).toBe(await realpath(cwd));
  await withGitFetchPolicy(cwd, ["fetch"], async () => ({
    exitCode: 128,
    stderr: "Authentication failed",
  }));
  expect(() => execGitCommandSync(["fetch"], { cwd })).toThrow("requires credentials");
});
test("cancellation stops the owned tree and preserves streamed output", async () => {
  const cwd = await repo();
  const controller = new AbortController();
  const lines: string[] = [];
  await execGitCommand(
    ["config", "alias.wait", "!echo started; node -e 'setInterval(()=>{},1000)'"],
    { cwd },
  );
  const result = execGitCommand(["wait"], {
    cwd,
    signal: controller.signal,
    onLine: (line) => {
      lines.push(line);
      controller.abort();
    },
  });
  await expect(result).rejects.toThrow();
  expect(lines).toContain("started");
});

test("synchronous output over one MiB retains the tree deadline", async () => {
  const { execGitCommandSync } = await import("./git-process.js");
  const cwd = await repo();
  const script = path.join(cwd, "large.cjs");
  const pidFile = path.join(cwd, "large-child.pid");
  await writeFile(
    script,
    `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000);`,
  );
  await execGitCommand(["config", "alias.large", `!node '${script.replaceAll("\\", "/")}'`], {
    cwd,
  });
  expect(() => execGitCommandSync(["large"], { cwd, timeout: 1500 })).toThrow();
  const { readFile } = await import("node:fs/promises");
  const pid = Number(await readFile(pidFile, "utf8"));
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
});

test("supervised Unix git groups remain owned until their pipes close", async () => {
  const cwd = await repo();
  const actual = process;
  const sent: unknown[] = [];
  vi.stubGlobal("process", {
    ...actual,
    platform: "linux",
    connected: true,
    send: (message: unknown) => {
      sent.push(message);
      return true;
    },
  });
  vi.stubEnv("PASEO_SUPERVISED", "1");
  try {
    await execGitCommand(["status", "--porcelain"], { cwd });
    expect(sent).toEqual([
      { type: "paseo:owned-process", action: "add", pid: expect.any(Number) },
      { type: "paseo:owned-process", action: "remove", pid: expect.any(Number) },
    ]);
    expect((sent[0] as { pid: number }).pid).toBe((sent[1] as { pid: number }).pid);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
