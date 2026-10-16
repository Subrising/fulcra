import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const sdkUrl = pathToFileURL(
  createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
).href;
// Return a status only. A conflicting legacy key never reaches stdout or an exception message.
const RESOLVE = String.raw`
try {
  const sdk = await import(process.argv[1]);
  const resolved = await sdk.resolveSettings({cwd: process.argv[2], settingSources: ["user","project","local"]});
  const bad = resolved.sources.some(({source,settings:s}) =>
    /sk-ant-api/i.test(JSON.stringify(s)) ||
    Object.keys(s.env ?? {}).some(k => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$)/i.test(k)) ||
    s.forceLoginMethod || s.forceLoginOrgUUID ||
    (source === "managed" && (s.apiKeyHelper || s.policyHelper || s.policyHelpers || s.forceLoginGatewayUrl)));
  process.stdout.write(bad ? "conflict" : "ok");
} catch { process.stdout.write("unavailable"); }
`;
const conflict = () =>
  new Error("Remove authentication from native Claude settings before using an API account");

function readNativeSettings(file: string): unknown {
  let value: unknown;
  let failed = false;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    failed = true;
  }
  // Do not attach a parse error: its diagnostic can contain a legacy key.
  if (failed) throw new Error("The API account cannot verify native Claude settings");
  return value;
}

function hasAuthentication(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const settings = value as Record<string, unknown>;
  return (
    /sk-ant-api/i.test(JSON.stringify(settings)) ||
    Object.keys((settings.env ?? {}) as Record<string, unknown>).some((key) =>
      /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$)/i.test(key),
    ) ||
    Boolean(
      settings.forceLoginMethod ||
      settings.forceLoginOrgUUID ||
      settings.policyHelper ||
      settings.policyHelpers,
    )
  );
}

// Native settings apply env after spawn. Keep ordinary settings, but refuse conflicting authentication sources.
export function assertSafeClaudeApiSettings(cwd: string, env: Record<string, string>): void {
  const files = new Set<string>();
  files.add(
    path.join(
      env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude"),
      "settings.json",
    ),
  );
  let dir = path.resolve(cwd);
  for (;;) {
    files.add(path.join(dir, ".claude/settings.json"));
    files.add(path.join(dir, ".claude/settings.local.json"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const childEnv: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "CLAUDE_CONFIG_DIR",
    "SystemRoot",
    "ProgramFiles",
    "TEMP",
    "TMP",
  ])
    if (env[key]) childEnv[key] = env[key];
  // New native CLIs also load the main checkout's local file for a worktree.
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      env: childEnv,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    files.add(path.join(path.dirname(path.resolve(cwd, common)), ".claude/settings.local.json"));
  } catch {
    /* A directory without Git still has user and directory settings. */
  }
  for (const file of files) {
    if (hasAuthentication(readNativeSettings(file))) throw conflict();
  }

  let status;
  try {
    status = execFileSync(process.execPath, ["--input-type=module", "-e", RESOLVE, sdkUrl, cwd], {
      cwd,
      env: childEnv,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 32,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("The API account cannot verify native Claude settings");
  }
  if (status === "conflict") throw conflict();
  if (status !== "ok") throw new Error("The API account cannot verify native Claude settings");
}

function safeApiFlagSettings(value: unknown, helper: string): boolean {
  if (!value || typeof value !== "object") return false;
  const settings = value as Record<string, unknown>;
  return (
    settings.apiKeyHelper === helper &&
    !Object.keys((settings.env ?? {}) as object).length &&
    !["forceLoginMethod", "forceLoginOrgUUID", "policyHelper", "policyHelpers"].some(
      (key) => settings[key],
    )
  );
}

// Check the final argv, after SDK extraArgs and runtime append/replace commands have applied.
export function assertClaudeApiCommand(args: string[], helper: string): void {
  const denied = () =>
    new Error("Remove authentication overrides from the Claude command arguments");
  if (args.some((arg) => /^--managed-settings(?:=|$)/.test(arg))) throw denied();
  const sources = args.filter((arg) => /^--setting-sources(?:=|$)/.test(arg));
  if (sources.length > 1) throw denied();
  let count = 0;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!/^--settings(?:=|$)/.test(flag)) continue;
    count++;
    let value;
    try {
      value = JSON.parse(flag === "--settings" ? args[i + 1]! : flag.slice("--settings=".length));
    } catch {
      throw denied();
    }
    if (!safeApiFlagSettings(value, helper)) throw denied();
  }
  if (count !== 1) throw denied();
}
