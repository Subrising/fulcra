// Runs one deploy tool (rad, bicep, k3d, git, gh, docker) without a shell, with a time limit, and hands back each
// output line as it arrives. Arguments are an array; nothing here ever builds a command string.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const EXTRA_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

/** The environment a tool sees: only what it needs. KUBECONFIG is set per call, never inherited. */
export function toolEnvironment({ bin, kubeconfig } = {}) {
  const env = {
    PATH: [
      ...new Set([bin, path.join(os.homedir(), ".rad", "bin"), ...EXTRA_PATH].filter(Boolean)),
    ].join(":"),
    HOME: os.homedir(),
    LANG: "en_US.UTF-8",
    // Docker Desktop, Colima and OrbStack each choose their own socket; keep whichever the user set.
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    ...(process.env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}),
    // gh signs in through its own keychain item; it needs nothing else from us.
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
  };
  // An empty KUBECONFIG makes client-go fall back to ~/.kube/config, so point it at nothing instead.
  env.KUBECONFIG = kubeconfig ?? "/dev/null";
  return env;
}

export class ToolError extends Error {
  constructor(message, { code = null, output = "" } = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.output = output;
  }
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ env?: Record<string,string>, cwd?: string, timeoutMs?: number, onLine?: (line: string) => void, input?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runTool(file, args, options = {}) {
  const { env = toolEnvironment(), cwd, timeoutMs = 120_000, onLine, input, signal } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], signal });
    } catch (error) {
      reject(new ToolError(`Could not start ${path.basename(file)}: ${error.message}`));
      return;
    }
    let stdout = "",
      stderr = "",
      pending = "";
    const LIMIT = 4 * 1024 * 1024;
    const feed = (chunk, toStdout) => {
      const text = chunk.toString("utf8");
      if (toStdout && stdout.length < LIMIT) stdout += text;
      if (!toStdout && stderr.length < LIMIT) stderr += text;
      if (!onLine) return;
      pending += text;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on("data", (c) => feed(c, true));
    child.stderr.on("data", (c) => feed(c, false));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new ToolError(
          error.code === "ENOENT" ? `${path.basename(file)} is not installed` : error.message,
          { code: null },
        ),
      );
    });
    child.on("close", (code, killed) => {
      clearTimeout(timer);
      if (onLine && pending.trim()) onLine(pending);
      if (killed === "SIGTERM" && code === null)
        reject(
          new ToolError(`${path.basename(file)} took too long and was stopped`, {
            output: stderr || stdout,
          }),
        );
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Run and require success; the error carries the tool's last lines, which the job log keeps. */
export async function mustRun(file, args, options = {}) {
  const result = await runTool(file, args, options);
  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n");
    throw new ToolError(tail || `${path.basename(file)} failed (exit ${result.code})`, {
      code: result.code,
      output: result.stderr || result.stdout,
    });
  }
  return result;
}
