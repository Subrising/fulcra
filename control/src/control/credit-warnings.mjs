// Billing observations notify owners. They never block, switch or stop a session.
import fs from "node:fs";
import path from "node:path";
import { accountsDir, readAccounts } from "../../orca-organization/server/accounts.mjs";
import {
  pendingBillingWarnings,
  markBillingWarningSent,
  recoverAccountObservations,
} from "../../orca-organization/server/account-billing.mjs";
import {
  pendingRiskNotices,
  markRiskNoticeSent,
} from "../../orca-organization/server/accounts.mjs";
function safeName(value) {
  const raw = String(value ?? "API account");
  return /sk-ant-|\bsk-[A-Za-z0-9_-]{16,}|\bgh[opsu]_|github_pat_|\bxox[abp]-|\beyJ[A-Za-z0-9_-]{8,}\.|auth\.json|access_token|refresh_token|[A-Za-z0-9+/_-]{40,}/i.test(
    raw,
  )
    ? "API account"
    : raw.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 60);
}
export function createCreditWarnings(control, root) {
  let flight;
  let dirty = false;
  async function checkOnce() {
    await recoverAccountObservations(root);
    const pool = readAccounts(root);
    for (const event of pendingBillingWarnings(root)) {
      const account = pool.accounts.find((row) => row.id === event.accountId);
      const sessions = event.sessionId ? [event.sessionId] : [];
      const name = safeName(account?.name);
      const notices = control.wakes?.apiCreditLow(
        event.id,
        { account: name, accountId: event.accountId, sessions },
        event.notices,
      );
      if (notices && Object.keys(notices).some((role) => notices[role] !== event.notices?.[role]))
        await markBillingWarningSent(root, event.id, notices);
    }
  }
  // FU-443: paid-while-free notices the pool recorded; one per account and window.
  async function riskOnce() {
    for (const n of pendingRiskNotices(root))
      if (
        control.wakes?.accountPaidWhileFree?.(n.key, {
          account: safeName(n.account),
          accountId: n.accountId,
        })
      )
        await markRiskNoticeSent(root, n.key);
  }
  function check() {
    dirty = true;
    if (flight) return flight;
    flight = (async () => {
      do {
        dirty = false;
        // A failed billing pass must not hide the paid-while-free notices; report the first error afterwards.
        let failure;
        try {
          await checkOnce();
        } catch (error) {
          failure = error;
        }
        await riskOnce();
        if (failure) throw failure;
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
      return ["billing.json", "accounts.json"]
        .map((file) => {
          try {
            const stat = fs.statSync(path.join(accountsDir(root), file));
            return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
          } catch (error) {
            if (error.code === "ENOENT") return "";
            throw error;
          }
        })
        .join("|");
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
