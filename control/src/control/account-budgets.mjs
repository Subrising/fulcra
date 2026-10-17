// Automatic API failover uses delegation fences. Refusals need the session's own idle event and a backoff.
import fs from "node:fs";
import path from "node:path";
import {
  accountSpend,
  dailySpend,
  readBilling,
} from "../../orca-organization/server/account-billing.mjs";
import {
  readAccounts,
  update,
  accountStatus,
  accountsDir,
  isApiAccount,
} from "../../orca-organization/server/accounts.mjs";
import { takeOverSession } from "./session-takeover.mjs";
export const BUDGET_RETRY_MS = 60_000;
export const MAX_BUDGET_REFUSALS = 3;
const quiet = (event) => event && ["idle", "closed", "error"].includes(event.status);
const candidates = (pool, accountId) =>
  Object.entries(pool.assignments)
    .filter(([, a]) => a.provider === "claude" && a.accountId === accountId && !a.ended)
    .map(([id]) => id);
export function createAccountBudgets(
  control,
  root,
  { switchSession = takeOverSession, now = Date.now } = {},
) {
  let flight = null;
  let requested = false;
  const events = new Map();
  async function finish(key, id, reason) {
    await update(root, (s) => {
      const action = s.budgetActions[key];
      action.pending = action.pending.filter((v) => v !== id);
      action.skipped ??= {};
      action.skipped[id] ??= reason;
    });
  }
  async function attempt(key, id, idleEvents) {
    const pool = readAccounts(root),
      action = pool.budgetActions[key];
    const assignment = pool.assignments[id];
    if (!assignment || assignment.ended || assignment.accountId !== action.accountId)
      return finish(key, id, "source-changed");
    if (control.store.get(id)?.mode !== "delegated") return finish(key, id, "owner-controlled");
    if (control.native?.route?.(id)) return finish(key, id, "remote-host");
    if (assignment.takeover) return finish(key, id, "reconciliation-required");
    const prior = action.refusals?.[id];
    if (prior && (!idleEvents.has(id) || now() < prior.nextAt)) return;
    try {
      await control.native.snapshot(id);
    } catch {
      return finish(key, id, "session-unavailable");
    }
    let result;
    try {
      result = await switchSession(
        id,
        { id: action.targetId, fromAccountId: action.accountId },
        {
          control,
          root,
          generation: control.store.get(id)?.generation,
          reason: "budget",
          now,
        },
      );
    } catch {
      return finish(key, id, "reconciliation-required");
    }
    if (result?.ok) return finish(key, id, "moved");
    if (control.store.get(id)?.mode !== "delegated") return finish(key, id, "owner-controlled");
    if (result?.outcome === "uncertain") return finish(key, id, "reconciliation-required");
    await update(root, (s) => {
      const live = s.budgetActions[key];
      live.refusals ??= {};
      const attempts = (live.refusals[id]?.attempts ?? 0) + 1;
      live.refusals[id] = {
        attempts,
        at: new Date(now()).toISOString(),
        nextAt: now() + BUDGET_RETRY_MS,
      };
      if (attempts >= MAX_BUDGET_REFUSALS) {
        live.pending = live.pending.filter((v) => v !== id);
        live.skipped ??= {};
        live.skipped[id] = "refused";
      }
    });
  }
  async function notice(key, account, spend, target) {
    const action = readAccounts(root).budgetActions[key];
    const reasons = Object.values(action.skipped ?? {});
    const held = reasons.filter((r) => r === "owner-controlled").length;
    const failed = reasons.filter(
      (r) => !["moved", "source-changed", "owner-controlled"].includes(r),
    ).length;
    const noticeKey = !action.notified
      ? key
      : failed && !action.refusalNotified
        ? `${key}:refused`
        : held && !action.heldNotified
          ? `${key}:held`
          : null;
    if (!noticeKey || !control.wakes?.accountBudget) return;
    const routed = control.wakes.accountBudget(noticeKey, {
      account: account.name,
      moved: target?.name ?? null,
      usedUsd: spend.usedUsd,
      limitUsd: spend.limitUsd,
      held,
      failed,
    });
    if (routed > 0)
      await update(root, (s) => {
        s.budgetActions[key].notified = true;
        if (failed) s.budgetActions[key].refusalNotified = true;
        if (held) s.budgetActions[key].heldNotified = true;
      });
  }
  async function checkOnce(idleEvents) {
    const pool = readAccounts(root),
      billing = readBilling(root);
    for (const account of pool.accounts) {
      const spend = accountSpend(root, account, billing);
      if (!account.enabled || !spend) continue;
      for (const [scope, period] of [
        ["account", spend],
        ["daily UTC", dailySpend(root, account, billing, now())],
      ]) {
        if (!period?.limitUsd) continue;
        for (const threshold of [0.5, 0.8, 1]) {
          if (period.usedUsd < period.limitUsd * threshold) continue;
          const noticeKey = `spend:${account.id}:${scope}:${period.startAt}:${period.limitUsd}:${threshold}`;
          if (pool.budgetNotices?.[noticeKey]) continue;
          const routed = control.wakes?.accountBudget?.(noticeKey, {
            account: account.name,
            accountId: account.id,
            scope,
            threshold,
            sessions: candidates(pool, account.id),
            usedUsd: period.usedUsd,
            limitUsd: period.limitUsd,
          });
          if (routed > 0)
            await update(root, (s) => {
              s.budgetNotices ??= {};
              s.budgetNotices[noticeKey] = new Date(now()).toISOString();
            });
        }
      }
      const lowCredit = billing.events.some(
        (e) => e.accountId === account.id && Date.parse(e.at) >= Date.parse(spend.startAt),
      );
      if (!lowCredit && !(spend.limitUsd && spend.usedUsd >= spend.limitUsd * 0.95)) continue;
      const key = `${account.id}:${spend.startAt}`;
      const target =
        account.name === "personal-workspace-api"
          ? pool.accounts.find(
              (a) =>
                a.name === "work-workspace-api" &&
                isApiAccount(a) &&
                accountStatus(a, now()).state === "ok",
            )
          : null;
      await update(root, (s) => {
        s.budgetActions ??= {};
        const action = (s.budgetActions[key] ??= {
          accountId: account.id,
          targetId: null,
          pending: [],
          notified: false,
        });
        if (target && !action.targetId) {
          action.targetId = target.id;
          action.pending = candidates(s, account.id);
          if (s.defaults.claude === account.id) s.defaults.claude = target.id;
        }
        // Sanitize pending lists produced by an earlier version as well.
        action.pending = action.pending.filter((id) => candidates(s, account.id).includes(id));
      });
      const action = readAccounts(root).budgetActions[key];
      if (action.targetId && target?.id === action.targetId)
        for (const id of action.pending) await attempt(key, id, idleEvents);
      await notice(key, account, spend, target);
    }
  }
  function check(event) {
    if (quiet(event)) events.set(event.id, event);
    requested = true;
    if (flight) return flight;
    flight = (async () => {
      do {
        requested = false;
        const idleEvents = new Map(events);
        events.clear();
        await checkOnce(idleEvents);
      } while (requested);
    })().finally(() => {
      flight = null;
    });
    return flight;
  }
  let watcher,
    signature = "";
  const billingSignature = () => {
    try {
      const s = fs.statSync(path.join(accountsDir(root), "billing.json"));
      return `${s.ino}:${s.mtimeMs}:${s.size}`;
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  };
  return {
    check,
    start() {
      fs.mkdirSync(accountsDir(root), { recursive: true, mode: 0o700 });
      watcher = fs.watch(accountsDir(root), () => {
        try {
          const next = billingSignature();
          if (signature === next) return;
          signature = next;
          void check().catch((e) => {
            control.accountBudgetError = e.message;
          });
        } catch (e) {
          control.accountBudgetError = e.message;
        }
      });
      watcher.unref();
      return check();
    },
    close() {
      watcher?.close();
    },
  };
}
