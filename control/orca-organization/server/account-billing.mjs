// Durable, secret-free API accounting. IDs belong to the producing call/turn, never the current assignment.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  accountBudget,
  accountsDir,
  withStoreLock,
  readAccountsAsync,
  readAccounts,
} from "./accounts.mjs";
const uuid = (v) => typeof v === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export function readBilling(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(accountsDir(root), "billing.json"), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { v: 1, calls: {}, events: [] };
    throw e;
  }
}
async function save(root, state) {
  const dir = accountsDir(root);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.billing-${randomUUID()}.json`);
  await fsp.writeFile(tmp, JSON.stringify(state) + "\n", { mode: 0o600, flag: "wx" });
  await fsp.rename(tmp, path.join(dir, "billing.json"));
}
function compact(state, pool) {
  const starts = pool.accounts
    .map(accountBudget)
    .filter(Boolean)
    .map((b) => Date.parse(b.startAt));
  if (!starts.length) return;
  const oldest = Math.min(...starts, Date.parse(new Date().toISOString().slice(0, 10)));
  for (const [id, call] of Object.entries(state.calls))
    if (!call.sessionId && !id.startsWith("turn:") && Date.parse(call.at) < oldest)
      delete state.calls[id];
  // A billing error remains observable for its budget period. Repeated failures replace the same metadata row.
  const latest = new Map();
  for (const event of state.events) {
    const key = `${event.accountId}:${event.type}`;
    if (
      Date.parse(event.at) >= oldest &&
      Date.parse(event.at) >= Date.parse(latest.get(key)?.at ?? "1970-01-01")
    )
      latest.set(key, event);
  }
  state.events = [...latest.values()];
  state.retainedFrom = new Date(oldest).toISOString();
}
export function accountSpend(root, account, billing = readBilling(root)) {
  const budget = accountBudget(account);
  if (!budget) return null;
  const start = Date.parse(budget.startAt);
  const usedUsd = Object.values(billing.calls).reduce(
    (sum, call) =>
      call.accountId === account.id && Date.parse(call.at) >= start ? sum + call.costUsd : sum,
    0,
  );
  return { ...budget, usedUsd };
}
export async function recordAccountCost(
  root,
  {
    id,
    accountId,
    costUsd,
    at = new Date().toISOString(),
    runtimeSessionId = null,
    cumulativeUsd = null,
    sessionId = null,
    cursorCheckpoint = null,
  },
) {
  if (
    !uuid(accountId) ||
    typeof id !== "string" ||
    !id ||
    id.length > 200 ||
    !Number.isFinite(costUsd) ||
    costUsd < 0 ||
    !Number.isFinite(Date.parse(at))
  )
    return false;
  return withStoreLock(root, async () => {
    const state = readBilling(root);
    if (Object.hasOwn(state.calls, id)) return false;
    if (
      typeof runtimeSessionId === "string" &&
      /^[a-zA-Z0-9_.-]{1,128}$/.test(runtimeSessionId) &&
      Number.isFinite(cumulativeUsd) &&
      cumulativeUsd >= 0
    ) {
      state.cursors ??= {};
      const previous = state.cursors[runtimeSessionId]?.cumulativeUsd ?? 0;
      costUsd = cumulativeUsd >= previous ? cumulativeUsd - previous : cumulativeUsd;
      state.cursors[runtimeSessionId] = { cumulativeUsd, at };
    }
    state.calls[id] = { accountId, costUsd, at, ...(uuid(sessionId) ? { sessionId } : {}) };
    if (uuid(sessionId) && cursorCheckpoint !== null) {
      if (
        typeof cursorCheckpoint !== "object" ||
        Array.isArray(cursorCheckpoint) ||
        !Object.values(cursorCheckpoint).every((value) => Number.isFinite(value) && value >= 0)
      )
        throw Error("Invalid session cost cursor checkpoint");
      state.checkpoints ??= {};
      state.checkpoints[sessionId] = { ...cursorCheckpoint };
    }
    compact(state, await readAccountsAsync(root));
    await save(root, state);
    return true;
  });
}
export async function recordBillingError(
  root,
  accountId,
  at = new Date().toISOString(),
  type = "ask.billing_error",
) {
  if (!uuid(accountId) || !Number.isFinite(Date.parse(at))) return false;
  if (!["ask.billing_error", "session.billing_error"].includes(type)) return false;
  return withStoreLock(root, async () => {
    const state = readBilling(root);
    // Only these three fields cross this durable boundary. No provider error, prompt or credential.
    state.events.push({ type, accountId, at });
    compact(state, await readAccountsAsync(root));
    await save(root, state);
    return true;
  });
}
export const isBillingError = (value) =>
  /credit balance (?:is )?too low|insufficient (?:credit|balance)|billing_error/i.test(
    String(value ?? ""),
  );

export function dailySpend(root, account, billing = readBilling(root), now = Date.now()) {
  if (!accountBudget(account)) return null;
  const start = new Date(now).toISOString().slice(0, 10) + "T00:00:00.000Z";
  const end = Date.parse(start) + 86400000;
  const usedUsd = Object.values(billing.calls).reduce(
    (sum, call) =>
      call.accountId === account.id &&
      Date.parse(call.at) >= Date.parse(start) &&
      Date.parse(call.at) < end
        ? sum + call.costUsd
        : sum,
    0,
  );
  return { startAt: start, limitUsd: account.dailyLimitUsd ?? 40, usedUsd };
}

/** The call site supplies the launch account, never a mutable current assignment. */
export function assertApiSpendAllowed(root, input, now = Date.now()) {
  if (input.provider !== "claude" || !input.accountId) return;
  const account = readAccounts(root).accounts.find((a) => a.id === input.accountId);
  if (!account) throw Error("API account is unavailable. No turn started.");
  if (!accountBudget(account)) return;
  const billing = readBilling(root);
  for (const [scope, spend] of [
    ["account", accountSpend(root, account, billing)],
    ["daily UTC", dailySpend(root, account, billing, now)],
  ]) {
    if (spend.limitUsd !== null && spend.usedUsd >= spend.limitUsd)
      throw Error(
        `API ${scope} cost cap reached ($${spend.usedUsd.toFixed(2)} / $${spend.limitUsd.toFixed(2)}). No turn started.`,
      );
  }
  const raw = input.labels?.["fulcra.session-cost-cap-usd"];
  if (raw !== undefined) {
    const cap = Number(raw);
    if (!Number.isFinite(cap) || cap <= 0)
      throw Error("Invalid session cost cap. No turn started.");
    if ((input.sessionCost?.totalUsd ?? 0) >= cap)
      throw Error(
        `API session cost cap reached ($${input.sessionCost.totalUsd.toFixed(2)} / $${cap.toFixed(2)}). No turn started.`,
      );
  }
}

export function readSessionBilling(root, request) {
  if (request.provider !== "claude") return;
  const billing = readBilling(root);
  const records = structuredClone(request.records ?? { cursors: {}, turns: {} });
  const prefix = `turn:${request.agentId}:`;
  for (const [id, row] of Object.entries(billing.calls)) {
    if (!id.startsWith(prefix)) continue;
    const turnId = id.slice(prefix.length);
    records.turns[turnId] ??= { accountId: row.accountId, amountUsd: row.costUsd, at: row.at };
  }
  // Billing and this cursor were committed together. Replace an older session snapshot, including query resets.
  Object.assign(records.cursors, billing.checkpoints?.[request.agentId] ?? {});
  const runtime = request.runtimeSessionId;
  if (runtime && billing.cursors?.[runtime]) {
    const key = JSON.stringify([request.provider, runtime]);
    records.cursors[key] ??= billing.cursors[runtime].cumulativeUsd;
  }
  return { ...request, records };
}
