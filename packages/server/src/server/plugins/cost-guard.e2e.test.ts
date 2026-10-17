import { cp, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
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
    });
  let account = a.id;
  let started = 0;
  const ids: string[] = [];
  const costs: number[] = [];
  const provider = createTestAgentClient("claude", {});
  const instrument = (session: AgentSession) => {
    const launch = account;
    session.usageCredential = () => null;
    session.limitResumeAccountBinding = () => `pool:${launch}`;
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (callback) =>
      subscribe((event) => {
        if (event.type === "turn_started") started++;
        if (event.type === "turn_failed")
          return callback({ ...event, error: "HTTP 402 billing_error: credit balance is too low" });
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
import { readSessionBilling, recordAccountCost, recordAccountTurnEnd } from "./server/account-billing.mjs";
export default function(server) {
 server.before("agent.cost_commit", async ({ request }) => {
   if (fs.existsSync(${JSON.stringify(path.join(root, "fail"))})) throw new Error("Fixture billing write failed");
   if (request.accountId) await recordAccountCost(${JSON.stringify(pool)}, { id: "turn:" + request.agentId + ":" + request.turnId, accountId: request.accountId, sessionId: request.agentId, costUsd: request.costUsd, at: request.at, cursorCheckpoint: request.cursors, costRevision: request.revision });
   return { ...request, costCommitted: true };
 });
 server.on("agent.turn_ended", (event) => recordAccountTurnEnd(${JSON.stringify(pool)}, event));
 server.before("agent.cost_read", ({ request }) => readSessionBilling(${JSON.stringify(pool)}, request));
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
    get storage() {
      return daemon.daemon.agentStorage;
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
    async create(callerAgentId?: string) {
      return client.createAgent({
        provider: "claude",
        cwd: root,
        modeId: "bypassPermissions",
        callerAgentId,
      });
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
    expect((await f.turn(agent.id, 1000)).sessionCost?.totalUsd).toBe(1014);
    await f.restart();
    expect((await f.turn(agent.id, 1)).sessionCost?.totalUsd).toBe(1015);
    expect(f.started).toBe(6);
  } finally {
    await f.close();
  }
}, 60_000);

test("failed billing retains a warning, allows more turns, and recovers after restart", async () => {
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
    expect((await f.turn(agent.id, 3)).sessionCost?.totalUsd).toBe(7);
    expect(f.started).toBe(2);
    const pending = JSON.parse(
      await readFile(path.join(f.root, ".paseo/usage/pending-costs.json"), "utf8"),
    );
    expect(Object.values(pending)).toHaveLength(2);
    await f.restart();
    expect((await f.client.fetchAgent(agent.id))?.agent.sessionCost).toMatchObject({
      totalUsd: 7,
      warning: expect.stringContaining("Billing write failed"),
    });
    await rm(path.join(f.root, "fail"));
    const recovered = await f.turn(agent.id, 5);
    expect(recovered.sessionCost).toMatchObject({ totalUsd: 12, recordedTurns: 3 });
    expect(recovered.sessionCost?.warning).toBeUndefined();
    expect(Object.values(readBilling(f.pool).calls).map((row) => row.costUsd)).toEqual([4, 3, 5]);
  } finally {
    await f.close();
  }
}, 60_000);

test("no API turn is ever refused for spend, even when accounting is unavailable", async () => {
  const f = await fixture();
  try {
    const api = await f.create();
    await f.turn(api.id, 1);
    await f.client.patchDaemonConfig({ pluginsEnabled: false });
    expect((await f.turn(api.id, 10000)).sessionCost?.totalUsd).toBe(10001);
    const sub = await f.create();
    expect((await f.turn(sub.id, 1)).status).toBe("idle");
    expect(f.started).toBe(3);
  } finally {
    await f.close();
  }
}, 60_000);

test("worker finish data retains total spend including the last turn across daemon restart", async () => {
  const f = await fixture();
  try {
    const parent = await f.create();
    const child = await f.create(parent.id);
    await f.turn(child.id, 9.65);
    f.switchAccount();
    await f.manager.reloadAgentSession(child.id);
    await f.storage.armFinishNotice(f.manager.getAgent(child.id)!, parent.id, "report-up");
    await f.turn(child.id, 7.87);
    const notice = await f.storage.getFinishNotice(child.id);
    expect(notice?.sessionCost).toMatchObject({
      totalUsd: 17.52,
      lastTurnUsd: 7.87,
      recordedTurns: 2,
    });
    await f.restart();
    expect((await f.storage.getFinishNotice(child.id))?.sessionCost).toEqual(notice?.sessionCost);
  } finally {
    await f.close();
  }
}, 60_000);

test("durable API billing incidents clear after a successful native turn", async () => {
  const f = await fixture();
  async function fail(id: string) {
    await f.client.sendMessage(id, "emit a turn failure");
    await f.client.waitForAgentUpsert(id, (state) => state.status === "error");
  }
  try {
    const agent = await f.create();
    await fail(agent.id);
    await vi.waitFor(() => expect(readBilling(f.pool).events).toHaveLength(1));
    const eventId = readBilling(f.pool).events[0].id;
    await fail(agent.id);
    await vi.waitFor(() => expect(f.started).toBe(2));
    expect(readBilling(f.pool).events).toHaveLength(1);
    await f.turn(agent.id, 2);
    await vi.waitFor(() => expect(readBilling(f.pool).events[0].clearedAt).toBeDefined());
    await f.restart();
    await fail(agent.id);
    await vi.waitFor(() => expect(readBilling(f.pool).events).toHaveLength(2));
    expect(readBilling(f.pool).events[1].id).not.toBe(eventId);
  } finally {
    await f.close();
  }
}, 60_000);
