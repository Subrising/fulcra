import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCommand, commandOrigin, parseCommand } from "./command.mjs";
import { createWorkspace } from "./workspace.mjs";
import { bindingName } from "../../orca-ingress/src/relay.mjs";
import { ControlStore } from "../../src/control/store.mjs";
import { Controller } from "../../src/control/controller.mjs";
import { rpc } from "../../src/control/rpc.mjs";
import { PROGRAMME, COMPANY } from "../../src/control/authority.mjs";
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-command-workspace-")));
  const store = new ControlStore(path.join(root, "journal.sqlite")),
    id = randomUUID();
  const config = {
    bindingsDir: path.join(root, "bindings"),
    accountId: "default",
    conversationId: "123",
    senderId: "456",
    sessionId: randomUUID(),
  };
  const host = { channels: { discord: { slashCommand: { ephemeral: true } } } };
  let sends = 0;
  const current = { status: "idle", pending: 0, lastPromptId: null };
  const control = new Controller({
    store,
    native: {
      inspect: async () => ({ ...current }),
      send: async (_id, _text, messageId) => {
        sends++;
        current.lastPromptId = messageId;
      },
    },
    authority: async (id) => ({
      id,
      companyId: COMPANY,
      parentId: PROGRAMME,
      assigneeUserId: "local-board",
      assigneeAgentId: null,
      status: "in_progress",
    }),
  });
  store.created(id, PROGRAMME, root);
  const operator = "a".repeat(43);
  fs.writeFileSync(path.join(root, "operator.secret"), operator, { mode: 0o600 });
  const calls = [],
    dispatch = rpc(control, operator);
  const request = async (envelope) => {
    calls.push(envelope.method);
    const result = await dispatch(envelope);
    await f.after?.(envelope);
    return result;
  };
  const make = () => {
    const workspace = createWorkspace({
      config,
      baseOrigin: commandOrigin(config),
      request,
      runtimeHome: root,
    });
    const command = createCommand({
      config,
      workspace,
      request,
      grantsDir: path.join(root, "grants"),
    });
    command.service.start({ config: host });
    return { ...command, workspace };
  };
  const f = { root, store, control, current, id, config, calls, make, sends: () => sends };
  Object.assign(f, make());
  f.run = (args, patch = {}) =>
    f.definition.handler({
      config: host,
      senderIsOwner: true,
      isAuthorizedSender: true,
      channel: "discord",
      channelId: "123",
      accountId: "default",
      senderId: "456",
      from: "discord:channel:123",
      to: "slash:456",
      args,
      commandBody: "/orca " + args,
      ...patch,
    });
  t.after(() => {
    f.service.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}
test("discovery grants nothing; explicit handback persists selection, duplicate asks send once, restart retains, takeover wins", async (t) => {
  const f = fixture(t);
  assert.match((await f.run("sessions")).text, new RegExp(f.id));
  assert.equal(f.store.get(f.id).mode, "human");
  assert.match((await f.run(`delegate ${f.id} 1`)).text, /Selected and delegated/);
  assert.equal(f.workspace.currentOrigin().sessionId, f.id);
  const first = await f.run("ask Write a fictional note");
  assert.match(first.text, /delivered/);
  assert.match((await f.run("ask Write a fictional note")).text, /Existing receipt/);
  assert.equal(f.sends(), 1);
  f.service.stop();
  Object.assign(f, f.make());
  assert.match((await f.run("status")).text, new RegExp(f.id));
  f.control.takeover(f.id, "Human takes over the test");
  assert.match((await f.run("ask another note")).text, /refused/);
  assert.equal(f.sends(), 1);
  for (const file of fs.readdirSync(f.config.bindingsDir))
    assert.equal(fs.statSync(path.join(f.config.bindingsDir, file)).mode & 0o077, 0);
});
test("native command guards protect operator actions before credential reads or RPCs", async (t) => {
  const f = fixture(t);
  for (const args of ["sessions", `delegate ${f.id} 1`])
    for (const patch of [
      { senderIsOwner: false },
      { gatewayClientScopes: ["operator.admin"] },
      { senderId: "foreign" },
      { channelId: "foreign" },
      { accountId: "other" },
      { messageThreadId: "thread" },
    ])
      assert.match((await f.run(args, patch)).text, /refused/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.get(f.id).generation, 1);
});
test("stale generation, unavailable task authority and busy native state cannot delegate", async (t) => {
  const f = fixture(t);
  assert.match((await f.run(`delegate ${f.id} 2`)).text, /refused/);
  f.current.status = "running";
  assert.match((await f.run(`delegate ${f.id} 1`)).text, /refused/);
  f.current.status = "idle";
  f.control.authority = async () => {
    throw Error("Task authority unavailable");
  };
  assert.match((await f.run(`delegate ${f.id} 1`)).text, /refused/);
  assert.equal(f.store.get(f.id).generation, 1);
  assert.equal(f.sends(), 0);
});
test("stopping after handback leaves no reachable binding and does not revoke a subsequent human owner", async (t) => {
  const f = fixture(t);
  f.after = (envelope) => {
    if (envelope.method === "handback") {
      f.service.stop();
      f.control.takeover(f.id, "Human intervenes");
    }
  };
  assert.match((await f.run(`delegate ${f.id} 1`)).text, /refused/);
  assert.equal(f.store.get(f.id).mode, "human");
  assert.equal(f.store.get(f.id).generation, 3);
  assert.equal(fs.existsSync(f.config.bindingsDir), false);
  assert.equal(f.sends(), 0);
});
test("binding persistence failure refuses input, keeps the selected session unchanged and supports explicit recovery", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.config.bindingsDir, { mode: 0o700 });
  const target = path.join(
    f.config.bindingsDir,
    bindingName({ ...commandOrigin(f.config), sessionId: f.id }),
  );
  fs.mkdirSync(target);
  assert.match((await f.run(`delegate ${f.id} 1`)).text, /may already have changed generation/);
  assert.equal(f.store.get(f.id).generation, 2);
  assert.equal(f.workspace.currentOrigin().sessionId, f.config.sessionId);
  assert.match((await f.run("ask must not send")).text, /refused/);
  assert.equal(f.sends(), 0);
  fs.rmdirSync(target);
  assert.match((await f.run(`delegate ${f.id} 2`)).text, /Selected and delegated/);
});
test("concurrent commands refuse, changed durable selection prevents dispatch, corrupt or symlinked selection fails closed", async (t) => {
  const f = fixture(t);
  await f.run(`delegate ${f.id} 1`);
  const selection = path.join(
    f.config.bindingsDir,
    bindingName(commandOrigin(f.config)) + ".selection",
  );
  let release;
  f.after = (envelope) =>
    envelope.method === "inspect"
      ? new Promise((r) => {
          release = r;
        })
      : undefined;
  const pending = f.run("ask race test");
  await new Promise((r) => setImmediate(r));
  assert.match((await f.run("sessions")).text, /still resolving/);
  fs.writeFileSync(
    selection,
    JSON.stringify({ version: 1, origin: commandOrigin(f.config), sessionId: randomUUID() }),
  );
  release();
  assert.match((await pending).text, /refused/);
  assert.equal(f.sends(), 0);
  f.after = undefined;
  fs.writeFileSync(selection, "{}");
  assert.match((await f.run("ask invalid")).text, /refused/);
  fs.unlinkSync(selection);
  fs.symlinkSync(path.join(f.root, "operator.secret"), selection);
  assert.match((await f.run("sessions")).text, /refused/);
});
test("simple commands retain full-envelope validation and strict generation/page syntax", () => {
  for (const args of [
    "sessions 0",
    "sessions -1",
    "sessions 10000",
    "ask ",
    `delegate ${randomUUID()} 0`,
    `delegate ${randomUUID()} 1 extra`,
    "delegate invalid 1",
  ])
    assert.throws(() => parseCommand({ args, commandBody: "/orca " + args }));
  const args = "ask keep\nall constraints";
  assert.equal(parseCommand({ args, commandBody: "/orca " + args }).text, "keep\nall constraints");
  assert.throws(() =>
    parseCommand({ args: "ask shortened", commandBody: "/orca ask full instruction" }),
  );
});
