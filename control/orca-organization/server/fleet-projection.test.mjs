// FD-1/FD-1b: the Sessions fleet read through the REAL management dispatcher, a real ControlStore and the
// native host projection. Local and Book sessions keep their host, title, provider and remote route under
// the configured host names, and a host filter matches: for a legacy mini/macbook topology, for a fresh
// first-run portable config, and for the shipped portable adapter (localNative) that server.mjs uses.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstRun } from "../../src/config.mjs";

const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fleet-projection-"));
const previousHome = process.env.ORCA_HOME;
process.env.ORCA_HOME = home;
firstRun();
const configFile = path.join(home, "config.json");
const firstRunConfig = fs.readFileSync(configFile, "utf8");
// Names the local host (null keeps the first-run name) and the remote hosts, before each fleet read.
function configure(local, hosts) {
  const config = JSON.parse(firstRunConfig);
  config.localHost = { name: local ?? config.localHost.name, serverId: "srv_fd1_local" };
  config.hosts = hosts.map(([name, serverId]) => ({ name, serverId }));
  fs.writeFileSync(configFile, JSON.stringify(config));
}
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.ORCA_HOME;
  else process.env.ORCA_HOME = previousHome;
});

const { readFleet } = await import("../runtime/fleet-server.mjs");
const { ControlStore } = await import("../../src/control/store.mjs");
const { HostNative } = await import("../../src/control/host-native.mjs");
const { managementDispatcher } = await import("../../src/control/rpc.mjs");
const { localNative } = await import("../../src/control/portable-host.mjs");

const id = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const task = id(9),
  local = id(1),
  remote = id(2),
  agent = id(3),
  at = () => new Date().toISOString();

async function sessionsFleet(
  t,
  file,
  nativeFor = (store) => new HostNative({ store, local: {} }),
  withBook = true,
) {
  const store = new ControlStore(path.join(home, file));
  t.after(() => store.close());
  store.created(local, task, home);
  if (withBook) store.created(remote, task, home);
  const native = nativeFor(store);
  if (withBook)
    native.db
      .prepare(
        "INSERT INTO host_routes(id,request,host,creation,agent,phase,generation,error) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        remote,
        "fd1-request",
        "macbook",
        JSON.stringify({ provider: "claude" }),
        agent,
        "active",
        1,
        null,
      );
  const dispatch = managementDispatcher({ store, native });
  const call = async (method, input) => {
    if (method === "list") return dispatch({ method: "list" });
    if (method === "manager-summary") return [];
    if (method === "quota-status") throw Error("unsupported");
    // The controller's observe returns the projected row; the Book observation rides on it.
    if (method === "observe" && input === remote)
      return {
        ...(await dispatch({ method: "list" })).find((r) => r.id === remote),
        observed: {
          status: "idle",
          pending: 0,
          provider: "claude",
          title: "Book review",
          observedAt: at(),
        },
      };
    throw Error(`Unexpected ${method}`);
  };
  const paseo = {
    agents: {
      list: async () => ({
        entries: [
          {
            agent: {
              id: local,
              title: "Local author",
              provider: "codex",
              model: "model",
              status: "idle",
              pendingPermissions: [],
              updatedAt: at(),
            },
          },
        ],
        pageInfo: {},
      }),
    },
  };
  const catalog = async () => ({ tasks: [{ id: task, title: "One task", identifier: "AIN-1" }] });
  const details = async () => null;
  const read = (input) => readFleet(paseo, call, catalog, details, undefined, input);
  const all = await read();
  return { all, read, byId: Object.fromEntries(all.nodes.map((n) => [n.id, n])) };
}

test("FD-1 Sessions fleet over the real management list keeps host, title, provider and remote route", async (t) => {
  configure("mini", [["macbook", "srv_fd1_book"]]);
  const { byId, read } = await sessionsFleet(t, "legacy.sqlite");
  assert.equal(byId[local].host, "mini");
  assert.equal(byId[local].serverId, "srv_fd1_local");
  assert.equal(byId[local].title, "Local author");
  assert.equal(byId[local].provider, "codex");
  assert.notEqual(byId[local].status, "unavailable");
  assert.equal(byId[remote].host, "macbook");
  assert.equal(byId[remote].serverId, "srv_fd1_book");
  assert.equal(byId[remote].provider, "claude");
  assert.equal(byId[remote].agentId, agent);
  assert.equal(byId[remote].title, "Book review");
  assert.notEqual(byId[remote].status, "unavailable");

  assert.deepEqual(
    (await read({ host: "mini" })).nodes.map((n) => n.id),
    [local],
  );
  assert.deepEqual(
    (await read({ host: "macbook" })).nodes.map((n) => n.id),
    [remote],
  );
});

test('FD-1b a fresh first-run portable config shows sessions under "This Mac" and the configured remote name', async (t) => {
  configure(null, [["Studio", "srv_fd1_studio"]]);
  const { all, byId, read } = await sessionsFleet(t, "portable.sqlite");
  assert.equal(byId[local].host, "This Mac");
  assert.equal(byId[local].serverId, "srv_fd1_local");
  assert.equal(byId[local].title, "Local author");
  assert.equal(byId[remote].host, "Studio");
  assert.equal(byId[remote].serverId, "srv_fd1_studio");
  assert.equal(byId[remote].title, "Book review");
  assert.ok(
    all.nodes.every((n) => n.host !== "unknown" && n.status !== "unavailable"),
    "nothing reads unknown",
  );
  assert.deepEqual(
    (await read({ host: "This Mac" })).nodes.map((n) => n.id),
    [local],
  );
  assert.deepEqual(
    (await read({ host: "Studio" })).nodes.map((n) => n.id),
    [remote],
  );
});

test('FD-1b the shipped portable adapter (server.mjs localNative) shows local sessions under "This Mac"', async (t) => {
  configure(null, [["Studio", "srv_fd1_studio"]]);
  const { all, byId, read } = await sessionsFleet(
    t,
    "shipped.sqlite",
    () => localNative({}),
    false,
  );
  assert.deepEqual(
    all.nodes.map((n) => n.id),
    [local],
  );
  assert.equal(byId[local].host, "This Mac");
  assert.equal(byId[local].title, "Local author");
  assert.ok(all.nodes.every((n) => n.host !== "unknown"));
  assert.deepEqual(
    (await read({ host: "This Mac" })).nodes.map((n) => n.id),
    [local],
  );
});
