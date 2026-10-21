// FU-423: a controller start on a host with many archived sessions. The REAL startController and the REAL
// connectNative run over a counting fake daemon client (only the owned transport is replaced, as in
// native-roles.test.mjs). Archived sessions must cost nothing: no fetch_agent, no timeline. The start builds its
// view of live sessions from one fetch_agents list.
import "./state-root.fixture.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const LIVE = 30,
  ARCHIVED = 700;
const at = new Date(Date.now() - 3600000).toISOString();
const agent = (id, archived) => ({
  id,
  provider: "claude",
  status: archived ? "closed" : "idle",
  title: `Fixture ${id.slice(0, 8)}`,
  cwd: `/tmp/fixture/${id}`,
  workspaceId: null,
  labels: {},
  pendingPermissions: [],
  createdAt: at,
  updatedAt: at,
  lastActivityAt: at,
  archivedAt: archived ? at : null,
});
const liveIds = Array.from({ length: LIVE }, () => randomUUID()),
  archivedIds = Array.from({ length: ARCHIVED }, () => randomUUID());
const agents = new Map([
  ...liveIds.map((id) => [id, agent(id, false)]),
  ...archivedIds.map((id) => [id, agent(id, true)]),
]);
const requests = { list: [], fetch: [], timeline: [], history: [], other: [] };

const realInput = await import("./trusted-native-input.mjs?real"),
  realPermission = await import("./permission-channel.mjs?real");
mock.module("./catalog-activation.mjs", {
  namedExports: {
    catalogActivation: () => ({
      refresh: async () => {},
      require: () => "fixture-boot",
      close() {},
    }),
  },
});
mock.module("./trusted-native-input.mjs", {
  namedExports: { ...realInput, boundNativeInputs: () => ({}) },
});
mock.module("./permission-channel.mjs", {
  namedExports: {
    ...realPermission,
    permissionChannel: () => ({ ready: async () => {}, close: async () => {} }),
  },
});
const subscription = { subscribe: () => () => {}, release: async () => {} };
mock.module("./client-sdk.mjs", {
  namedExports: {
    DaemonRpcError: class DaemonRpcError extends Error {},
    createPaseoApi: () => ({
      agents: {
        list: async (options = {}) => {
          requests.list.push(options);
          const all = [...agents.values()].filter(
            (a) => options.filter?.includeArchived || !a.archivedAt,
          );
          const limit = options.page?.limit ?? 50;
          return {
            entries: all.slice(0, limit).map((a) => ({ agent: a })),
            pageInfo: { hasMore: all.length > limit, nextCursor: null },
            ...(options.subscribe ? { subscription } : {}),
          };
        },
        subscribe: () => () => {},
        ref: (id) => {
          let current = null;
          return {
            refresh: async () => {
              requests.fetch.push(id);
              current = agents.get(id) ?? null;
              return current ? { agent: current } : null;
            },
            current: () => current,
            timeline: {
              refetch: async () => {
                requests.timeline.push(id);
                return {
                  entries: [],
                  epoch: "e",
                  window: { minSeq: 0, maxSeq: 0 },
                  hasOlder: false,
                };
              },
            },
          };
        },
      },
      providers: { listModels: async (provider) => ({ provider, models: [] }) },
      workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
      dispose: async () => {},
    }),
  },
});

const daemonFake = {
  isConnected: true,
  close: async () => {},
  getLastServerInfoMessage: () => null,
  fetchWorkspaces: async () => ({ entries: [], pageInfo: { hasMore: false } }),
  setWorkspaceTitle: async () => {},
  fetchAgentHistory: async (options) => {
    requests.history.push(options);
    return { entries: [], pageInfo: { hasMore: false } };
  },
  getDaemonConfig: async () => ({ config: {} }),
};
// Any other daemon call answers empty, so a start never waits on a call this fixture does not model.
const daemon = new Proxy(daemonFake, {
  get(target, name) {
    if (name in target || typeof name !== "string" || name === "then") return target[name];
    return async () => {
      requests.other.push(name);
      return {};
    };
  },
});

// The controller's journal knows every session, archived or not, as it does on a long-lived host.
const { CONTROLLER_HOME } = await import("./installation-settings.mjs");
const { ControlStore } = await import("./store.mjs");
{
  const store = new ControlStore(`${CONTROLLER_HOME}/journal.sqlite`);
  const insert = store.db.prepare(
    "INSERT INTO sessions(id,task,cwd,mode,generation,boot) VALUES (?,?,?,'delegated',1,'old-boot')",
  );
  for (const id of [...archivedIds, ...liveIds])
    insert.run(id, "fixture-task", `/tmp/fixture/${id}`);
  store.close();
}

const { startController } = await import("./server.mjs");
const exit = mock.method(process, "exit", () => {}),
  before = new Set(process.listeners("exit"));
const started = await startController({
  daemon,
  issueProvenance: async () => "token",
  registerManagement: () => () => {},
  epoch: randomUUID(),
  getHandshakeBoot: () => "fixture-boot",
});
test.after(async () => {
  await started.stop();
  for (const l of process.listeners("exit").filter((l) => !before.has(l))) {
    process.removeListener("exit", l);
    l();
  }
  exit.mock.restore();
});

test("a start with 700 archived and 30 live sessions fetches no archived session and lists once", async () => {
  // Let the background startup passes (workspace titles, usage-limit checks, restart discovery) run.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const archived = new Set(archivedIds);
  const archivedFetches = requests.fetch.filter((id) => archived.has(id)).length,
    archivedTimelines = requests.timeline.filter((id) => archived.has(id)).length;
  console.log(
    JSON.stringify({
      fetchAgents: requests.list.length,
      fetchAgent: requests.fetch.length,
      fetchAgentArchived: archivedFetches,
      fetchAgentTimeline: requests.timeline.length,
      fetchAgentTimelineArchived: archivedTimelines,
    }),
  );
  assert.equal(archivedFetches, 0, "fetch_agent for archived sessions");
  assert.equal(archivedTimelines, 0, "timeline reads for archived sessions");
  assert.ok(requests.list.length <= 1, `fetch_agents calls: ${requests.list.length}`);
  assert.ok(
    requests.list.every((o) => !o.filter?.includeArchived),
    "the list asks for live sessions only",
  );
});
