import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createChildSupervisor } from "./child-supervisor.mjs";

function fixture() {
  const children = [],
    channels = [],
    timers = [],
    recovered = [];
  function spawn() {
    const child = new EventEmitter();
    child.pid = 100 + children.length;
    child.sent = [];
    child.killed = false;
    child.send = (frame) => {
      child.sent.push(frame);
    };
    child.kill = () => {
      child.killed = true;
    };
    children.push(child);
    return child;
  }
  const supervisor = createChildSupervisor({
    boot: "boot-test",
    spawn,
    createChannel(child, send) {
      const channel = {
        epoch: `epoch-${channels.length}`,
        revoked: false,
        async receive(arrival, frame) {
          assert.equal(arrival, child);
          return { id: frame.id, epoch: this.epoch, ok: true, result: null };
        },
        management(command, principal) {
          return send({
            id: "command-1",
            epoch: this.epoch,
            type: "management",
            command,
            principal,
          });
        },
        close() {
          this.revoked = true;
        },
      };
      channels.push(channel);
      return channel;
    },
    recover: (child) => {
      recovered.push(child);
    },
    schedule(fn) {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  const ready = (child) =>
    child.emit("message", {
      type: "ready",
      contract: "1.1",
      boot: "boot-test",
      epoch: channels.at(-1).epoch,
    });
  return { supervisor, children, channels, timers, recovered, ready };
}

async function stop(f) {
  const done = f.supervisor.stop();
  f.children.at(-1)?.emit("exit", 0, null);
  await done;
}

test("an idle supervisor spawns no child; ready requires the exact boot, contract and epoch", async () => {
  const f = fixture();
  assert.equal(f.children.length, 0);
  assert.equal(f.supervisor.ready, false);
  f.supervisor.start();
  f.supervisor.start();
  assert.equal(f.children.length, 1);
  const child = f.children[0];
  child.emit("message", {
    type: "ready",
    contract: "1.1",
    boot: "old",
    epoch: f.channels[0].epoch,
  });
  assert.equal(f.supervisor.ready, false);
  f.ready(child);
  assert.equal(f.supervisor.ready, true);
  await stop(f);
  assert.equal(f.supervisor.ready, false);
  assert.equal(child.killed, true);
});

test("a crash rejects pending work as uncertain and never replays it", async () => {
  const f = fixture();
  f.supervisor.start();
  f.ready(f.children[0]);
  const result = f.supervisor.management({ method: "send" }, {}).catch((e) => e);
  f.children[0].emit("exit", 1, null);
  const error = await result;
  assert.equal(error.code, "uncertain");
  assert.equal(f.channels[0].revoked, true);
  assert.equal(f.supervisor.ready, false);
  assert.equal(f.recovered.length, 1);
  f.timers.shift()();
  f.ready(f.children[1]);
  assert.equal(f.children[1].sent.filter((x) => x.type === "management").length, 0);
  await stop(f);
});

test("old/non-owned arrivals cannot ready or send replies through the replacement", async () => {
  const f = fixture();
  f.supervisor.start();
  const old = f.children[0];
  f.ready(old);
  old.emit("exit", 1, null);
  f.timers.shift()();
  const current = f.children[1];
  old.emit("message", {
    type: "ready",
    contract: "1.1",
    boot: "boot-test",
    epoch: f.channels[1].epoch,
  });
  assert.equal(f.supervisor.ready, false);
  old.emit("message", { type: "rpc", id: "stale", epoch: f.channels[0].epoch, frame: {} });
  await Promise.resolve();
  assert.equal(current.sent.length, 1);
  f.ready(current);
  assert.equal(f.supervisor.ready, true);
  await stop(f);
});

test("restarts are bounded, stop cancels backoff, and recovery requires observed exit", async () => {
  const f = fixture();
  f.supervisor.start();
  f.children[0].emit("disconnect");
  assert.equal(f.recovered.length, 0);
  assert.equal(f.children.length, 1);
  for (let i = 0; i < 4; i++) {
    f.children[i].emit("exit", 1, null);
    if (i < 3) f.timers.shift()();
  }
  assert.equal(f.children.length, 4);
  assert.equal(f.timers.length, 0);
  await stop(f);
  f.supervisor.start();
  assert.equal(f.children.length, 4);
});

test("a reply with wrong epoch cannot settle a pending command", async () => {
  const f = fixture();
  f.supervisor.start();
  const child = f.children[0];
  f.ready(child);
  let settled = false;
  const pending = f.supervisor
    .management({ method: "send" }, {})
    .finally(() => {
      settled = true;
    })
    .catch((e) => e);
  child.emit("message", { id: "command-1", epoch: "stale", ok: true, result: null });
  await Promise.resolve();
  assert.equal(settled, false);
  await stop(f);
  assert.equal((await pending).code, "uncertain");
});

test("the management forwarder is stable and does not capture an old child or receiver", async () => {
  const f = fixture(),
    bridge = f.supervisor.management;
  await assert.rejects(bridge({}, {}), /unavailable/);
  f.supervisor.start();
  f.ready(f.children[0]);
  for (let i = 0; i < 2; i++) {
    const reply = { id: "command-1", epoch: f.channels[i].epoch, ok: true, result: i };
    const pending = bridge({ method: "send" }, {});
    f.children[i].emit("message", reply);
    assert.deepEqual(await pending, reply);
    if (i === 0) {
      f.children[i].emit("exit", 1, null);
      f.timers.shift()();
      f.ready(f.children[1]);
    }
  }
  await stop(f);
});

test("stable readiness resets the crash budget but repeated ready messages cannot reset its timer", async () => {
  const f = fixture();
  f.supervisor.start();
  for (let i = 0; i < 6; i++) {
    const child = f.children.at(-1);
    f.ready(child);
    const stable = f.timers[0];
    assert.equal(typeof stable, "function");
    f.ready(child);
    assert.equal(f.timers[0], stable);
    assert.equal(f.timers.length, 1);
    f.timers.shift()();
    child.emit("exit", 1, null);
    assert.equal(f.timers.length, 1);
    f.timers.shift()();
  }
  assert.equal(f.children.length, 7);
  await stop(f);
});

test("IR-5/7 real startup has a separate bounded window and inner calls finish before RPC expiry", async () => {
  const delays = [],
    child = new EventEmitter();
  child.send = () => {};
  child.kill = () => {};
  const s = createChildSupervisor({
    boot: "fixture",
    spawn: () => child,
    recover() {},
    createChannel: (_, send) => ({
      epoch: "epoch",
      close() {},
      management: () => send({ id: "x" }),
    }),
    schedule(fn, ms) {
      delays.push(ms);
      return () => {};
    },
  });
  s.start();
  assert.equal(delays[0], 15000);
  child.emit("message", {
    type: "service-ready",
    boot: "fixture",
    contract: "1.1",
    epoch: "epoch",
  });
  assert.ok(delays.includes(180000), "bounded SDK/catalog/controller startup window");
  child.emit("message", { type: "ready", boot: "fixture", contract: "1.1", epoch: "epoch" });
  const pending = s.management({}, {}).catch((e) => e);
  assert.equal(delays.at(-1), 15000, "inner request deadline is 15 seconds");
  child.emit("exit", 1);
  await pending;
});

test("IR-5 exhausted retries are visible and an explicit Retry starts one new attempt", async () => {
  const f = fixture();
  f.supervisor.start();
  for (let i = 0; i < 4; i++) {
    f.children.at(-1).emit("exit", 1);
    if (i < 3) f.timers.shift()();
  }
  assert.equal(f.supervisor.status.state, "failed");
  f.supervisor.retry();
  assert.equal(f.children.length, 5);
  f.supervisor.retry();
  assert.equal(f.children.length, 5);
  f.ready(f.children.at(-1));
  assert.equal(f.supervisor.status.state, "ready");
  await stop(f);
});
