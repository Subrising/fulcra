import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCreditWarnings } from "./credit-warnings.mjs";
import {
  addAccount,
  update,
  pendingRiskNotices,
} from "../../orca-organization/server/accounts.mjs";

async function poolWithNotice(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "credit-warnings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = await addAccount(root, { provider: "claude", name: "Billing" });
  await update(root, (s) => {
    s.riskNotices = [
      {
        key: `${api.id}:1`,
        accountId: api.id,
        account: "Billing",
        sent: false,
      },
    ];
    return null;
  });
  return { root, api };
}

test("check delivers a paid-while-free notice once and marks it sent", async (t) => {
  const { root, api } = await poolWithNotice(t);
  const calls = [];
  const control = {
    wakes: {
      accountPaidWhileFree: (key, payload) => (calls.push({ key, payload }), true),
    },
  };
  await createCreditWarnings(control, root).check();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.account, "Billing");
  assert.equal(calls[0].payload.accountId, api.id);
  assert.equal(pendingRiskNotices(root).length, 0);
  await createCreditWarnings(control, root).check();
  assert.equal(calls.length, 1, "a sent notice is not repeated");
});

test("an unsent notice stays pending when the wake is refused or the call is absent", async (t) => {
  const { root } = await poolWithNotice(t);
  await createCreditWarnings({ wakes: { accountPaidWhileFree: () => false } }, root).check();
  assert.equal(pendingRiskNotices(root).length, 1);
  await createCreditWarnings({ wakes: {} }, root).check();
  assert.equal(pendingRiskNotices(root).length, 1, "optional call: no throw when missing");
});
