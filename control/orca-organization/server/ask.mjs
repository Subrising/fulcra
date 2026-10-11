// Fulcra 0.2.17 (FU-58): `fulcra ask`, a one-shot model call for apps. It takes a pooled Claude account, runs the Claude
// CLI once in print mode with NO tools, in an empty scratch folder and a scratch config home, and returns the answer.
// It creates no agent, no workspace and no session record, so nothing shows in any list. A usage limit marks the
// account limited (kind and reset time) and the call is tried once more on the next usable account. The machine's own
// login is never used: with no pooled account the call fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseLimitLine } from "../../src/control/usage-limits.mjs";
import { accountStatus, choose, markAccountLimited, readAccounts, readUsage } from "./accounts.mjs";

export class AskError extends Error {
  constructor(message, code = "ASK_FAILED") {
    super(message);
    this.name = "AskError";
    this.code = code;
  }
}

/**
 * A Windows shell shim (.cmd or .bat) runs only through cmd.exe, which loses empty arguments (so --tools "" could turn
 * tools back on) and runs `&`, `|` and `^` in the schema as commands. Fulcra never uses a shell here, so a shim is
 * refused with a plain error (FU-92). Use the native claude.exe.
 */
export function refuseShellShim(command) {
  if (/\.(cmd|bat)$/i.test(String(command)))
    throw new AskError(
      "FULCRA_CLAUDE_BIN names a .cmd or .bat file. Fulcra does not run those, because a shell would change the arguments. Use the native claude.exe.",
      "CLI_UNSUPPORTED",
    );
}

const MAX_PROMPT_CHARS = 200_000;
export const MAX_ASK_TIMEOUT_MS = 10 * 60_000;
// Most calls end in seconds; the bound keeps a stuck call from holding the controller.
export const DEFAULT_ASK_TIMEOUT_MS = 120_000;

/** Runs the Claude CLI once. The credential goes in the environment of this one process, never in argv or a file. */
export function spawnClaudeOnce({
  token,
  model,
  prompt,
  schema,
  timeoutMs,
  bin,
  env = process.env,
}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-ask-"));
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--tools",
    "",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--disable-slash-commands",
  ];
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  const childEnv = {
    PATH: env.PATH ?? "",
    HOME: env.HOME ?? scratch,
    ...(env.USERPROFILE ? { USERPROFILE: env.USERPROFILE } : {}),
    ...(env.SYSTEMROOT ? { SYSTEMROOT: env.SYSTEMROOT, ComSpec: env.ComSpec ?? "" } : {}),
    ...(env.TEMP ? { TEMP: env.TEMP } : {}),
    // A scratch config home: nothing is read from, or written to, the machine's own Claude settings or login.
    CLAUDE_CONFIG_DIR: path.join(scratch, "config"),
    CLAUDE_CODE_OAUTH_TOKEN: token,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
  };
  const command = bin ?? env.FULCRA_CLAUDE_BIN ?? "claude";
  try {
    refuseShellShim(command);
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true });
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: scratch,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (out.length < 5_000_000) out += d;
    });
    child.stderr.resume();
    child.on("error", (e) => {
      clearTimeout(timer);
      fs.rmSync(scratch, { recursive: true, force: true });
      reject(
        new AskError(`The Claude CLI could not start: ${e.code ?? e.message}`, "CLI_UNAVAILABLE"),
      );
    });
    child.on("close", () => {
      clearTimeout(timer);
      fs.rmSync(scratch, { recursive: true, force: true });
      if (timedOut) return reject(new AskError("The call timed out", "TIMEOUT"));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new AskError("The Claude CLI gave no JSON result", "BAD_RESULT"));
      }
    });
    child.stdin.end(prompt);
  });
}

const isLimit = (result, now) =>
  result?.is_error === true &&
  (result.api_error_status === 429 || parseLimitLine(String(result.result ?? ""), now) !== null);

const namedAccount = (state, name) => {
  const wanted = String(name).trim().toLowerCase();
  return state.accounts.find((a) => a.provider === "claude" && a.name.toLowerCase() === wanted);
};

/**
 * One call. Returns { output, account, model, costUsd }. With `account` named, only that account is used and a limit
 * is an error; otherwise the pool chooses, and a limit moves the call once to the next usable account.
 */
export async function askOnce({
  root,
  keychain,
  input,
  spawnClaude = spawnClaudeOnce,
  now = Date.now,
}) {
  const { prompt, model, schema = null, account = null } = input;
  if (typeof prompt !== "string" || !prompt.trim())
    throw new AskError("Give a prompt", "BAD_INPUT");
  if (prompt.length > MAX_PROMPT_CHARS) throw new AskError("The prompt is too long", "BAD_INPUT");
  if (typeof model !== "string" || !/^claude-[a-z0-9][a-z0-9.-]{1,100}$/.test(model))
    throw new AskError("Name a Claude model, for example claude-sonnet-5-5", "BAD_INPUT");
  const timeoutMs = Math.min(
    Math.max(Number(input.timeoutMs) || DEFAULT_ASK_TIMEOUT_MS, 1000),
    MAX_ASK_TIMEOUT_MS,
  );
  const tried = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const at = now();
    const state = readAccounts(root);
    let picked;
    if (account) {
      picked = namedAccount(state, account);
      if (!picked) throw new AskError(`No Claude account is named "${account}"`, "NO_ACCOUNT");
      const status = accountStatus(picked, at);
      if (status.state !== "ok")
        throw new AskError(
          `Account "${picked.name}" cannot be used now (${status.state}${status.until ? ` until ${status.until}` : ""})`,
          status.state === "limited" ? "ACCOUNT_LIMITED" : "NO_ACCOUNT",
        );
    } else {
      picked = choose(
        state,
        "claude",
        at,
        tried.map((t) => t.id),
        readUsage(root, at),
      );
      if (!picked) {
        // Accounts may be limited from earlier calls: say so, with the reset, instead of "no account".
        const limited = state.accounts
          .filter((x) => x.provider === "claude" && accountStatus(x, at).state === "limited")
          .map((x) => ({ name: x.name, kind: x.limitKind ?? "usage", until: x.limitedUntil }));
        const all = [...tried, ...limited.filter((l) => !tried.some((t) => t.name === l.name))];
        throw new AskError(
          all.length
            ? `Every usable Claude account is at its limit (${all.map((t) => `${t.name}: ${t.kind} until ${t.until}`).join("; ")})`
            : "No usable Claude account in the pool",
          all.length ? "ALL_LIMITED" : "NO_ACCOUNT",
        );
      }
    }
    let token = null;
    try {
      token = await keychain.get(picked.id);
    } catch {
      token = null;
    }
    if (!token)
      throw new AskError(`The credential for "${picked.name}" is not available`, "NO_CREDENTIAL");
    const result = await spawnClaude({ token, model, prompt, schema, timeoutMs });
    if (isLimit(result, at)) {
      const line = String(result.result ?? "");
      const parsed = parseLimitLine(line, at);
      const marked = await markAccountLimited(
        root,
        picked.id,
        { resetAt: parsed?.resetAt ?? null, kind: parsed?.kind ?? "usage", note: line },
        at,
      );
      tried.push({
        id: picked.id,
        name: picked.name,
        kind: marked?.limitKind ?? "usage",
        until: marked?.limitedUntil ?? "unknown",
      });
      if (account)
        throw new AskError(
          `Account "${picked.name}" is at its ${tried[0].kind} limit until ${tried[0].until}`,
          "ACCOUNT_LIMITED",
        );
      continue;
    }
    if (result?.is_error)
      throw new AskError(
        `The model call failed: ${String(result.result ?? "unknown error").slice(0, 300)}`,
      );
    const text = String(result?.result ?? "");
    let output = text;
    if (schema) {
      output = result.structured_output ?? null;
      if (output === null)
        try {
          output = JSON.parse(text);
        } catch {
          throw new AskError("The answer did not match the output schema", "OUTPUT_SCHEMA_FAILED");
        }
    }
    const used = Object.keys(result.modelUsage ?? {})[0] ?? model;
    return {
      output,
      account: picked.name,
      model: used,
      costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    };
  }
  throw new AskError(
    `Both accounts tried are at their limit (${tried.map((t) => `${t.name}: ${t.kind} until ${t.until}`).join("; ")})`,
    "ALL_LIMITED",
  );
}
