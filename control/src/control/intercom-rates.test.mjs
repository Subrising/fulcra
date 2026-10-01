import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlStore } from "./store.mjs";
import { IntercomRates, RATE_WINDOW_MS } from "./intercom-rates.mjs";
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-rates-"));
  const store = new ControlStore(path.join(home, "private.sqlite"));
  let time = RATE_WINDOW_MS;
  const rates = new IntercomRates(store, () => time);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    rates,
    store,
    setTime: (value) => {
      time = value;
    },
  };
}
test("rates: rollover persists ids and never renews authority", (t) => {
  const f = fixture(t);
  let authorised = true;
  const check = () => {
    if (!authorised) throw Error("revoked");
  };
  f.rates.set({ kind: "followup", max: 1 }, check);
  f.rates.spend("followup", "worker", "one", { text: "one" }, check);
  assert.throws(
    () => f.rates.spend("followup", "worker", "two", { text: "two" }, check),
    /rolling rate/,
  );
  f.setTime(2 * RATE_WINDOW_MS);
  assert.equal(f.rates.spend("followup", "worker", "two", { text: "two" }, check).used, 1);
  assert.equal(f.rates.spend("followup", "worker", "one", { text: "one" }, check).duplicate, true);
  authorised = false;
  assert.throws(
    () => f.rates.spend("followup", "worker", "one", { text: "one" }, check),
    /revoked/,
  );
});
test("rates: Settings are finite and require a fresh owner check at commit", (t) => {
  const f = fixture(t);
  for (const max of [-1, 65, Infinity, null])
    assert.throws(() => f.rates.set({ kind: "followup", max }, () => {}), /Finite owner/);
  assert.throws(() => f.rates.set({ kind: "seat", max: 33 }, () => {}), /Finite owner/);
  assert.throws(() => f.rates.set({ kind: "channel", max: 20 }, true), /Finite owner/);
  let checks = 0;
  assert.throws(
    () =>
      f.rates.set({ kind: "channel", max: 20 }, () => {
        if (++checks === 2) throw Error("owner revoked");
      }),
    /owner revoked/,
  );
  assert.equal(f.rates.setting("channel").max, 8);
  assert.equal(f.rates.set({ kind: "channel", max: 20 }, () => {}).max, 20);
});
test("rates: restart and rollback retain accounting and immutable-body conflicts", (t) => {
  const f = fixture(t);
  f.rates.spend("channel", "pair", "id", { text: "body", generation: 2 }, () => {});
  const restarted = new IntercomRates(f.store, () => RATE_WINDOW_MS);
  assert.equal(
    restarted.spend("channel", "pair", "id", { text: "body", generation: 2 }, () => {}).duplicate,
    true,
  );
  assert.throws(
    () => restarted.spend("channel", "pair", "id", { text: "altered", generation: 2 }, () => {}),
    /identity conflict/,
  );
  f.setTime(RATE_WINDOW_MS - 1);
  assert.throws(() => f.rates.spend("channel", "pair", "new", {}, () => {}), /clock rollback/);
});
test("rates: lowering owner setting constrains the next durable spend", (t) => {
  const f = fixture(t);
  f.rates.spend("seat", "seat", "start", {}, () => {});
  f.rates.set({ kind: "seat", max: 0 }, () => {});
  assert.throws(() => f.rates.spend("seat", "seat", "second", {}, () => {}), /rolling rate/);
  assert.equal(f.rates.spend("seat", "seat", "start", {}, () => {}).duplicate, true);
});

test("owner native Settings projection lowers a held permit immediately and removal/restart cannot raise it", (t) => {
  const f = fixture(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-owner-rate-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settingsFile = path.join(home, "settings.json");
  const publish = (followup) =>
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        version: 1,
        settings: { report: 12, followup, channel: 8, seat: 8 },
        entries: [],
      }),
      { mode: 0o600 },
    );
  publish(2);
  const rates = new IntercomRates(f.store, () => RATE_WINDOW_MS, settingsFile);
  assert.equal(rates.setting("followup").max, 2);
  rates.spend("followup", "worker", "first", { text: "one" }, () => {});
  rates.spend("followup", "worker", "second", { text: "two" }, () => {});
  rates.requirePermit("followup", "worker", "second");
  publish(1);
  assert.throws(() => rates.requirePermit("followup", "worker", "second"), /lowered/);
  fs.unlinkSync(settingsFile);
  const restarted = new IntercomRates(f.store, () => RATE_WINDOW_MS, settingsFile);
  assert.throws(() => restarted.setting("followup"), /disappeared/);
  assert.throws(() => restarted.requirePermit("followup", "worker", "second"), /disappeared/);
  publish(65);
  assert.throws(() => restarted.setting("followup"), /bounds/);
});

test("finite per-window permit expires at rollover and attempted ID never obtains a new permit", (t) => {
  const f = fixture(t);
  f.rates.spend("channel", "scope", "one", {}, () => {});
  f.rates.requirePermit("channel", "scope", "one");
  f.setTime(2 * RATE_WINDOW_MS);
  assert.equal(f.rates.spend("channel", "scope", "one", {}, () => {}).duplicate, true);
  assert.throws(() => f.rates.requirePermit("channel", "scope", "one"), /expired/);
  f.rates.spend("channel", "scope", "new", {}, () => {});
  f.rates.requirePermit("channel", "scope", "new");
});
