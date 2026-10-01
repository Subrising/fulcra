import test from "node:test";
import assert from "node:assert/strict";
import { MANAGE_TASK_KEY, ORGANISATION_VIEWS, PILLARS, SETTINGS_VIEWS, readyPillars, tabTestId } from "./tabs";

test("the Command Centre tabs are in the agreed order, and only ready ones are shown", () => {
  assert.deepEqual(PILLARS.map(p => p.label), ["Today", "Organisation", "Inbox", "Changes", "Environments", "Sessions", "Trackers", "Settings"]);
  // J0-8: the Inbox is J3's and ready; Settings holds Devices and Channels. C1: Environments (J8) is ready too.
  // WL (worktree lifecycle, d6cd5164): Settings leads with the Clean-up view.
  assert.deepEqual(readyPillars().map(p => p.key), ["today", "organisation", "inbox", "changes", "environments", "sessions", "trackers", "settings"]);
  assert.deepEqual(SETTINGS_VIEWS.map(v => v.key), ["cleanup", "accounts", "devices", "channels"]);   // update-7: Accounts & Defaults
  assert.deepEqual(readyPillars([{ key: "inbox", label: "Inbox", ready: false, legacyKey: null }]), [], "an unfinished tab is hidden, not a placeholder");
});

test("every earlier tab id survives the regroup, and the new ones follow the same pattern", () => {
  const ids = [...PILLARS.flatMap(p => [p.key, p.legacyKey]), ...ORGANISATION_VIEWS.map(v => v.key), MANAGE_TASK_KEY, ...SETTINGS_VIEWS.map(v => v.key)].filter(Boolean).map(k => tabTestId(k!));
  // Earlier J0 ids, and J3's own tab ids (inbox, devices, channels), so J3's automation keeps working after the merge.
  for (const old of ["workmap", "leadership", "portfolio", "fleet", "task", "trackers", "inbox", "devices", "channels"]) assert.ok(ids.includes(`organization-tab-${old}`), old);
  for (const added of ["today", "organisation", "changes", "environments", "sessions", "settings"]) assert.ok(ids.includes(`organization-tab-${added}`), added);
  assert.equal(new Set(ids).size, ids.length, "no id is used twice");
});
