// Cutover A2: the conversation management-route adapter against a fake daemon. A request that may have been sent and then lost
// is UNCERTAIN with do-not-replay and is never retried; only a failure before sending is definite. One connection per call,
// reconnection disabled, the owner credential read per call with today's checks.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  managementWriter,
  connectOwnedDaemon,
  ownerCredential,
  ownedChild,
  PLUGIN_ID,
} from "./management-client.mjs";
import { OPERATOR_INVOKE_RPC } from "../../orca-organization/shared/operator-invoke-methods.mjs";
const S = "11111111-1111-4111-8111-111111111111",
  input = { sessionId: S, reason: "Adapter acceptance takeover" };
function fakeDaemon(invoke) {
  const log = { connects: 0, invokes: [], closes: 0 };
  return {
    log,
    connect: async () => {
      log.connects++;
      return {
        invoke: (rpc, value) => {
          log.invokes.push([rpc, value]);
          return invoke(rpc, value, log);
        },
        close: () => {
          log.closes++;
        },
      };
    },
  };
}

test("a disconnect after the request is sent is UNCERTAIN, do-not-replay, and never retried", async () => {
  const d = fakeDaemon(async () => {
    throw Error("Transport closed");
  });
  await assert.rejects(
    managementWriter({ connect: d.connect })("takeover", input),
    (e) =>
      e.code === "uncertain" &&
      e.doNotReplay === true &&
      e.dispatched === true &&
      /Do not replay/.test(e.message),
  );
  assert.deepEqual([d.log.connects, d.log.invokes.length, d.log.closes], [1, 1, 1]);
  assert.deepEqual(d.log.invokes[0], [OPERATOR_INVOKE_RPC, { method: "takeover", input }]);
});

test("no reply before the deadline is UNCERTAIN, not retried", async () => {
  const d = fakeDaemon(() => new Promise(() => {}));
  await assert.rejects(
    managementWriter({ connect: d.connect, deadlineMs: 50 })("takeover", input),
    (e) => e.code === "uncertain" && e.doNotReplay,
  );
  assert.deepEqual([d.log.connects, d.log.invokes.length, d.log.closes], [1, 1, 1]);
});

test("a failure before sending is definite: nothing was sent", async () => {
  let invoked = 0;
  await assert.rejects(
    managementWriter({
      connect: async () => {
        throw Error("ECONNREFUSED");
      },
    })("takeover", input),
    (e) => e.code === "unavailable" && e.dispatched === false && /nothing was sent/.test(e.message),
  );
  const d = fakeDaemon(() => {
    invoked++;
  });
  await assert.rejects(
    managementWriter({ connect: d.connect })("list", "x"),
    (e) => e.code === "not_allowed" && e.dispatched === false,
  );
  assert.equal(d.log.connects, 0);
  assert.equal(invoked, 0);
});

test("the route's own replies: definite refusals stay definite; dispatched or malformed replies are uncertain", async () => {
  const reply = (r) =>
    managementWriter({ connect: fakeDaemon(async () => r).connect })("takeover", input);
  assert.equal(await reply({ ok: true, result: { mode: "human" } }).then((r) => r.mode), "human");
  await assert.rejects(
    reply({ ok: false, code: "refused", dispatched: false, message: "Invalid takeover" }),
    (e) => e.code === "refused" && e.dispatched === false && e.message === "Invalid takeover",
  );
  await assert.rejects(
    reply({ ok: false, code: "uncertain", dispatched: true, message: "x" }),
    (e) => e.code === "uncertain" && e.doNotReplay,
  );
  for (const malformed of [undefined, null, {}, { ok: true }, { ok: false, code: "refused" }, "ok"])
    await assert.rejects(
      reply(malformed),
      (e) => e.code === "uncertain",
      JSON.stringify(malformed),
    );
});

test("connectOwnedDaemon: a fresh client per call, reconnection disabled, the owner credential read per call", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mgmt-sdk-")));
  const sdk = path.join(dir, "fake-daemon-client.mjs");
  fs.writeFileSync(
    sdk,
    `export const made = []; export class DaemonClient { constructor(config) { this.config = config; made.push(this); this.calls = []; }
    async connect() { this.connected = true; } async invokePluginRpc(...a) { this.calls.push(a); return { ok: true, result: a[1] }; } async close() { this.closed = true; } }`,
  );
  let reads = 0;
  const credential = () => {
    reads++;
    return "c".repeat(43);
  };
  const a = await connectOwnedDaemon({ sdk, credential, url: "ws://127.0.0.1:1/ws" }),
    b = await connectOwnedDaemon({ sdk, credential, url: "ws://127.0.0.1:1/ws" });
  const { made } = await import(sdk);
  assert.equal(made.length, 2);
  assert.equal(reads, 2);
  for (const client of made) {
    assert.equal(client.config.reconnect.enabled, false);
    assert.equal(client.config.password, "c".repeat(43));
    assert.equal(client.config.clientType, "cli");
  }
  assert.notEqual(made[0].config.clientId, made[1].config.clientId);
  await a.invoke(OPERATOR_INVOKE_RPC, { method: "observe", input: S });
  await a.close();
  await b.close();
  assert.deepEqual(made[0].calls, [
    [PLUGIN_ID, OPERATOR_INVOKE_RPC, { method: "observe", input: S }],
  ]);
  assert.equal(made[0].closed, true);
  assert.equal(made[1].closed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the owner credential is read as today: private, owned, 43 base64url characters", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mgmt-cred-"))),
    file = path.join(dir, "credential");
  const put = (value, mode) => {
    fs.writeFileSync(file, value);
    fs.chmodSync(file, mode);
  };
  put("a".repeat(43) + "\n", 0o600);
  assert.equal(ownerCredential(file), "a".repeat(43));
  put("a".repeat(43), 0o640);
  assert.throws(() => ownerCredential(file), /Invalid native credential/);
  put("short", 0o600);
  assert.throws(() => ownerCredential(file), /Invalid native credential/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the route is selected only by ORCA_CONTROLLER_TOPOLOGY=owned-child", () => {
  assert.equal(ownedChild({}), false);
  assert.equal(ownedChild({ ORCA_CONTROLLER_TOPOLOGY: "legacy" }), false);
  assert.equal(ownedChild({ ORCA_CONTROLLER_TOPOLOGY: "owned-child" }), true);
});
