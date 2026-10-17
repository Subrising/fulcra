// Durable, secret-free API accounting. IDs belong to the producing call/turn, never the current assignment.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isApiAccount, accountsDir, withStoreLock, readAccountsAsync } from "./accounts.mjs";
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
  const starts = pool.accounts.filter(isApiAccount).map((account) => Date.parse(account.createdAt));
  const oldest = Math.min(...starts, Date.parse(new Date().toISOString().slice(0, 10)));
  for (const [id, call] of Object.entries(state.calls))
    if (Date.parse(call.at) < oldest) {
      const sessionId = call.sessionId ?? /^turn:([a-f0-9-]{36}):/.exec(id)?.[1];
      // Retain unmigrated live history until the session has a durable cost checkpoint.
      const liveLegacy =
        sessionId &&
        pool.assignments[sessionId] &&
        !pool.assignments[sessionId].ended &&
        state.checkpointRevisions?.[sessionId] === undefined;
      if (!liveLegacy) delete state.calls[id];
    }
  const sessions = new Set(
    Object.values(state.calls)
      .map((call) => call.sessionId)
      .filter(Boolean),
  );
  for (const [id, assignment] of Object.entries(pool.assignments))
    if (!assignment.ended) sessions.add(id);
  for (const id of Object.keys(state.checkpoints ?? {}))
    if (!sessions.has(id)) {
      delete state.checkpoints[id];
      if (state.checkpointRevisions) delete state.checkpointRevisions[id];
    }
  state.retainedFrom = new Date(oldest).toISOString();
}
export function accountSpend(root, account, billing = readBilling(root)) {
  if (!isApiAccount(account)) return null;
  const startAt = account.topUpAt ?? account.createdAt;
  const start = Date.parse(startAt);
  const usedUsd = Object.values(billing.calls).reduce(
    (sum, call) =>
      call.accountId === account.id && Date.parse(call.at) >= start ? sum + call.costUsd : sum,
    0,
  );
  return { startAt, usedUsd };
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
    costRevision = null,
  },
) {
  if (
    !uuid(accountId) ||
    typeof id !== "string" ||
    !id ||
    id.length > 512 ||
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
    if (
      uuid(sessionId) &&
      cursorCheckpoint !== null &&
      (costRevision === null || costRevision >= (state.checkpointRevisions?.[sessionId] ?? 0))
    ) {
      if (
        typeof cursorCheckpoint !== "object" ||
        Array.isArray(cursorCheckpoint) ||
        !Object.values(cursorCheckpoint).every((value) => Number.isFinite(value) && value >= 0)
      )
        throw Error("Invalid session cost cursor checkpoint");
      state.checkpoints ??= {};
      state.checkpoints[sessionId] = { ...cursorCheckpoint };
      if (Number.isSafeInteger(costRevision) && costRevision >= 0) {
        state.checkpointRevisions ??= {};
        state.checkpointRevisions[sessionId] = costRevision;
      }
    }
    compact(state, await readAccountsAsync(root));
    await save(root, state);
    return true;
  });
}
function billingEvents(state) {
  const events = [];
  for (const event of state.events) {
    if (!event.id) {
      if (events.some((row) => row.accountId === event.accountId && !row.clearedAt)) continue;
      event.id = `${event.accountId}:${event.at}`;
    }
    events.push(event);
  }
  state.events = events;
  return events;
}
// Equal timestamps use the host's monotonic observation order when both sources supply it.
const after = (leftAt, leftOrder, rightAt, rightOrder) =>
  Date.parse(leftAt) > Date.parse(rightAt) ||
  (Date.parse(leftAt) === Date.parse(rightAt) &&
    leftOrder &&
    rightOrder &&
    BigInt(leftOrder) > BigInt(rightOrder));
export async function recordBillingError(
  root,
  accountId,
  at = new Date().toISOString(),
  type = "ask.billing_error",
  sessionId = null,
  sourceId = null,
  sourceOrder = null,
) {
  if (!uuid(accountId) || !Number.isFinite(Date.parse(at))) return false;
  if (!["ask.billing_error", "session.billing_error"].includes(type)) return false;
  return withStoreLock(root, async () => {
    const pool = await readAccountsAsync(root);
    if (!isApiAccount(pool.accounts.find((a) => a.id === accountId))) return false;
    const state = readBilling(root),
      events = billingEvents(state);
    const successAt = state.lastSuccess?.[accountId];
    const successOrder = state.lastSuccessOrder?.[accountId];
    if (
      successAt &&
      (Date.parse(at) < Date.parse(successAt) ||
        (Date.parse(at) === Date.parse(successAt) &&
          sourceOrder &&
          successOrder &&
          BigInt(sourceOrder) < BigInt(successOrder)))
    )
      return false;
    if (sourceId && state.observations?.[sourceId]) return false;
    if (sourceId) {
      state.observations ??= {};
      state.observations[sourceId] = at;
    }
    const previous = events.findLast((event) => event.accountId === accountId && !event.clearedAt);
    const failure = {
      at,
      type,
      ...(uuid(sessionId) ? { sessionId } : {}),
      ...(sourceOrder ? { order: sourceOrder } : {}),
    };
    if (previous && !previous.clearedAt) {
      previous.failures ??= [
        {
          at: previous.at,
          type: previous.type,
          ...(previous.sessionId ? { sessionId: previous.sessionId } : {}),
        },
      ];
      previous.failures.push(failure);
      if (Date.parse(at) < Date.parse(previous.at)) previous.at = at;
      await save(root, state);
      return false;
    }
    events.push({
      id: randomUUID(),
      type,
      accountId,
      at,
      ...(uuid(sessionId) ? { sessionId } : {}),
      failures: [failure],
    });
    await save(root, state);
    return true;
  });
}
export async function recordBillingSuccess(
  root,
  accountId,
  at = new Date().toISOString(),
  sourceId = null,
  sourceOrder = null,
) {
  if (!uuid(accountId) || !Number.isFinite(Date.parse(at))) return false;
  return withStoreLock(root, async () => {
    const state = readBilling(root);
    if (sourceId && state.observations?.[sourceId]) return false;
    if (sourceId) {
      state.observations ??= {};
      state.observations[sourceId] = at;
    }
    state.lastSuccess ??= {};
    let changed =
      !state.lastSuccess[accountId] ||
      after(at, sourceOrder, state.lastSuccess[accountId], state.lastSuccessOrder?.[accountId]);
    if (changed) {
      state.lastSuccess[accountId] = at;
      state.lastSuccessOrder ??= {};
      if (sourceOrder) state.lastSuccessOrder[accountId] = sourceOrder;
      else delete state.lastSuccessOrder[accountId];
    }
    for (const event of [...billingEvents(state)])
      if (
        event.accountId === accountId &&
        (!event.clearedAt || after(event.clearedAt, event.clearedOrder, at, sourceOrder)) &&
        Date.parse(event.at) <= Date.parse(at)
      ) {
        const failures = event.failures ?? [
          {
            at: event.at,
            type: event.type,
            ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          },
        ];
        const later = failures.filter((failure) =>
          after(failure.at, failure.order, at, sourceOrder),
        );
        if (later.length === failures.length) continue;
        const laterClear = event.clearedAt;
        const laterClearOrder = event.clearedOrder;
        event.clearedAt = at;
        if (sourceOrder) event.clearedOrder = sourceOrder;
        else delete event.clearedOrder;
        event.failures = failures.filter((failure) => !later.includes(failure));
        if (later.length) {
          later.sort((a, b) => (after(a.at, a.order, b.at, b.order) ? 1 : -1));
          const first = later[0];
          state.events.push({
            id: randomUUID(),
            accountId,
            at: first.at,
            type: first.type,
            ...(first.sessionId ? { sessionId: first.sessionId } : {}),
            failures: later,
            ...(laterClear
              ? {
                  clearedAt: laterClear,
                  ...(laterClearOrder ? { clearedOrder: laterClearOrder } : {}),
                }
              : {}),
          });
        }
        changed = true;
      }
    if (changed || sourceId) await save(root, state);
    return changed;
  });
}
export async function markBillingWarningSent(root, eventId, notices) {
  return withStoreLock(root, async () => {
    const state = readBilling(root);
    const event = billingEvents(state).find((row) => row.id === eventId);
    if (!event || event.notified) return;
    event.notices = { ...event.notices, ...notices };
    event.notified = Boolean(event.notices.main && (!event.sessionId || event.notices.owner));
    await save(root, state);
  });
}
export function pendingBillingWarnings(root) {
  return billingEvents(readBilling(root)).filter((event) => !event.notified);
}
export function isBillingError(value) {
  if (value && typeof value === "object") {
    if (
      [value.api_error_status, value.status, value.statusCode, value.code].some(
        (code) => String(code) === "402",
      )
    )
      return true;
    return [value.message, value.result, value.code, value.type, value.error].some(
      (part) => part && part !== value && isBillingError(part),
    );
  }
  return /credit balance (?:is )?too low|insufficient (?:credit|balance)|billing_error|payment required|(?:HTTP|status(?: code)?|API error)\s*[:=]?\s*402\b|^402\b|(?:HTTP|status(?: code)?)\s*[:=]?\s*(?:400|402)\b.*billing|billing.*(?:400|402)\b/i.test(
    String(value ?? ""),
  );
}

export function readSessionBilling(root, request) {
  if (request.provider !== "claude") return;
  const billing = readBilling(root);
  const records = structuredClone(request.records ?? { cursors: {}, turns: {} });
  const prefix = `turn:${request.agentId}:`;
  const savedRevision = records.revision ?? Object.keys(records.turns).length;
  let imported = false;
  for (const [id, row] of Object.entries(billing.calls)) {
    if (!id.startsWith(prefix)) continue;
    const turnId = id.slice(prefix.length);
    if (!Object.hasOwn(records.turns, turnId)) {
      imported = true;
      records.turns[turnId] = { accountId: row.accountId, amountUsd: row.costUsd, at: row.at };
    }
  }
  // Billing and this cursor were committed together. Replace an older session snapshot, including query resets.
  const committedRevision = billing.checkpointRevisions?.[request.agentId];
  const newer =
    committedRevision !== undefined
      ? committedRevision > savedRevision
      : imported && records.revision === undefined;
  if (newer) {
    Object.assign(records.cursors, billing.checkpoints?.[request.agentId] ?? {});
    records.revision = committedRevision ?? Object.keys(records.turns).length;
  }
  const runtime = request.runtimeSessionId;
  if (runtime && billing.cursors?.[runtime]) {
    const key = JSON.stringify([request.provider, runtime]);
    records.cursors[key] ??= billing.cursors[runtime].cumulativeUsd;
  }
  return { ...request, records };
}

export async function recordAccountTurnEnd(
  root,
  event,
  at = event.observedAt ?? new Date().toISOString(),
) {
  const { accountId, provider, id } = event.agent;
  if (provider !== "claude" || !accountId) return false;
  const sourceId = event.observationId ? `turn:${id}:${event.observationId}` : null;
  if (event.outcome.kind === "failed" && isBillingError(event.outcome.error))
    return recordBillingError(
      root,
      accountId,
      at,
      "session.billing_error",
      id,
      sourceId,
      event.observedOrder,
    );
  if (event.outcome.kind === "completed")
    return recordBillingSuccess(root, accountId, at, sourceId, event.observedOrder);
  return false;
}

// A one-shot result must survive accounting faults. Keep its secret-free observation for a later retry.
export async function observeAccountCall(root, observation) {
  const dir = path.join(accountsDir(root), "pending-observations");
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(
      path.join(dir, `${observation.id}.json`),
      JSON.stringify({ ...observation, order: process.hrtime.bigint().toString() }),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    await recoverAccountObservations(root);
    return true;
  } catch {
    return false;
  }
}
export async function recoverAccountObservations(root) {
  const dir = path.join(accountsDir(root), "pending-observations");
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const pending = [];
  for (const file of files) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    try {
      pending.push({
        file,
        observation: JSON.parse(await fsp.readFile(path.join(dir, file), "utf8")),
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  pending.sort((a, b) =>
    after(a.observation.at, a.observation.order, b.observation.at, b.observation.order) ? 1 : -1,
  );
  for (const { file, observation } of pending) {
    const { id, accountId, at, costUsd, sessionId, failed } = observation;
    if (Number.isFinite(costUsd) && costUsd >= 0)
      await recordAccountCost(root, { id: `ask:${id}`, accountId, at, costUsd });
    if (failed === true)
      await recordBillingError(
        root,
        accountId,
        at,
        "ask.billing_error",
        sessionId,
        id,
        observation.order,
      );
    else if (failed === false)
      await recordBillingSuccess(root, accountId, at, id, observation.order);
    await fsp.rm(path.join(dir, file), { force: true });
  }
}
