import {
  spawn,
  execFile,
  execFileSync,
  type ChildProcess,
  type SpawnOptions,
  type ExecFileSyncOptions,
} from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WINDOWS_GIT_GUARDIAN } from "./git-guardian-windows.js";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const GIT_CHILD_LIMIT = 8;
export const GIT_TIMEOUT_MS = 30_000;
/** A caller may ask for more time, never more than this. A worktree checkout on a slow disk needs minutes. */
export const GIT_MAX_TIMEOUT_MS = 30 * 60_000;
interface FetchState {
  failures: number;
  nextAt: number;
  auth: boolean;
  tail?: Promise<unknown>;
  active?: { args: string; result: Promise<unknown> };
}
interface GitRuntime {
  children: Set<ChildProcess>;
  termination: WeakMap<ChildProcess, Promise<void>>;
  fetches: Map<string, FetchState>;
  guardian?: string;
  exitCleanupRegistered?: boolean;
  liveGroups?: Set<number>;
}
const runtimeKey = Symbol.for("fulcra.owned-git-runtime");
const registry = globalThis as typeof globalThis & { [key: symbol]: GitRuntime };
const runtime = (registry[runtimeKey] ??= {
  children: new Set(),
  termination: new WeakMap(),
  fetches: new Map(),
});
const { children, termination, fetches } = runtime;
const liveGroups = (runtime.liveGroups ??= new Set<number>());
if (!runtime.exitCleanupRegistered) {
  runtime.exitCleanupRegistered = true;
  process.once("exit", () => {
    if (process.platform === "win32") return;
    for (const pid of liveGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* The owned group has already ended. */
      }
    }
  });
}

function publishGitOwnership(message: { action: "add" | "remove"; pid: number }): void {
  if (
    process.platform !== "win32" &&
    process.env.PASEO_SUPERVISED === "1" &&
    process.connected &&
    process.send
  ) {
    process.send({ type: "paseo:owned-process", ...message }, () => {});
  }
}

function collectUnixGitDescendants(input: {
  rows: number[][];
  root: number;
  owned: Set<number>;
}): void {
  let added = true;
  while (added) {
    added = false;
    for (const [pid, parent, group] of input.rows) {
      if (!input.owned.has(pid) && (input.owned.has(parent) || group === input.root)) {
        input.owned.add(pid);
        added = true;
      }
    }
  }
}

async function stopUnixGitTree(root: number): Promise<void> {
  const signal = (pid: number, kind: NodeJS.Signals) => {
    try {
      process.kill(pid, kind);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return false;
    }
  };
  // Freeze the parent before enumerating. Shell aliases can create another process group.
  if (!signal(-root, "SIGSTOP")) {
    liveGroups.delete(root);
    publishGitOwnership({ action: "remove", pid: root });
    return;
  }
  const owned = new Set([root]);
  const errors: unknown[] = [];
  try {
    for (let pass = 0; pass < 2; pass++) {
      const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid=,pgid="], {
        timeout: 5000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const rows = stdout
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number));
      collectUnixGitDescendants({ rows, root, owned });
      for (const pid of owned) signal(pid, "SIGSTOP");
    }
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      for (const pid of [...owned].toReversed()) {
        try {
          signal(pid, "SIGKILL");
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      try {
        signal(-root, "SIGKILL");
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, "Git process tree cleanup failed");
}

/** Only Fulcra-owned git processes use this environment. Never change process.env or git config. */
export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (
      /^(GIT_TERMINAL_PROMPT|GCM_INTERACTIVE|GIT_ASKPASS|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|GIT_SSH|GIT_SSH_COMMAND|GIT_SSH_VARIANT)$/i.test(
        key,
      )
    )
      delete env[key];
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
    LANG: "C",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes",
    GIT_SSH_VARIANT: "ssh",
  };
}

export function gitArguments(args: string[]): string[] {
  return ["-c", "credential.interactive=false", "-c", "core.askPass=", ...args];
}

/** Keep the parent alive until taskkill has enumerated its descendants. */
export function terminateGitProcess(child: ChildProcess): Promise<void> {
  const previous = termination.get(child);
  if (previous) return previous;
  const stopped = (async () => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      try {
        await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 5000,
        });
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) throw error;
      }
    } else {
      await stopUnixGitTree(child.pid);
    }
  })();
  termination.set(child, stopped);
  return stopped;
}

function gitExecutable(): string {
  if (process.platform !== "win32") return "git";
  if (runtime.guardian) return runtime.guardian;
  const root = mkdtempSync(path.join(tmpdir(), "fulcra-git-guardian-"));
  const source = path.join(root, "guardian.cs");
  const output = path.join(root, "guardian.exe");
  writeFileSync(source, WINDOWS_GIT_GUARDIAN);
  const script =
    "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText('" +
    source.replaceAll("'", "''") +
    "')) -OutputAssembly '" +
    output.replaceAll("'", "''") +
    "' -OutputType ConsoleApplication";
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, timeout: 30_000, stdio: "pipe" },
  );
  runtime.guardian = output;
  return output;
}

export function spawnGitProcess(args: string[], options: SpawnOptions = {}): ChildProcess {
  if (children.size >= GIT_CHILD_LIMIT) throw new Error("Fulcra git child limit reached");
  const timeout = Math.min(
    options.timeout && options.timeout > 0 ? options.timeout : GIT_TIMEOUT_MS,
    GIT_MAX_TIMEOUT_MS,
  );
  const child = spawn(gitExecutable(), gitArguments(args), {
    ...options,
    env: { ...gitEnvironment(options.env), FULCRA_GIT_TIMEOUT_MS: String(timeout) },
    timeout: undefined,
    signal: undefined,
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
  });
  // The daemon preserves user detached jobs during shutdown. Register these groups as owned.
  if (process.platform !== "win32" && child.pid) liveGroups.add(child.pid);
  if (child.pid) publishGitOwnership({ action: "add", pid: child.pid });
  child.once("close", () => {
    if (child.pid) liveGroups.delete(child.pid);
    if (child.pid) publishGitOwnership({ action: "remove", pid: child.pid });
  });
  children.add(child);
  let cleanupFailed = false;
  const stop = () => {
    void terminateGitProcess(child).catch(() => {
      cleanupFailed = true;
    });
  };
  const timer = setTimeout(stop, timeout);
  const abort = () => stop();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) stop();
  child.once("close", () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    // A failed tree cleanup keeps its slot. Do not admit an unbounded series of leaks.
    void (termination.get(child) ?? Promise.resolve()).then(
      () => !cleanupFailed && children.delete(child),
      () => false,
    );
  });
  return child;
}

interface GitInvocation {
  operation: string;
  cwd: string;
  gitDir?: string;
}
function gitInvocation(args: string[], cwd: string): GitInvocation {
  let directory = path.resolve(cwd);
  let gitDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-C") {
      directory = path.resolve(directory, args[++i]);
      continue;
    }
    if (arg.startsWith("-C") && arg.length > 2) {
      directory = path.resolve(directory, arg.slice(2));
      continue;
    }
    if (arg === "--git-dir") {
      gitDir = args[++i];
      continue;
    }
    if (arg.startsWith("--git-dir=")) {
      gitDir = arg.slice(10);
      continue;
    }
    if (["-c", "--work-tree", "--namespace", "--config-env", "--super-prefix"].includes(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith("-"))
      return { operation: arg, cwd: directory, gitDir: gitDir && path.resolve(directory, gitDir) };
  }
  return { operation: "", cwd: directory, gitDir };
}
function repositoryKeySync(cwd: string, suppliedGitDir?: string): string {
  let current = realpathSync(cwd);
  for (;;) {
    try {
      let gitDir = suppliedGitDir ?? path.join(current, ".git");
      try {
        const text = readFileSync(gitDir, "utf8");
        if (text.startsWith("gitdir:")) gitDir = path.resolve(current, text.slice(7).trim());
      } catch {
        /* Main checkout directory. */
      }
      gitDir = realpathSync(gitDir);
      try {
        gitDir = realpathSync(
          path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim()),
        );
      } catch {
        /* Main checkout. */
      }
      return process.platform === "win32" ? gitDir.toLowerCase() : gitDir;
    } catch {
      /* Search enclosing checkout. */
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}
function noteFetchFailure(state: FetchState, error: unknown, allowMissingRef: boolean): void {
  const text = String(error);
  if (
    allowMissingRef &&
    /couldn't find remote ref|not our ref|unadvertised object|remote ref does not exist/i.test(text)
  )
    return;
  state.failures += 1;
  state.auth = isGitAuthenticationFailure(text);
  state.nextAt = Date.now() + Math.min(30_000 * 2 ** Math.min(state.failures - 1, 6), 30 * 60_000);
}
function admitFetch(state: FetchState, retry: boolean): void {
  if (retry) {
    state.auth = false;
    state.nextAt = 0;
    state.failures = 0;
  }
  if (state.auth)
    throw new Error("Git fetch requires credentials. Sign in, then retry the requested action.");
  if (Date.now() < state.nextAt)
    throw new Error("Git fetch is paused after a failure. Retry later.");
}

async function repositoryKey(cwd: string, suppliedGitDir?: string): Promise<string> {
  let current = await realpath(cwd);
  for (;;) {
    const dotGit = suppliedGitDir ?? path.join(current, ".git");
    try {
      let gitDir = dotGit;
      try {
        const text = await readFile(dotGit, "utf8");
        if (text.startsWith("gitdir:")) gitDir = path.resolve(current, text.slice(7).trim());
      } catch {
        /* A directory is the normal case. */
      }
      gitDir = await realpath(gitDir);
      try {
        gitDir = await realpath(
          path.resolve(gitDir, (await readFile(path.join(gitDir, "commondir"), "utf8")).trim()),
        );
      } catch {
        /* Main checkout. */
      }
      return process.platform === "win32" ? gitDir.toLowerCase() : gitDir;
    } catch {
      /* Search the parent for a checkout. */
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

export function isGitAuthenticationFailure(error: unknown): boolean {
  return /authentication failed|could not read (username|password)|terminal prompts disabled|cannot prompt|interactive.*(disabled|never)|permission denied \(publickey|credential.*(required|unavailable)|HTTP (401|403)|returned error: (401|403)/i.test(
    String(error),
  );
}

/** Identical fetches share one result. Different refspecs wait for the repository's current fetch. */
export async function withGitFetchPolicy<T>(
  cwd: string,
  args: string[],
  operation: () => Promise<T>,
  retry = false,
  input?: string | Buffer,
  allowMissingRef = false,
): Promise<T> {
  const invocation = gitInvocation(args, cwd);
  if (invocation.operation !== "fetch") return operation();
  const key = await repositoryKey(invocation.cwd, invocation.gitDir);
  const state = fetches.get(key) ?? { failures: 0, nextAt: 0, auth: false };
  fetches.set(key, state);
  const identity = JSON.stringify([
    args,
    input === undefined ? null : createHash("sha256").update(input).digest("hex"),
  ]);
  if (state.active?.args === identity) return state.active.result as Promise<T>;
  const previous = state.tail;
  const result = (async () => {
    await previous?.catch(() => {});
    admitFetch(state, retry);
    try {
      const value = await operation();
      const reply = value as { exitCode?: number | null; stderr?: string } | null;
      if (reply && typeof reply === "object" && "exitCode" in reply && reply.exitCode !== 0) {
        noteFetchFailure(state, reply.stderr, allowMissingRef);
      } else {
        state.failures = 0;
        state.nextAt = 0;
      }
      return value;
    } catch (error) {
      noteFetchFailure(state, error, allowMissingRef);
      throw error;
    }
  })();
  state.active = { args: identity, result };
  state.tail = result;
  try {
    return await result;
  } finally {
    if (state.active?.result === result) state.active = undefined;
    if (state.tail === result) state.tail = undefined;
  }
}

export interface ExecGitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  input?: string | Buffer;
  retryFetch?: boolean;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}
export function execGitCommand(
  args: string[],
  options: ExecGitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return withGitFetchPolicy(
    options.cwd ?? process.cwd(),
    args,
    () =>
      new Promise((resolve, reject) => {
        const child = spawnGitProcess(args, {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeout,
          signal: options.signal,
          stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "",
          failure: Error | undefined;
        const limit = options.maxBuffer ?? 20 * 1024 * 1024;
        let pendingLine = "";
        const timer = setTimeout(
          () => {
            failure = new Error("Git command timed out");
            void terminateGitProcess(child).catch(reject);
          },
          Math.min(
            options.timeout && options.timeout > 0 ? options.timeout : GIT_TIMEOUT_MS,
            GIT_MAX_TIMEOUT_MS,
          ),
        );
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        const feed = (chunk: string, output: boolean) => {
          if (failure) return;
          if (options.onLine) {
            pendingLine += chunk;
            const lines = pendingLine.split(/\r?\n|\r/);
            pendingLine = lines.pop() ?? "";
            for (const line of lines) if (line.trim()) options.onLine(line);
          }
          if (output) stdout += chunk;
          else stderr += chunk;
          if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > limit) {
            failure = new Error("Git output limit reached");
            void terminateGitProcess(child).catch(reject);
          }
        };
        child.stdout!.on("data", (chunk: string) => feed(chunk, true));
        child.stderr!.on("data", (chunk: string) => feed(chunk, false));
        child.on("error", (error) => {
          failure = error;
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (pendingLine.trim()) options.onLine?.(pendingLine);
          if (failure || code !== 0 || options.signal?.aborted)
            reject(
              Object.assign(failure ?? new Error(stderr || `Git exited ${code}`), {
                code,
                stdout,
                stderr,
              }),
            );
          else resolve({ stdout, stderr });
        });
        if (options.input !== undefined) {
          child.stdin!.on("error", () => {});
          child.stdin!.end(options.input);
        }
      }),
    options.retryFetch,
    options.input,
  );
}

/** Use a timer-owning worker because a synchronous caller cannot run its own tree timeout. */
export function execGitCommandSync(
  args: string[],
  options: ExecFileSyncOptions & { encoding: BufferEncoding },
): string;
export function execGitCommandSync(args: string[], options?: ExecFileSyncOptions): Buffer;
export function execGitCommandSync(
  args: string[],
  options: ExecFileSyncOptions = {},
): string | Buffer {
  if (children.size >= GIT_CHILD_LIMIT) throw new Error("Fulcra git child limit reached");
  const timeout = Math.min(
    options.timeout && options.timeout > 0 ? options.timeout : GIT_TIMEOUT_MS,
    GIT_MAX_TIMEOUT_MS,
  );
  const invocation = gitInvocation(args, options.cwd?.toString() ?? process.cwd());
  let state: FetchState | undefined;
  if (invocation.operation === "fetch") {
    const key = repositoryKeySync(invocation.cwd, invocation.gitDir);
    state = fetches.get(key) ?? { failures: 0, nextAt: 0, auth: false };
    fetches.set(key, state);
    if (state.tail) throw new Error("A git fetch is already in progress for this repository");
    admitFetch(state, false);
  }
  try {
    const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", SYNC_WORKER], {
      ...options,
      env: {
        ...gitEnvironment(options.env),
        ELECTRON_RUN_AS_NODE: "1",
        FULCRA_GIT_TIMEOUT_MS: String(timeout),
      },
      windowsHide: true,
      timeout: timeout + 10_000,
      maxBuffer,
      stdio: ["pipe", "pipe", "pipe"],
      input: JSON.stringify({
        args: gitArguments(args),
        executable: gitExecutable(),
        cwd: options.cwd?.toString(),
        timeout,
        maxBuffer,
        input: options.input?.toString(),
      }),
    });
    if (state) {
      state.failures = 0;
      state.nextAt = 0;
    }
    return output;
  } catch (error) {
    if (state)
      noteFetchFailure(state, (error as { stderr?: Buffer }).stderr?.toString() || error, false);
    throw error;
  }
}

// Inline code survives plugin bundling and app.asar relocation. It starts only one owned git tree.
const SYNC_WORKER = String.raw`
import {spawn, execFile} from "node:child_process";
let text=""; for await(const c of process.stdin) text+=c;
const request=JSON.parse(text);
const child=spawn(request.executable,request.args,{cwd:request.cwd,env:process.env,windowsHide:true,shell:false,detached:process.platform!=="win32",stdio:["pipe","pipe","pipe"]});
let timedOut=false, bytes=0, stopped=false;
function stop(){
 if(stopped)return; stopped=true;
 if(!child.pid)return;
 if(process.platform==="win32") execFile("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,timeout:5000},error=>{if(error && child.exitCode===null && child.signalCode===null){process.stderr.write("Git tree cleanup failed");process.exitCode=1;}});
 else {try{process.kill(-child.pid,"SIGKILL");}catch(error){if(error.code!=="ESRCH")throw error;}}
}
const timer=setTimeout(()=>{timedOut=true;stop();},request.timeout);
process.on("SIGTERM",()=>{timedOut=true;stop();});
process.on("SIGINT",()=>{timedOut=true;stop();});
for(const [stream,out] of [[child.stdout,process.stdout],[child.stderr,process.stderr]]) stream.on("data",chunk=>{bytes+=chunk.length;if(bytes>(request.maxBuffer??20*1024*1024)){timedOut=true;stop();}else out.write(chunk);});
child.on("error",error=>{clearTimeout(timer);process.stderr.write(error.message);process.exitCode=1;});
child.on("close",code=>{clearTimeout(timer);process.exitCode=timedOut?1:(code??1);});
child.stdin.on("error",()=>{});child.stdin.end(request.input);
`;
