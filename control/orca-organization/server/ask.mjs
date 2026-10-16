import { stopRecordedTree } from "./api-process-tree.mjs";
// Fulcra 0.2.17 (FU-58): `fulcra ask`, a one-shot model call for apps. It takes a pooled Claude account, runs the Claude
// CLI once in print mode with NO tools, in an empty scratch folder and a scratch config home, and returns the answer.
// It creates no agent, no workspace and no session record, so nothing shows in any list. A usage limit marks the
// account limited (kind and reset time) and the call is tried once more on the next usable account. The machine's own
// login is never used: with no pooled account the call fails.
import { createApiRuntimeChannel } from "./api-runtime-channel.mjs";
import { randomUUID } from "node:crypto";
import { recordAccountCost, recordBillingError, isBillingError } from "./account-billing.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseLimitLine, parseRevokedLine } from "./limit-line.mjs";
import {
  accountStatus,
  launchEnv,
  credentialKind,
  setAccount,
  isApiAccount,
  choose,
  markAccountLimited,
  markAccountRevoked,
  readAccountsAsync,
  readUsageAsync,
} from "./accounts.mjs";

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
/** A retry with less time than this left is not started. */
export const MIN_ATTEMPT_MS = 1000;

/** Runs the Claude CLI once. API keys reach only apiKeyHelper stdout. Subscription tokens use the child environment. */
export function spawnClaudeOnce({
  token,
  root,
  accountId,
  keyEpoch,
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
  const api = credentialKind(token) === "api-key";
  if (api) {
    try {
      const helper = launchEnv(
        "claude",
        { id: accountId, keyEpoch },
        { token, root, env },
      ).FULCRA_API_KEY_HELPER;
      args.push("--settings", JSON.stringify({ apiKeyHelper: helper }));
    } catch {
      removeScratch(scratch);
      return Promise.reject(new AskError("The API key helper could not start", "NO_CREDENTIAL"));
    }
  }
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  const childEnv = {
    PATH: env.PATH ?? "",
    HOME: env.HOME ?? scratch,
    ...(env.USERPROFILE ? { USERPROFILE: env.USERPROFILE } : {}),
    ...(env.SYSTEMROOT ? { SYSTEMROOT: env.SYSTEMROOT, ComSpec: env.ComSpec ?? "" } : {}),
    ...(env.TEMP ? { TEMP: env.TEMP } : {}),
    // A scratch config home: nothing is read from, or written to, the machine's own Claude settings or login.
    CLAUDE_CONFIG_DIR: path.join(scratch, "config"),
    CLAUDE_CODE_OAUTH_TOKEN: credentialKind(token) === "api-key" ? "" : token,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
  };
  const command = bin ?? env.FULCRA_CLAUDE_BIN ?? "claude";
  try {
    refuseShellShim(command);
  } catch (error) {
    removeScratch(scratch);
    return Promise.reject(error);
  }
  let requestStop = () => {};
  const channel = api
    ? createApiRuntimeChannel({
        root,
        accountId,
        epoch: keyEpoch ?? null,
        onStop: () => requestStop(),
      })
    : null;
  const releaseLease = () => channel?.release();
  return new Promise((resolve, reject) => {
    // On Unix the child leads its own process group, so a timeout can stop it and everything it started (FU-93).
    const child = spawn(command, args, {
      cwd: scratch,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
    });
    let watcher;
    let out = "";
    let settled = false;
    let leaderExited = false;
    let stopping = false;
    let childStart = null;
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      removeScratch(scratch);
      settle();
    };
    child.on("exit", () => {
      leaderExited = true;
      if (!stopping) releaseLease();
    });
    // The call ends at the deadline, without waiting for a process that holds the pipes. While the leader runs, its
    // process tree is stopped. Once it has exited, its numeric ID may belong to another process now, so nothing is
    // killed by that number: the pipes are closed and the call is rejected on its own (0.2.17 review).
    const timer = setTimeout(() => {
      if (api) requestStop("TIMEOUT");
      else if (leaderExited) closePipes(child);
      else killProcessTree(child);
      finish(() => reject(new AskError("The call timed out", "TIMEOUT")));
    }, timeoutMs);
    requestStop = (code = "ACCOUNT_REVOKED") => {
      if (stopping) return;
      stopping = true;
      if (api) {
        void stopRecordedTree(child.pid, childStart)
          .then(releaseLease)
          .catch(() => {
            // Use the retained child handle for a best-effort stop, without acknowledging success.
            killProcessTree(child);
          });
      } else killProcessTree(child);
      finish(() =>
        reject(
          new AskError(
            code === "TIMEOUT" ? "The call timed out" : "The API account is revoked or unavailable",
            code,
          ),
        ),
      );
    };
    if (api) {
      try {
        childStart = channel.attach(child);
      } catch {
        requestStop();
      }
      const check = () => {
        try {
          const a = JSON.parse(
            fs.readFileSync(path.join(root, "accounts/accounts.json"), "utf8"),
          ).accounts.find((a) => a.id === accountId);
          if (
            !a ||
            !a.enabled ||
            a.revoked ||
            a.localRevoked ||
            a.auth !== "ok" ||
            (a.keyEpoch ?? null) !== (keyEpoch ?? null)
          )
            throw Error();
        } catch {
          requestStop();
        }
      };
      try {
        if (!settled) watcher = fs.watch(path.join(root, "accounts"), check);
        check();
      } catch {
        requestStop();
      }
    }
    child.stdout.on("data", (d) => {
      if (out.length < 5_000_000) out += d;
    });
    child.stderr.resume();
    // A CLI that exits before it reads a large prompt closes the pipe; the close handler reports it (FU-93 review).
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      releaseLease();
      // A fixed text, with only a short system code: a spawn error's own message can name the command line.
      const code =
        typeof e?.code === "string" && /^[A-Z0-9_]{2,24}$/.test(e.code) ? e.code : "unknown";
      finish(() =>
        reject(new AskError(`The Claude CLI could not start (${code})`, "CLI_UNAVAILABLE")),
      );
    });
    child.on("close", () => {
      finish(() => {
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new AskError("The Claude CLI gave no JSON result", "BAD_RESULT"));
        }
      });
    });
    child.stdin.end(prompt);
  });
}

/** Removes the scratch folder. A file that is still open (Windows) must not throw inside an event handler. */
function removeScratch(folder) {
  try {
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the folder is in the temp directory; the next run does not depend on it */
  }
}

/** Closes the child's pipes so a process that still holds them cannot keep the call waiting. */
export function closePipes(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream?.destroy();
    } catch {
      /* already closed */
    }
  }
}

const hasExited = (child) => child.exitCode != null || child.signalCode != null;

/**
 * Stops the child and what it started, as far as this process can. Unix: the child's process group, only while the
 * child has not exited (the number then names its group and nothing else). Windows: `taskkill /T /F`, and the child
 * itself is killed only after taskkill has finished, because taskkill looks the child up by its ID. A descendant that
 * left the group or the tree (detached) is not stopped: that needs a retained handle such as a Windows Job Object.
 */
export function killProcessTree(child, { platform = process.platform, run = spawn } = {}) {
  const pid = child.pid;
  const killLeader = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  if (!pid || hasExited(child)) return;
  if (platform === "win32") {
    try {
      const proc = run("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      proc.on("error", killLeader);
      proc.on("exit", killLeader);
      proc.unref?.();
      return;
    } catch {
      killLeader();
      return;
    }
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* no group: fall back to the child itself */
  }
  killLeader();
}

/**
 * FU-112 follow-up (0.2.17 review): the selected account's credential must not reach an error, a result, a model name
 * or a saved limit note, whatever the child prints. Every string and every object key in child-derived data has the
 * exact credential (and its JSON and URL forms) replaced. Too short a value is not replaced: it would mangle text.
 */
export const REDACTED = "[redacted]";
export const TOO_DEEP = "[too deep to check]";
const MAX_SCRUB_DEPTH = 20;
export function scrubCredential(value, token, { onCutoff = () => {} } = {}) {
  if (typeof token !== "string" || token.length < 8) return value;
  const forms = [
    ...new Set([token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)]),
  ];
  const clean = (text) => forms.reduce((s, form) => s.split(form).join(REDACTED), text);
  const walk = (v, depth, rootKey) => {
    if (typeof v === "string") return clean(v);
    if (v === null || typeof v !== "object") return v;
    // Never return child data that was not walked: a subtree below the bound is replaced whole.
    if (depth > MAX_SCRUB_DEPTH) {
      onCutoff(rootKey);
      return TOO_DEEP;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, rootKey));
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [clean(k), walk(x, depth + 1, depth === 0 ? k : rootKey)]),
    );
  };
  return walk(value, 0);
}

/** The credential, or null when it is missing; a lookup that outlasts the ask's deadline is a timeout. */
async function lookupCredential(keychain, id, budgetMs) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new AskError("The call timed out", "TIMEOUT")),
      Math.max(0, budgetMs),
    );
  });
  try {
    return await Promise.race([keychain.get(id).catch(() => null), expired]);
  } finally {
    clearTimeout(timer);
  }
}

const describeTried = (t) =>
  t.kind === "revoked" ? `${t.name}: token revoked` : `${t.name}: ${t.kind} until ${t.until}`;
// The error when no account is left to try: all revoked, or at a limit, or a mix, each said plainly (FU-112).
function noAccountError(all, who = "Every usable Claude account") {
  if (!all.length) return new AskError("No usable Claude account in the pool", "NO_ACCOUNT");
  const detail = all.map(describeTried).join("; ");
  if (all.every((t) => t.kind === "revoked"))
    return new AskError(
      `${who} has a revoked or invalid token (${detail}); sign the account in again`,
      "ALL_REVOKED",
    );
  return new AskError(`${who} is down or at its limit (${detail})`, "ALL_LIMITED");
}
// FU-112: a revoked or invalid token: an HTTP 401 from the CLI, or its one-line "Failed to authenticate" text.
const isRevoked = (result) =>
  result?.is_error === true &&
  (result.api_error_status === 401 || parseRevokedLine(String(result.result ?? "")) !== null);
const isLimit = (result, now) =>
  result?.is_error === true &&
  (result.api_error_status === 429 || parseLimitLine(String(result.result ?? ""), now) !== null);

// A name (any case) or an ID, as `fulcra run --account` takes it.
const namedAccount = (state, name) => {
  const wanted = String(name).trim().toLowerCase();
  return state.accounts.find(
    (a) =>
      a.provider === "claude" && (a.name.toLowerCase() === wanted || a.id.toLowerCase() === wanted),
  );
};

/** A 429 with no limit line (a short rate limit, not a usage limit) holds the account this long, not 5 hours. */
export const RATE_LIMIT_HOLD_MS = 10 * 60_000;

/**
 * One call. Returns { output, account, model, costUsd }. With `account` named, only that account is used and a limit
 * is an error; otherwise the pool chooses, and a limit moves the call once to the next usable account.
 */
export async function askOnce({
  root,
  keychain,
  input,
  spawnClaude = spawnClaudeOnce,
  limitProbe = false,
  now = Date.now,
}) {
  const { prompt, model, schema = null, account = null } = input;
  if (limitProbe && !account) throw new AskError("A limit probe needs an account", "BAD_INPUT");
  if (typeof prompt !== "string" || !prompt.trim())
    throw new AskError("Give a prompt", "BAD_INPUT");
  if (prompt.length > MAX_PROMPT_CHARS) throw new AskError("The prompt is too long", "BAD_INPUT");
  if (typeof model !== "string" || !/^claude-[a-z0-9][a-z0-9.-]{1,100}$/.test(model))
    throw new AskError("Name a Claude model, for example claude-sonnet-5-5", "BAD_INPUT");
  const timeoutMs = Math.min(
    Math.max(Number(input.timeoutMs) || DEFAULT_ASK_TIMEOUT_MS, 1000),
    MAX_ASK_TIMEOUT_MS,
  );
  // One absolute deadline for the whole ask: a retry on the next account gets only the time that is left, so the
  // caller's own wait (timeout plus a margin) is never shorter than the host's work (0.2.17 review).
  const deadline = now() + timeoutMs;
  const tried = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const at = now();
    const remainingMs = deadline - at;
    if (remainingMs < MIN_ATTEMPT_MS) throw new AskError("The call timed out", "TIMEOUT");
    const state = await readAccountsAsync(root);
    let picked;
    if (account) {
      picked = namedAccount(state, account);
      if (!picked) throw new AskError(`No Claude account is named "${account}"`, "NO_ACCOUNT");
      const status = accountStatus(picked, at);
      if (
        status.state !== "ok" &&
        !(status.state === "limited" && (limitProbe || picked.credentialKind == null))
      )
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
        await readUsageAsync(root, at),
      );
      if (!picked) {
        // Accounts may be limited from earlier calls: say so, with the reset, instead of "no account".
        const limited = state.accounts
          .filter((x) => x.provider === "claude" && accountStatus(x, at).state === "limited")
          .map((x) => ({ name: x.name, kind: x.limitKind ?? "usage", until: x.limitedUntil }));
        const all = [...tried, ...limited.filter((l) => !tried.some((t) => t.name === l.name))];
        throw noAccountError(all);
      }
    }
    // The lookup is bounded by the same deadline, and the time left is worked out again right before the spawn.
    const token = await lookupCredential(keychain, picked.id, deadline - now());
    if (!token)
      throw new AskError(`The credential for "${picked.name}" is not available`, "NO_CREDENTIAL");
    const current = (await readAccountsAsync(root)).accounts.find((a) => a.id === picked.id);
    if (
      !current ||
      !current.enabled ||
      current.localRevoked ||
      current.revoked ||
      current.auth !== "ok" ||
      (current.keyEpoch ?? null) !== (picked.keyEpoch ?? null)
    )
      throw new AskError("The API account changed during credential lookup", "NO_CREDENTIAL");
    const kind = credentialKind(token);
    await setAccount(root, picked.id, { credentialKind: kind });
    picked.credentialKind = kind;
    if (!limitProbe && accountStatus({ ...picked, credentialKind: kind }, at).state === "limited")
      throw new AskError("The subscription account is at its limit", "ACCOUNT_LIMITED");
    if (limitProbe && isApiAccount(picked))
      throw new AskError("API accounts have no subscription limit", "API_ACCOUNT");
    const spawnMs = deadline - now();
    if (spawnMs < MIN_ATTEMPT_MS) throw new AskError("The call timed out", "TIMEOUT");
    let result;
    let structuredCutoff = false;
    try {
      result = scrubCredential(
        await spawnClaude({
          token,
          root,
          accountId: picked.id,
          keyEpoch: picked.keyEpoch,
          model,
          prompt,
          schema,
          timeoutMs: spawnMs,
        }),
        token,
        {
          onCutoff: (key) => {
            if (key === "structured_output") structuredCutoff = true;
          },
        },
      );
    } catch (error) {
      // Only an error this module made is passed on; anything else has no text of its own here.
      if (isBillingError(error?.message)) {
        await recordBillingError(root, picked.id, new Date(now()).toISOString());
        throw new AskError("The API account has insufficient credit", "BILLING_ERROR");
      }
      if (error instanceof AskError) throw error;
      throw new AskError("The Claude call failed", "ASK_FAILED");
    }
    if (typeof result?.total_cost_usd === "number")
      await recordAccountCost(root, {
        id: `ask:${randomUUID()}`,
        accountId: picked.id,
        costUsd: result.total_cost_usd,
        at: new Date(now()).toISOString(),
      });
    if (result?.is_error && isBillingError(result?.result)) {
      await recordBillingError(root, picked.id, new Date(now()).toISOString());
      throw new AskError("The API account has insufficient credit", "BILLING_ERROR");
    }
    if (isRevoked(result)) {
      const line = String(result.result ?? "");
      await markAccountRevoked(root, picked.id, { note: line }, at);
      tried.push({ id: picked.id, name: picked.name, kind: "revoked", until: "re-sign-in" });
      if (account)
        throw new AskError(
          `Account "${picked.name}" has a revoked or invalid token; sign it in again`,
          "ACCOUNT_REVOKED",
        );
      continue;
    }
    if (isLimit(result, at)) {
      const line = String(result.result ?? "");
      const parsed = parseLimitLine(line, at);
      if (limitProbe) {
        if (!parsed)
          throw new AskError("The probe did not report a subscription limit", "PROBE_UNCONFIRMED");
        const error = new AskError(
          "The live ask confirmed a subscription limit",
          "CONFIRMED_LIMIT",
        );
        error.confirmedLimit = { accountId: picked.id, resetAt: parsed.resetAt, kind: parsed.kind };
        throw error;
      }
      const marked = await markAccountLimited(
        root,
        picked.id,
        parsed
          ? { resetAt: parsed.resetAt, kind: parsed.kind, note: line }
          : { resetAt: new Date(at + RATE_LIMIT_HOLD_MS).toISOString(), kind: "rate", note: line },
        at,
      );
      if (!marked)
        throw new AskError("The API request was rate limited; retry later", "API_RATE_LIMITED");
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
      if (structuredCutoff)
        throw new AskError(
          "The structured answer exceeds the privacy check depth",
          "OUTPUT_SCHEMA_FAILED",
        );
      output = result.structured_output ?? null;
      if (output === null)
        try {
          let cutoff = false;
          output = scrubCredential(JSON.parse(text), token, {
            onCutoff: () => {
              cutoff = true;
            },
          });
          if (cutoff)
            throw new AskError(
              "The structured answer exceeds the privacy check depth",
              "OUTPUT_SCHEMA_FAILED",
            );
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
  throw noAccountError(tried, "Both accounts tried");
}
