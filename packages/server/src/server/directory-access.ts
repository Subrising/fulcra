import { spawn } from "node:child_process";
import { statSync } from "node:fs";

// Whether project and workspace directories can be used, without ever blocking the daemon.
//
// On macOS a folder such as ~/Documents is protected by a privacy consent (TCC). A build the system has not seen
// before (every ad-hoc signed build is a new identity) makes the first open() or lookup under that folder wait in the
// kernel until someone answers the consent prompt. fs.watch() opens its path synchronously on the main thread, so a
// pending prompt used to freeze the whole daemon during startup. The libuv threadpool is no better: a blocked read
// pins one of its few threads for as long as the prompt is open.
//
// So on macOS the paths are checked in a short-lived child process, with a bounded wait. A path without an answer in
// time is "unreadable" and the child is killed. Callers only watch or reconcile "directory" paths, and only act on
// "missing" (e.g. archive a workspace) when the path is really gone, never when it is merely blocked. The child's
// access is attributed to this app, so the consent prompt still appears; once it is answered, the next check passes.

export type DirectoryState = "directory" | "missing" | "unreadable";

export interface InspectDirectories {
  (paths: readonly string[]): Promise<Map<string, DirectoryState>>;
}

export const DEFAULT_DIRECTORY_CHECK_TIMEOUT_MS = 3_000;

// Runs in the child. Opens each path non-blocking (a FIFO or device never waits for a peer), reports one JSON line
// per path as soon as it knows, so a later path that blocks does not hide earlier answers.
const CHECK_SCRIPT = `
const fs = require("node:fs");
const paths = process.argv.slice(1);
for (let index = 0; index < paths.length; index += 1) {
  let state;
  try {
    const fd = fs.openSync(paths[index], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try { state = fs.fstatSync(fd).isDirectory() ? "directory" : "missing"; } finally { fs.closeSync(fd); }
  } catch (error) {
    state = error && (error.code === "ENOENT" || error.code === "ENOTDIR") ? "missing" : "unreadable";
  }
  process.stdout.write(JSON.stringify([index, state]) + "\\n");
}
`;

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/** In-process check, for platforms where a lookup never waits on a consent prompt. */
function inspectInProcess(paths: readonly string[]): Map<string, DirectoryState> {
  const states = new Map<string, DirectoryState>();
  for (const target of paths) {
    try {
      states.set(target, statSync(target).isDirectory() ? "directory" : "missing");
    } catch (error) {
      states.set(target, isMissingPathError(error) ? "missing" : "unreadable");
    }
  }
  return states;
}

export interface DirectoryInspectorOptions {
  timeoutMs?: number;
  /** Defaults to process.platform; only "darwin" checks out of process. */
  platform?: NodeJS.Platform;
  /** The runtime for the child (this daemon's own Node or Electron binary). */
  execPath?: string;
}

/** Checks paths in a child process with a bounded wait; unanswered paths are "unreadable". */
export async function inspectOutOfProcess(
  paths: readonly string[],
  options: { timeoutMs: number; execPath: string },
): Promise<Map<string, DirectoryState>> {
  const unique = Array.from(new Set(paths));
  const states = new Map<string, DirectoryState>();
  if (unique.length === 0) return states;
  const child = spawn(options.execPath, ["-e", CHECK_SCRIPT, ...unique], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      try {
        const [index, state] = JSON.parse(line) as [number, DirectoryState];
        const target = unique[index];
        if (target !== undefined && ["directory", "missing", "unreadable"].includes(state))
          states.set(target, state);
      } catch {
        // Not a result line; the path stays unanswered ("unreadable").
      }
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve) => {
    timer = setTimeout(resolve, options.timeoutMs);
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const target of unique) if (!states.has(target)) states.set(target, "unreadable");
  return states;
}

export function createDirectoryInspector(
  options: DirectoryInspectorOptions = {},
): InspectDirectories {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DIRECTORY_CHECK_TIMEOUT_MS;
  const execPath = options.execPath ?? process.execPath;
  return async (paths) =>
    platform === "darwin"
      ? inspectOutOfProcess(paths, { timeoutMs, execPath })
      : inspectInProcess(paths);
}
