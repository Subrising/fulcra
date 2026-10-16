import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "../../server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../../server/test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../../server/test-utils/fake-agent-client.js";
import { BuiltinPluginLoader } from "../../server/plugins/builtin/index.js";
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
import { createPoolUsage } from "../../../../../control/orca-organization/server/pool-usage.js";
import { UsageSourceRegistry } from "../../server/plugins/usage-sources/index.js";
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

  it("writes pool admission and native usage snapshots without credentials", () => {
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
    const reportsFile = path.join(root, "accounts", "usage-reports.json");
    expect(statSync(reportsFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(reportsFile, "utf8")).reports).toEqual([
      {
        accountId: WORK,
        provider: "claude",
        status: "ok",
        observedAt: rows[0].observedAt,
        fiveHour: rows[0].fiveHour,
        weekly: rows[0].weekly,
      },
      {
        accountId: OFF,
        provider: "claude",
        status: "ok",
        observedAt: rows[1].observedAt,
        fiveHour: rows[1].fiveHour,
        weekly: null,
      },
    ]);
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

describe("native pool usage source", () => {
  it("maps one session to its account and keeps unavailable accounts visible", async () => {
    const root = home([
      acct(WORK, "claude", "Work"),
      acct(OFF, "claude", "Off", { enabled: false }),
      acct(CODEX, "codex", "Codex"),
    ]);
    const source = createPoolUsage(() => root);
    const registry = new UsageSourceRegistry(Date.now, 300000, undefined, {
      hasAgent: () => true,
      usageSession: () => ({
        sessionKey: "launch-1",
        provider: "claude",
        env: { FULCRA_ACCOUNT_ID: WORK },
      }),
    });
    registry.register({ id: "fulcra-pool", label: "Pooled accounts", ...source });
    const all = await registry.listReports();
    expect(all.map((r) => r.id)).toEqual([
      `fulcra-pool:claude.${WORK}`,
      `fulcra-pool:claude.${OFF}`,
      `fulcra-pool:codex.${CODEX}`,
    ]);
    expect(all.map((r) => r.report.status)).toEqual(["unavailable", "unavailable", "unavailable"]);
    const bound = await registry.listReports({ agentId: "session" });
    expect(bound.map((r) => r.id)).toEqual([`fulcra-pool:claude.${WORK}`]);
    expect(await source.discover({ kind: "session", provider: "claude", env: {} })).toEqual([]);
    expect(
      await source.discover({
        kind: "session",
        provider: "codex",
        env: { FULCRA_ACCOUNT_ID: WORK },
      }),
    ).toEqual([]);
    expect(JSON.stringify(all)).not.toContain(root);
  });

  it("preserves observed windows and pool holds; rechecks disable and removal at fetch", async () => {
    const now = Date.parse("2026-10-12T00:00:00Z");
    const until = "2026-10-12T01:00:00Z";
    const root = home([acct(WORK, "claude", "Work", { limitedUntil: until })]);
    writeUsageSnapshot(root, [
      {
        accountId: WORK,
        name: "Work",
        provider: "claude",
        status: "ok",
        observedAt: "2026-10-11T23:59:00Z",
        source: "session",
        fiveHour: { usedPct: 100, resetsAt: until },
        weekly: { usedPct: 80, resetsAt: null },
        inUse: true,
      },
    ]);
    const source = createPoolUsage(
      () => root,
      () => now,
    );
    const input = { accountId: WORK, provider: "claude" };
    expect(await source.fetch(input)).toMatchObject({
      status: "available",
      windows: [
        { id: "five_hour", usedPct: 100, resetsAt: until, tone: "danger" },
        { id: "weekly", usedPct: 80, tone: "warning" },
      ],
      details: [
        { id: "observed-at", value: "2026-10-11T23:59:00Z" },
        { id: "pool-hold", value: until },
        { id: "limit-source", value: "local" },
      ],
    });
    writeFileSync(
      path.join(root, "accounts", "accounts.json"),
      JSON.stringify({ accounts: [acct(WORK, "claude", "Work", { enabled: false })] }),
    );
    expect(await source.fetch(input)).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: "This pooled account is disabled." },
    });
    writeFileSync(path.join(root, "accounts", "accounts.json"), JSON.stringify({ accounts: [] }));
    expect(await source.fetch(input)).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: "This pooled account is no longer available." },
    });
    await expect(source.fetch({ ...input, accountId: "../credentials" })).rejects.toThrow();
  });
});

it("native pool usage crosses the plugin subprocess and WebSocket with one bound account", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-pool-source-"));
  const pluginRoot = path.join(root, "plugins", "pool");
  const poolRoot = path.join(root, "pool");
  const work = "11111111-1111-4111-8111-111111111111";
  const off = "22222222-2222-4222-8222-222222222222";
  await mkdir(path.join(pluginRoot, "server"), { recursive: true });
  await mkdir(path.join(poolRoot, "accounts"), { recursive: true });
  await writeFile(
    path.join(poolRoot, "accounts", "accounts.json"),
    JSON.stringify({
      v: 1,
      accounts: [
        { id: work, provider: "claude", name: "Work", enabled: true },
        { id: off, provider: "claude", name: "Off", enabled: false },
      ],
    }),
  );
  writeUsageSnapshot(poolRoot, [
    {
      accountId: work,
      name: "Work",
      provider: "claude",
      status: "ok",
      observedAt: "2026-10-12T00:00:00Z",
      source: "session",
      fiveHour: { usedPct: 40, resetsAt: null },
      weekly: { usedPct: 80, resetsAt: null },
      inUse: true,
    },
  ]);
  await cp(
    fileURLToPath(
      new URL("../../../../../control/orca-organization/server/pool-usage.ts", import.meta.url),
    ),
    path.join(pluginRoot, "server", "pool-usage.ts"),
  );
  for (const file of [
    "accounts.mjs",
    "owned.mjs",
    "account-billing.mjs",
    "ask.mjs",
    "limit-line.mjs",
  ]) {
    await cp(
      fileURLToPath(
        new URL(`../../../../../control/orca-organization/server/${file}`, import.meta.url),
      ),
      path.join(pluginRoot, "server", file),
    );
  }
  await writeFile(
    path.join(pluginRoot, "paseo-plugin.json"),
    JSON.stringify({ id: "pool", requirements: { paseo: ">=0.11.0-beta.5" } }),
  );
  await writeFile(
    path.join(pluginRoot, "index.server.ts"),
    `import { registerPoolUsage } from './server/pool-usage'; export default function contribute(server) { registerPoolUsage(server, () => ${JSON.stringify(poolRoot)}); return () => {}; }`,
  );
  const provider = createTestAgentClient("claude");
  const create = provider.createSession.bind(provider);
  provider.createSession = async (...args) => {
    const session = await create(...args);
    session.usageSession = () => ({
      provider: "claude",
      sessionKey: "pooled-launch",
      env: { FULCRA_ACCOUNT_ID: work },
    });
    return session;
  };
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.11.0-beta.5",
    builtinPlugins: new BuiltinPluginLoader(path.join(root, "plugins"), ["pool"]),
    agentClients: { claude: provider },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.11.0-beta.5",
  });
  try {
    await client.connect();
    const global = await client.listUsageReports();
    expect(global.reports.map((report) => [report.id, report.report.status])).toEqual([
      [`fulcra-pool:claude.${work}`, "available"],
      [`fulcra-pool:claude.${off}`, "unavailable"],
    ]);
    const agent = await daemon.daemon.agentManager.createAgent(
      { provider: "claude", cwd: root },
      undefined,
      {},
    );
    const bound = await client.listUsageReports({ agentId: agent.id });
    expect(bound.reports.map((report) => report.id)).toEqual([`fulcra-pool:claude.${work}`]);
    expect(bound.reports[0]?.report).toMatchObject({
      status: "available",
      windows: [
        { id: "five_hour", usedPct: 40 },
        { id: "weekly", usedPct: 80 },
      ],
    });
    expect(JSON.stringify(bound)).not.toContain(poolRoot);
    const legacy = await client.listProviderUsage();
    expect(legacy.providers.map((entry) => entry.providerId)).toEqual([
      "fulcra-pool",
      "fulcra-pool",
    ]);
    const remoteReset = new Date(Date.now() + 3600000).toISOString();
    await writeFile(
      path.join(poolRoot, "accounts", "remote-limits.json"),
      JSON.stringify({
        v: 1,
        observations: [
          {
            accountId: work,
            limitKind: "weekly",
            resetAt: remoteReset,
            observedAt: new Date().toISOString(),
            source: "paired-host",
          },
        ],
      }),
    );
    const remote = await client.listUsageReports({ agentId: agent.id, forceRefresh: true });
    expect(remote.reports[0]?.report).toMatchObject({
      status: "available",
      details: [
        { id: "observed-at" },
        { id: "pool-hold", value: remoteReset },
        { id: "limit-source", value: "remote host paired-host" },
      ],
    });
    await writeFile(path.join(poolRoot, "accounts", "usage-reports.json"), "invalid snapshot");
    const failed = await client.listUsageReports({ agentId: agent.id, forceRefresh: true });
    expect(failed.reports[0]?.report.status).toBe("unavailable");
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
