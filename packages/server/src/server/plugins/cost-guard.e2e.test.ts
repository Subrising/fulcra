import { cp, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { AgentSession } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import {
  addAccount,
  setAccount,
} from "../../../../../control/orca-organization/server/accounts.mjs";
import { readBilling } from "../../../../../control/orca-organization/server/account-billing.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cost-guard-repair-"));
  const plugin = path.join(root, "plugin");
  const pool = path.join(root, "pool");
  const a = await addAccount(pool, { provider: "claude", name: "Fixture A" });
  const b = await addAccount(pool, { provider: "claude", name: "Fixture B" });
  for (const account of [a, b])
    await setAccount(pool, account.id, {
      credentialKind: "api-key",
      budget: { limitUsd: 200, startAt: "2026-10-01T00:00:00Z" },
      dailyLimitUsd: 200,
    });
  let account = a.id;
  let kind: "api-key" | "subscription" = "api-key";
  let started = 0;
  const ids: string[] = [];
  const costs: number[] = [];
  const provider = createTestAgentClient("claude", {});
  const instrument = (session: AgentSession) => {
    const launch = account,
      launchKind = kind;
    session.usageCredential = () => null;
    session.limitResumeAccountBinding = () => `pool:${launch}`;
    session.billingAccountKind = () => launchKind;
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (callback) =>
      subscribe((event) => {
        if (event.type === "turn_started") started++;
        if (event.type !== "turn_completed") return callback(event);
        ids.push(event.turnId!);
        const amount = costs.shift() ?? 1;
        callback({ ...event, usage: { totalCostUsd: amount, turnCostUsd: amount } });
      });
    return session;
  };
  const create = provider.createSession.bind(provider),
    resume = provider.resumeSession.bind(provider);
  provider.createSession = async (...args) => instrument(await create(...args));
  provider.resumeSession = async (...args) => instrument(await resume(...args));
  await mkdir(plugin);
  await cp(path.resolve("../../control/orca-organization/server"), path.join(plugin, "server"), {
    recursive: true,
  });
  await writeFile(
    path.join(plugin, "paseo-plugin.json"),
    JSON.stringify({ id: "cost-repair", requirements: { paseo: ">=0.8.0" } }),
  );
  await writeFile(
    path.join(plugin, "index.server.ts"),
    `
import fs from "node:fs";
import { assertApiSpendAllowed, readSessionBilling, recordAccountCost } from "./server/account-billing.mjs";
export default function(server) {
 server.before("agent.cost_commit", async ({ request }) => {
   if (fs.existsSync(${JSON.stringify(path.join(root, "fail"))})) throw new Error("Fixture billing write failed");
   if (request.accountId) await recordAccountCost(${JSON.stringify(pool)}, { id: "turn:" + request.agentId + ":" + request.turnId, accountId: request.accountId, sessionId: request.agentId, costUsd: request.costUsd, at: request.at, cursorCheckpoint: request.cursors, costRevision: request.revision });
   return { ...request, costCommitted: true };
 });
 server.before("agent.cost_read", ({ request }) => readSessionBilling(${JSON.stringify(pool)}, request));
 server.before("agent.turn_start", ({ request }) => { assertApiSpendAllowed(${JSON.stringify(pool)}, request); return { ...request, apiGuardChecked: true }; });
 return () => {};
}
`,
  );
  const options = {
    paseoHomeRoot: root,
    cleanup: false,
    agentClients: { claude: provider },
    pluginsEnabled: true,
    plugins: { "cost-repair": { source: "directory" as const, path: plugin, enabled: true } },
  };
  let daemon = await createTestPaseoDaemon(options);
  const connect = async () => {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: resolveDaemonVersion(),
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    return client;
  };
  let client = await connect();
  return {
    root,
    pool,
    a,
    b,
    costs,
    ids,
    get client() {
      return client;
    },
    get manager() {
      return daemon.daemon.agentManager;
    },
    get started() {
      return started;
    },
    switchAccount() {
      account = b.id;
    },
    subscription() {
      kind = "subscription";
    },
    async restart() {
      await client.close();
      await daemon.close();
      daemon = await createTestPaseoDaemon(options);
      client = await connect();
    },
    async close() {
      await client.close();
      await daemon.close();
      await rm(root, { recursive: true, force: true });
    },
    async turn(id: string, amount: number) {
      costs.push(amount);
      await client.sendMessage(id, "Fixture turn");
      return client.waitForAgentUpsert(id, (s) => s.status === "idle");
    },
    async create() {
      return client.createAgent({ provider: "claude", cwd: root, modeId: "bypassPermissions" });
    },
  };
}

test("restart, reload and account switch count new turns with reused provider IDs", async () => {
  const f = await fixture();
  try {
    const agent = await f.create();
    await f.turn(agent.id, 4);
    await f.restart();
    expect((await f.turn(agent.id, 5)).sessionCost?.totalUsd).toBe(9);
    await f.manager.reloadAgentSession(agent.id);
    expect((await f.turn(agent.id, 3)).sessionCost?.totalUsd).toBe(12);
    f.switchAccount();
    await f.manager.reloadAgentSession(agent.id);
    const last = await f.turn(agent.id, 2);
    expect(f.ids).toEqual(["fake-turn-0", "fake-turn-0", "fake-turn-0", "fake-turn-0"]);
    expect(last.sessionCost).toMatchObject({
      totalUsd: 14,
      lastTurnUsd: 2,
      recordedTurns: 4,
      accounts: [
        { accountId: f.a.id, totalUsd: 12 },
        { accountId: f.b.id, totalUsd: 2 },
      ],
    });
    expect(Object.keys(readBilling(f.pool).calls)).toHaveLength(4);
    await f.client.updateAgent(agent.id, { labels: { "fulcra.session-cost-cap-usd": "14" } });
    await expect(f.client.sendMessage(agent.id, "Capped turn")).rejects.toThrow(/session cost cap/);
    expect(f.started).toBe(4);
  } finally {
    await f.close();
  }
}, 60_000);

test("failed billing finishes with a durable warning, refuses recovery failure, then recovers after restart", async () => {
  const f = await fixture();
  try {
    const agent = await f.create();
    await writeFile(path.join(f.root, "fail"), "fixture");
    const done = await f.turn(agent.id, 4);
    expect(done.sessionCost).toMatchObject({
      totalUsd: 4,
      warning: expect.stringContaining("Billing write failed"),
    });
    expect(Object.keys(readBilling(f.pool).calls)).toHaveLength(0);
    await expect(f.client.sendMessage(agent.id, "Refused retry")).rejects.toThrow(
      /cost recovery failed/,
    );
    expect(f.started).toBe(1);
    const pending = JSON.parse(
      await readFile(path.join(f.root, ".paseo/usage/pending-costs.json"), "utf8"),
    );
    expect(Object.values(pending)).toHaveLength(1);
    await f.restart();
    expect((await f.client.fetchAgent(agent.id))?.agent.sessionCost).toMatchObject({
      totalUsd: 4,
      warning: expect.stringContaining("Billing write failed"),
    });
    await rm(path.join(f.root, "fail"));
    const recovered = await f.turn(agent.id, 5);
    expect(recovered.sessionCost).toMatchObject({ totalUsd: 9, recordedTurns: 2 });
    expect(recovered.sessionCost?.warning).toBeUndefined();
    expect(Object.values(readBilling(f.pool).calls).map((row) => row.costUsd)).toEqual([4, 5]);
  } finally {
    await f.close();
  }
}, 60_000);

test("disabled guard refuses API turns while subscription turns still run", async () => {
  const f = await fixture();
  try {
    const api = await f.create();
    await f.turn(api.id, 1);
    await f.client.patchDaemonConfig({ pluginsEnabled: false });
    await expect(f.client.sendMessage(api.id, "No guard")).rejects.toThrow(/guard is unavailable/);
    f.subscription();
    const sub = await f.create();
    expect((await f.turn(sub.id, 1)).status).toBe("idle");
    expect(f.started).toBe(2);
  } finally {
    await f.close();
  }
}, 60_000);
