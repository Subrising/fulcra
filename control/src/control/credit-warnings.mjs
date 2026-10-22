// Billing observations notify owners. They never block, switch or stop a session.
import fs from "node:fs";
import path from "node:path";
import {
  accountsDir,
  readAccounts,
  pendingRiskNotices,
  markRiskNoticeSent,
} from "../../orca-organization/server/accounts.mjs";
import {
  pendingBillingWarnings,
  markBillingWarningSent,
  recoverAccountObservations,
} from "../../orca-organization/server/account-billing.mjs";
export function createCreditWarnings(control, root) {
  let flight;
  let dirty = false;
  async function checkOnce() {
    await recoverAccountObservations(root);
    const pool = readAccounts(root);
    // FU-443: RISK notices the pool wrote (a paid account served while a subscription was free) go to Main once.
    for (const notice of pendingRiskNotices(pool))
      if (control.wakes?.accountRisk?.(notice)) await markRiskNoticeSent(root, notice.key);
    for (const event of pendingBillingWarnings(root)) {
      const account = pool.accounts.find((row) => row.id === event.accountId);
      const sessions = event.sessionId ? [event.sessionId] : [];
      const raw = String(account?.name ?? "API account");
      const name =
        /sk-ant-|\bsk-[A-Za-z0-9_-]{16,}|\bgh[opsu]_|github_pat_|\bxox[abp]-|\beyJ[A-Za-z0-9_-]{8,}\.|auth\.json|access_token|refresh_token|[A-Za-z0-9+/_-]{40,}/i.test(
          raw,
        )
          ? "API account"
          : raw.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 60);
      const notices = control.wakes?.apiCreditLow(
        event.id,
        { account: name, accountId: event.accountId, sessions },
        event.notices,
      );
      if (notices && Object.keys(notices).some((role) => notices[role] !== event.notices?.[role]))
        await markBillingWarningSent(root, event.id, notices);
    }
  }
  function check() {
    dirty = true;
    if (flight) return flight;
    flight = (async () => {
      do {
        dirty = false;
        await checkOnce();
      } while (dirty);
    })().finally(() => {
      flight = null;
    });
    return flight;
  }
  let watcher,
    signature = "";
  function observed() {
    try {
      const stat = fs.statSync(path.join(accountsDir(root), "billing.json"));
      return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }
  return {
    check,
    start() {
      fs.mkdirSync(accountsDir(root), { recursive: true, mode: 0o700 });
      watcher = fs.watch(accountsDir(root), () => {
        try {
          const next = observed();
          if (next === signature) return;
          signature = next;
          void check().catch((error) => {
            control.creditWarningError = error.message;
          });
        } catch (error) {
          control.creditWarningError = error.message;
        }
      });
      watcher.unref();
      return check().catch((error) => {
        control.creditWarningError = error.message;
      });
    },
    close() {
      watcher?.close();
    },
  };
}
