// Defaults to the consolidated control tree; optional explicit component roots remain supported.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { initHome, task } from "./bootstrap.mjs";
const defaultControl = process.env.FULCRA_CONTROL_ROOT ?? new URL("../../control/", import.meta.url).pathname;
const [runtime, conversation, workspace] = [0, 1, 2].map((i) => fs.realpathSync(process.argv[i + 2] ?? defaultControl));
const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "orca-integration-")),
);
const home = initHome(path.join(scratch, "fresh-user"), 53431);
process.env.ORCA_HOME = home;
process.env.ORCA_CONTROLLER_HOME = path.join(home, "controller");
process.env.PASEO_HOME = path.join(home, "daemon");
const req = createRequire(new URL("../../package.json", import.meta.url));
const { build } = req("esbuild");
const imp = (root, file) => import(pathToFileURL(path.join(root, file)));
let server, store;
try {
  const project = task(home, "add", "Personal project"),
    outcome = task(home, "add", "Useful first outcome", project.id);
  const { portable, loadPortable } = await imp(runtime, "src/portable-config.mjs");
  assert.equal(portable.home, home);
  assert.throws(() => loadPortable({ ORCA_HOME: home + "/.." }), /Canonical/);
  const { authorizeTask } = await imp(runtime, "src/control/authority.mjs");
  assert.equal((await authorizeTask(outcome.id)).id, outcome.id);
  task(home, "close", project.id);
  await assert.rejects(authorizeTask(outcome.id), /authority/);
  task(home, "reopen", project.id);
  const { ControlStore } = await imp(runtime, "src/control/store.mjs");
  const { Controller } = await imp(runtime, "src/control/controller.mjs");
  const { Events } = await imp(runtime, "src/control/events.mjs");
  const { Manager } = await imp(runtime, "src/control/manager.mjs");
  const { Permissions } = await imp(runtime, "src/control/permissions.mjs");
  const { Leadership } = await imp(runtime, "src/control/leadership.mjs");
  const { rpc } = await imp(runtime, "src/control/rpc.mjs");
  store = new ControlStore(path.join(home, "controller/journal.sqlite"));
  let creates = 0,
    sends = 0;
  const states = new Map();
  const native = {
    create: async (a) => {
      creates++;
      const id = randomUUID(),
        cwd = path.join(home, "controller/tasks", a.messageId);
      fs.mkdirSync(cwd);
      const profileDir = path.join(
        home,
        "daemon/agents",
        cwd.replace(/^\//, "").replaceAll("/", "-"),
      );
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, id + ".json"),
        JSON.stringify({ provider: a.provider, title: a.title }),
      );
      states.set(id, {
        fenceProtocol: "orca-input-sequence-v1",
        saturated: false,
        humanAt: 0,
        status: "idle",
        pending: 0,
        lastPromptId: null,
        boot: "fixture",
        nativeId: id,
        timelineCursor: { epoch: "fixture", seq: 0 },
      });
      return { id, cwd, managerToolsVersion: "1" };
    },
    inspect: async (id) => ({ ...states.get(id) }),
    send: async (id, _text, messageId) => {
      sends++;
      states.get(id).lastPromptId = messageId;
    },
    completion: async () => ({
      ended: true,
      outputObserved: true,
      outputPreview: "fake provider output",
      outputEvidenceHash: "a".repeat(64),
    }),
  };
  const control = new Controller({ store, native });
  control.events = new Events(control);
  control.manager = new Manager(control);
  control.leadership = new Leadership(control);
  control.permissions = new Permissions(control);
  const secret = "f".repeat(43);
  fs.writeFileSync(path.join(home, "controller/operator.secret"), secret, { mode: 0o600 });
  const dispatch = rpc(control, secret);
  server = net.createServer((socket) => {
    let data = "";
    socket.on("data", async (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      try {
        socket.end(JSON.stringify({ result: await dispatch(JSON.parse(data)) }) + "\n");
      } catch (e) {
        socket.end(JSON.stringify({ error: e.message }) + "\n");
      }
    });
  });
  await new Promise((resolve) =>
    server.listen(path.join(home, "controller/control.sock"), resolve),
  );
  const { installedConversation } = await imp(conversation, "orca-conversation/client.mjs");
  let run = installedConversation();
  const command = {
    action: "create",
    taskId: outcome.id,
    title: "Persistent coordinator",
    provider: "codex",
  };
  const created = await run(command);
  assert.ok(created.sessionId);
  assert.equal((await run(command)).sessionId, created.sessionId);
  assert.equal(creates, 1);
  await run({
    action: "supervise",
    sessionId: created.sessionId,
    generation: 1,
    maxWorkers: 2,
    reason: "Explicit local project supervision",
  });
  assert.equal(sends, 0); // Promoting the saved coordinator is not a model turn.
  run = installedConversation();
  assert.equal((await run({ action: "list" })).sessions[0].sessionId, created.sessionId);
  assert.equal((await run({ action: "supervisors" })).groups[0].id, created.sessionId);
  for (const [entry, name] of [
    ["server/tasks.ts", "tasks"],
    ["server/management.ts", "management"],
    ["server/organization.ts", "organization"],
  ]) {
    await build({
      entryPoints: [path.join(workspace, "orca-organization", entry)],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: path.join(scratch, name + ".mjs"),
      nodePaths: [path.resolve(new URL("../../node_modules", import.meta.url).pathname)],
    });
  }
  const tasks = await imp(scratch, "tasks.mjs"),
    management = await imp(scratch, "management.mjs"),
    organization = await imp(scratch, "organization.mjs");
  const catalog = await tasks.readTaskCatalog();
  assert.equal(catalog.tasks.find((t) => t.id === outcome.id).title, "Useful first outcome");
  const managed = await management.createTaskManagement()({
    taskId: outcome.id,
    command: { action: "list" },
  });
  assert.equal(managed.status, "observed", JSON.stringify(managed));
  assert.equal(managed.sessions[0].id, created.sessionId);
  assert.equal((await organization.readBoard(undefined, outcome.id)).title, "Useful first outcome");
  const memoryFile = path.join(home, "memory/decision.md");
  fs.writeFileSync(memoryFile, "A fresh user owns this cobalt decision\n");
  fs.writeFileSync(path.join(home, "memory/history/prior.md"), "Earlier cobalt evidence\n");
  fs.writeFileSync(path.join(scratch, "private.md"), "NEVER SHARE\n");
  const request = (id, name, args) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }) + "\n";
  const input =
    request(1, "shared_memory_search", { query: "cobalt", scope: "all" }) +
    request(2, "shared_memory_read", { path: path.join(scratch, "private.md") });
  const m = spawnSync(process.execPath, [path.join(runtime, "src/portable-memory/entry.mjs")], {
    env: {
      ...process.env,
      ORCA_MEMORY_CLIENT: "local",
      SHM_ROOTS: scratch,
      SHM_ALLOW_PRIVATE: "1",
    },
    input,
    encoding: "utf8",
  });
  assert.equal(m.status, 0, m.stderr);
  const replies = m.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(JSON.parse(replies[0].result.content[0].text).matches.length, 2);
  assert.equal(replies[1].result.isError, true);
  const before = fs.readFileSync(path.join(home, "tasks.json"));
  assert.throws(() => initHome(home), { code: "EEXIST" });
  assert.deepEqual(fs.readFileSync(path.join(home, "tasks.json")), before);
  console.log(
    JSON.stringify({
      passed: true,
      providerCreates: creates,
      modelTurns: sends,
      checks: [
        "local authority and revoked parent",
        "real SQLite and Unix socket",
        "installed conversation create/dedup/supervise/revisit",
        "workspace catalog/management/board",
        "current/history MCP and private-root denial",
        "existing user-data preservation",
      ],
    }),
  );
} finally {
  if (server) await new Promise((r) => server.close(r));
  store?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
