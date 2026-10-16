// Event-driven budget failover. Busy sessions keep their identity and move when they become quiet.
import fs from "node:fs";
import { accountSpend, readBilling } from "../../orca-organization/server/account-billing.mjs";
import {
  readAccounts,
  update,
  accountStatus,
  accountsDir,
} from "../../orca-organization/server/accounts.mjs";
import { takeOverSession } from "./session-takeover.mjs";
export function createAccountBudgets(control, root, { switchSession = takeOverSession } = {}) {
  let flight = null;
  let requested = false;
  async function checkOnce() {
    const pool = readAccounts(root);
    const events = readBilling(root).events;
    for (const account of pool.accounts) {
      const spend = accountSpend(root, account);
      if (!account.enabled || !spend) continue;
      const lowCredit = events.some(
        (e) => e.accountId === account.id && Date.parse(e.at) >= Date.parse(spend.startAt),
      );
      if (!lowCredit && !(spend.limitUsd && spend.usedUsd >= spend.limitUsd * 0.95)) continue;
      const key = `${account.id}:${spend.startAt}`;
      const target =
        account.name === "personal-workspace-api"
          ? pool.accounts.find(
              (a) =>
                a.name === "work-workspace-api" &&
                a.provider === "claude" &&
                accountStatus(a).state === "ok",
            )
          : null;
      if (!pool.budgetActions?.[key]) {
        await update(root, (s) => {
          s.budgetActions ??= {};
          if (s.budgetActions[key]) return;
          const sessions = target
            ? Object.entries(s.assignments)
                .filter(([, a]) => a.provider === "claude" && a.accountId !== target.id)
                .map(([id]) => id)
            : [];
          s.budgetActions[key] = {
            accountId: account.id,
            targetId: target?.id ?? null,
            pending: sessions,
            notified: false,
          };
          if (target) s.defaults.claude = target.id;
        });
      }
      if (target && !readAccounts(root).budgetActions[key].targetId) {
        await update(root, (s) => {
          const action = s.budgetActions[key];
          action.targetId = target.id;
          action.pending = Object.entries(s.assignments)
            .filter(([, a]) => a.provider === "claude" && a.accountId !== target.id)
            .map(([id]) => id);
          s.defaults.claude = target.id;
        });
      }
      const action = readAccounts(root).budgetActions[key];
      if (!action.notified && control.wakes?.accountBudget) {
        // The wake queue has its own durable idempotency key. A crash between enqueue and save is safe.
        const routed = control.wakes.accountBudget(key, {
          account: account.name,
          moved: target?.name ?? null,
          usedUsd: spend.usedUsd,
          limitUsd: spend.limitUsd,
        });
        if (routed > 0)
          await update(root, (s) => {
            s.budgetActions[key].notified = true;
          });
      }
      if (!action.targetId) continue;
      for (const id of action.pending) {
        const assignment = readAccounts(root).assignments[id];
        if (assignment?.takeover) continue;
        let done = assignment?.accountId === action.targetId;
        if (!done) {
          const result = await switchSession(id, action.targetId, {
            control,
            root,
            generation: control.store.get(id)?.generation,
            reason: "manual",
          });
          done = result?.ok === true;
        }
        if (done)
          await update(root, (s) => {
            s.budgetActions[key].pending = s.budgetActions[key].pending.filter((v) => v !== id);
          });
      }
    }
  }
  function check() {
    requested = true;
    if (flight) return flight;
    flight = (async () => {
      do {
        requested = false;
        await checkOnce();
      } while (requested);
    })().finally(() => {
      flight = null;
    });
    return flight;
  }
  let watcher;
  return {
    check,
    start() {
      fs.mkdirSync(accountsDir(root), { recursive: true, mode: 0o700 });
      watcher = fs.watch(accountsDir(root), (_event, name) => {
        if (name === null || ["billing.json", "accounts.json"].includes(String(name)))
          void check().catch((e) => {
            control.accountBudgetError = e.message;
          });
      });
      watcher.unref();
      return check();
    },
    close() {
      watcher?.close();
    },
  };
}
