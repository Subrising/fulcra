import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readUsage } from "../../../../../control/orca-organization/server/accounts.mjs";
import type { AccountUsageRow } from "./account-usage-types.js";
import { createFulcraPoolRoster, writeUsageSnapshot } from "./fulcra-pool-roster.js";

const WORK = "11111111-1111-4111-8111-111111111111";
const OFF = "22222222-2222-4222-8222-222222222222";
const CODEX = "33333333-3333-4333-8333-333333333333";
const SIGNED_OUT = "44444444-4444-4444-8444-444444444444";
const TOKEN = "sk-ant-oat01-" + "w".repeat(60);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(accounts: unknown[]) {
  const root = mkdtempSync(path.join(tmpdir(), "u7c-roster-"));
  dirs.push(root);
  mkdirSync(path.join(root, "accounts", "codex", CODEX), { recursive: true });
  writeFileSync(path.join(root, "accounts", "codex", CODEX, "auth.json"), "{}");
  writeFileSync(path.join(root, "accounts", "accounts.json"), JSON.stringify({ v: 1, accounts }));
  return root;
}
const acct = (id: string, provider: string, name: string, extra: object = {}) => ({
  id,
  provider,
  name,
  enabled: true,
  priority: 1,
  auth: "ok",
  limitedUntil: null,
  ...extra,
});

describe("Fulcra pool roster", () => {
  it("lists enabled Claude accounts with their Keychain token and Codex accounts with their CODEX_HOME", async () => {
    const root = home([
      acct(WORK, "claude", "Work"),
      acct(CODEX, "codex", "Codex A"),
      acct(OFF, "claude", "Off", { enabled: false }),
    ]);
    const roster = createFulcraPoolRoster({
      root,
      readToken: async (id) => (id === WORK ? TOKEN : null),
    });
    const list = await roster.list();
    expect(list.map((a) => [a.name, a.provider])).toEqual([
      ["Work", "claude"],
      ["Codex A", "codex"],
      ["Off", "claude"],
    ]);
    expect(list[0].credential).toEqual({ kind: "token", token: TOKEN });
    expect(list[1].credential).toEqual({
      kind: "codexHome",
      home: path.join(root, "accounts", "codex", CODEX),
    });
  });

  it("carries the pool's own limited-until hold", async () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    const root = home([acct(WORK, "claude", "Work", { limitedUntil: until })]);
    const [a] = await createFulcraPoolRoster({ root, readToken: async () => TOKEN }).list();
    expect(a.poolLimitedUntilMs).toBe(Date.parse(until));
  });

  it("keeps unreadable accounts visible with unavailable credentials", async () => {
    const root = home([acct(WORK, "claude", "Work"), acct(SIGNED_OUT, "codex", "Not signed in")]);
    const list = await createFulcraPoolRoster({ root, readToken: async () => null }).list();
    expect(list.map((a) => a.credential)).toEqual([
      { kind: "unavailable" },
      { kind: "unavailable" },
    ]);
  });

  it("returns an empty roster when the store is absent or unreadable, without throwing", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "u7c-roster-"));
    dirs.push(empty);
    expect(
      await createFulcraPoolRoster({ root: empty, readToken: async () => TOKEN }).list(),
    ).toEqual([]);
    mkdirSync(path.join(empty, "accounts"));
    writeFileSync(path.join(empty, "accounts", "accounts.json"), "{not json");
    expect(
      await createFulcraPoolRoster({ root: empty, readToken: async () => TOKEN }).list(),
    ).toEqual([]);
  });
});

describe("Fulcra pool usage snapshot", () => {
  const row = (accountId: string | null, weekly: AccountUsageRow["weekly"]): AccountUsageRow => ({
    accountId,
    name: "Work",
    provider: "claude",
    status: "ok",
    observedAt: "2026-10-09T00:00:00.000Z",
    source: null,
    fiveHour: { usedPct: 12, resetsAt: null },
    weekly,
    inUse: false,
  });
  const resetsAt = new Date(Date.now() + 86_400_000).toISOString();

  it("writes each account's weekly use, which the pool reads back, and nothing else", () => {
    const root = home([acct(WORK, "claude", "Work")]);
    const rows = [
      row(WORK, { usedPct: 91.5, resetsAt }),
      row(OFF, null),
      row(null, { usedPct: 50, resetsAt }),
      row("../not-an-id", { usedPct: 50, resetsAt }),
    ];
    expect(writeUsageSnapshot(root, rows)).toBe(true);
    const file = path.join(root, "accounts", "usage.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      v: 1,
      accounts: { [WORK]: { provider: "claude", weeklyUsedPct: 91.5, weeklyResetsAt: resetsAt } },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readUsage(root)).toEqual({ [WORK]: 91.5 });
    expect(writeUsageSnapshot(root, rows)).toBe(false); // unchanged figures: no write
  });

  it("writes nothing when this computer has no account pool", () => {
    const root = mkdtempSync(path.join(tmpdir(), "u7c-roster-"));
    dirs.push(root);
    expect(writeUsageSnapshot(root, [row(WORK, { usedPct: 10, resetsAt })])).toBe(false);
    expect(existsSync(path.join(root, "accounts"))).toBe(false);
  });
});
