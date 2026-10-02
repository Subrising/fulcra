// Fulcra CONTRACTS v1.6 §3.6 / §3.2 #6 (prime decision S-1): the owner is proven only by a paired device. Holding
// the operator secret (every call here goes through the real operator gate) is the `operator`, never the owner.
// Test keys are P-256 from node:crypto and WebCrypto; nothing touches a keychain.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { fixture, level1, option, P, deviceKey, signed } from "./decisions.fixture.mjs";
import {
  PURPOSE,
  PAIRING_WINDOW_MS,
  PAIRING_OFF,
  FIRST_DEVICE_PAIRING,
  HOST_DEVICE_FEATURE,
  Devices,
  isDer,
} from "./devices.mjs";
import { PAIR_OPEN_PURPOSE } from "./inbox-channels.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIRM_ON_DEVICE, OPERATOR_LABEL } from "./decisions.mjs";
import { canonicalJson } from "../../orca-organization/shared/cc/decision-rules.mjs";
import { requireUnpinnedAdmissionGuard } from "./admission-guard-precondition.mjs";
requireUnpinnedAdmissionGuard();

const clocked = async (t) => {
  const c = { now: Date.now() };
  const f = await fixture(t, { now: () => c.now });
  return { f, c };
};
const approvalPacket = (f, digest) => ({
  kind: "approval",
  level: 2,
  projectId: P(1),
  taskId: null,
  askedOf: "human",
  title: "Put the new version in front of customers?",
  situation: "The new version passed its checks.",
  options: [option("approve"), option("reject")],
  recommendation: null,
  evidence: [],
  action: { type: "promotion", promotionId: randomUUID(), digest },
});
const boundApproval = async (f) => {
  f.control.decisions.binders.set("promotion", async () => ({ plan: 1 }));
  const { createHash } = await import("node:crypto");
  return (
    await f.ask(
      approvalPacket(
        f,
        createHash("sha256")
          .update(canonicalJson({ plan: 1 }))
          .digest("hex"),
      ),
    )
  ).decision;
};
const answer = (f, d, optionId, proof, messageId = proof?.payload.messageId ?? randomUUID()) =>
  f.op("decisions-choose", {
    messageId,
    id: d.id,
    expectedRevision: d.revision,
    optionId,
    note: "",
    confirmDestructive: false,
    ...(proof ? { proof } : {}),
  });

test("a valid proof from an active paired device records the owner (human, proven, deviceId); raw and DER signatures both verify", async (t) => {
  const { f } = await clocked(t);
  const dev = await f.pairFirst();
  const a = (await f.ask(level1())).decision;
  const { proof } = f.proofFor(dev, a, "a");
  const r = await answer(f, a, "a", proof);
  assert.deepEqual(
    [
      r.decision.choice.by,
      r.decision.choice.proven,
      r.decision.choice.deviceId,
      r.decision.choice.via,
    ],
    ["human", true, dev.id, "app-mac"],
  );
  // A WebCrypto key (what an app runtime produces) signing the raw r||s form, and the DER form Apple's APIs produce.
  const b = (await f.ask(level1({ title: "Open the shop on Sundays?" }))).decision;
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", pair.publicKey)).toString(
    "base64",
  );
  // Pair it as a later device, approved by the first one.
  const device = {
    label: "Test Phone",
    platform: "ios",
    publicKey: spki,
    keyStorage: "keychain-biometric",
    userPresence: true,
  };
  const approve = {
    purpose: PURPOSE.approve,
    device,
    messageId: randomUUID(),
    at: new Date().toISOString(),
  };
  const web = async (payload) =>
    Buffer.from(
      await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        Buffer.from(canonicalJson(payload)),
      ),
    ).toString("base64");
  const phone = (
    await f.op("devices-pair-approve", {
      device,
      approval: {
        deviceId: dev.id,
        alg: "ES256",
        payload: approve,
        signature: signed(dev.key, approve),
      },
      signature: await web(approve),
    })
  ).device;
  const payload = {
    decisionId: b.id,
    revision: b.revision,
    optionId: "b",
    digest: null,
    messageId: randomUUID(),
    note: "",
    confirmDestructive: false,
    at: new Date().toISOString(),
  };
  const viaWeb = await answer(f, b, "b", {
    deviceId: phone.id,
    alg: "ES256",
    payload,
    signature: await web(payload),
  });
  assert.deepEqual(
    [viaWeb.decision.choice.by, viaWeb.decision.choice.deviceId, viaWeb.decision.choice.via],
    ["human", phone.id, "app-ios"],
    "v1.8 R2-6: via is the device platform",
  );
  const c = (await f.ask(level1({ title: "Hire a second designer?" }))).decision;
  const p3 = {
    decisionId: c.id,
    revision: c.revision,
    optionId: "a",
    digest: null,
    messageId: randomUUID(),
    note: "",
    confirmDestructive: false,
    at: new Date().toISOString(),
  };
  assert.equal(
    (
      await answer(f, c, "a", {
        deviceId: dev.id,
        alg: "ES256",
        payload: p3,
        signature: signed(dev.key, p3, "der"),
      })
    ).decision.choice.by,
    "human",
  );
  // v1.8 R2-6: a claimed app platform is ignored for a proven answer; the macOS device's platform wins.
  const e = (await f.ask(level1({ title: "Move the sale to Friday?" }))).decision,
    pe = f.proofFor(dev, e, "a");
  const claimed = await f.op("decisions-choose", {
    messageId: pe.messageId,
    id: e.id,
    expectedRevision: e.revision,
    optionId: "a",
    note: "",
    confirmDestructive: false,
    via: "app-ios",
    proof: pe.proof,
  });
  assert.equal(claimed.decision.choice.via, "app-mac");
  // v1.8 R2-12: the encoding is parsed, so a DER signature of exactly 64 bytes is recognised as DER.
  const der64 = Buffer.concat([
    Buffer.from([0x30, 62, 0x02, 29]),
    Buffer.alloc(29, 1),
    Buffer.from([0x02, 29]),
    Buffer.alloc(29, 2),
  ]);
  assert.equal(der64.length, 64);
  assert.equal(isDer(der64), true);
  assert.equal(isDer(Buffer.alloc(64, 7)), false);
  // The asker is told the owner confirmed it.
  await f.control.decisions.delivering;
  await f.control.decisions.pump();
  assert.match(
    f.sends.find((s) => s.text.includes(a.id)).text,
    /"by":"human","proven":true[\s\S]*The owner answered your decision, confirmed on a paired device/,
  );
});

test("forged, replayed, stale, wrong-payload and revoked-device proofs never count as the owner", async (t) => {
  const { f, c } = await clocked(t);
  const dev = await f.pairFirst();
  const other = deviceKey();
  // v1.8 R2-5: a proof that is sent but fails refuses the answer with the reason, and nothing is recorded.
  const refused = async (label, build, extra = {}) => {
    const d = (await f.ask(level1({ title: `Pick a colour for sign ${label}?`, ...extra })))
      .decision;
    const { proof, messageId } = await build(d);
    const err = await answer(f, d, "a", proof, messageId).then(
      () => null,
      (e) => e,
    );
    assert.match(
      err?.message ?? "",
      /^Your device's confirmation did not check out: .*\. Nothing was recorded; confirm again on your device$/,
      label,
    );
    assert.deepEqual(
      [f.control.decisions.packet(d.id).state, f.control.decisions.packet(d.id).choice],
      ["open", null],
      label,
    );
    return err.message;
  };
  // Forged: right device id, signed by a key that is not the device's.
  assert.match(
    await refused("forged", (d) => {
      const { proof, messageId } = f.proofFor(dev, d, "a");
      return { messageId, proof: { ...proof, signature: signed(other, proof.payload) } };
    }),
    /signature does not verify/,
  );
  // Replayed: a real proof for one answer, presented with another request.
  const first = (await f.ask(level1({ title: "Move the launch a week?" }))).decision;
  const original = f.proofFor(dev, first, "a");
  assert.equal((await answer(f, first, "a", original.proof)).decision.choice.by, "human");
  assert.match(
    await refused("replayed", () => ({ messageId: randomUUID(), proof: original.proof })),
    /does not match/,
  );
  // Stale: signed six minutes ago.
  assert.match(
    await refused("stale", (d) =>
      f.proofFor(dev, d, "a", { at: new Date(c.now - 6 * 60000).toISOString() }),
    ),
    /too old/,
  );
  // Wrong payload: signed for option b, sent as option a; or for an older revision; or with another note.
  assert.match(await refused("wrong option", (d) => f.proofFor(dev, d, "b")), /does not match/);
  assert.match(
    await refused("wrong revision", (d) => f.proofFor(dev, d, "a", { revision: d.revision + 1 })),
    /does not match/,
  );
  assert.match(
    await refused("wrong note", (d) => f.proofFor(dev, d, "a", { note: "something else" })),
    /does not match/,
  );
  // Revoked: the device revokes itself; its later proofs are the operator.
  const rev = {
    purpose: PURPOSE.revoke,
    deviceId: dev.id,
    messageId: randomUUID(),
    at: new Date(c.now).toISOString(),
  };
  await f.op("devices-revoke", {
    proof: { deviceId: dev.id, alg: "ES256", payload: rev, signature: signed(dev.key, rev) },
  });
  assert.match(await refused("revoked", (d) => f.proofFor(dev, d, "a")), /not paired/);
  // An answer sent with no proof at all is the operator's, and carries the operator label to the asker.
  const plain = (await f.ask(level1({ title: "Paint the door blue?" }))).decision;
  assert.deepEqual([(await answer(f, plain, "a")).decision.choice.by], ["operator"]);
  await f.control.decisions.delivering;
  await f.control.decisions.pump();
  assert(f.sends.some((s) => s.text.includes(`Your decision was ${OPERATOR_LABEL}`)));
});

test("an approval that binds an action refuses any answer without a valid owner proof", async (t) => {
  const { f } = await clocked(t);
  const dev = await f.pairFirst();
  const d = await boundApproval(f);
  await assert.rejects(answer(f, d, "approve"), new RegExp(CONFIRM_ON_DEVICE));
  const { proof, messageId } = f.proofFor(dev, d, "approve");
  await assert.rejects(
    answer(f, d, "approve", { ...proof, signature: signed(deviceKey(), proof.payload) }, messageId),
    /did not check out: The device signature does not verify/,
    "a forged proof is no proof",
  );
  assert.equal(f.control.decisions.packet(d.id).state, "open");
  const ok = await answer(f, d, "approve", proof, messageId);
  assert.deepEqual([ok.decision.choice.by, ok.decision.choice.proven], ["human", true]);
  // The proof covered the digest the owner saw.
  assert.equal(proof.payload.digest, d.action.digest);
});

test("the first-device window: operator-opened, 10 minutes, once, bounded guessing, and never once a device exists", async (t) => {
  const { f, c } = await clocked(t);
  const key = deviceKey(),
    device = {
      label: "Test Mac",
      platform: "macos",
      publicKey: key.publicKey,
      keyStorage: "os-protected",
      userPresence: true,
    };
  const complete = (w, code = w.code, k = key) => {
    const payload = {
      purpose: PURPOSE.pair,
      windowId: w.windowId,
      code,
      device,
      messageId: randomUUID(),
      at: new Date(c.now).toISOString(),
    };
    return f.op("devices-pair-complete", { payload, signature: signed(k, payload) });
  };
  // Expiry.
  let w = await f.op("devices-pair-open", null);
  c.now += PAIRING_WINDOW_MS + 1000;
  await assert.rejects(complete(w), /No pairing window is open/);
  // Possession: the request must be signed by the key being registered.
  w = await f.op("devices-pair-open", null);
  await assert.rejects(complete(w, w.code, deviceKey()), /signature does not verify/);
  // Bounded guessing: five wrong codes close the window, even for the right code afterwards.
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      complete(w, w.code === "000000" ? "111111" : "000000"),
      /not right|No pairing window/,
    );
  await assert.rejects(complete(w), /No pairing window is open/);
  // Used once.
  w = await f.op("devices-pair-open", null);
  const paired = (await complete(w)).device;
  assert.deepEqual(
    [paired.label, paired.pairedVia.kind, paired.state],
    ["Test Mac", "first-device", "active"],
  );
  assert.equal(
    f.store.db.prepare("SELECT usedBy FROM cc_pairing_windows WHERE id=?").get(w.windowId).usedBy,
    paired.id,
  );
  await assert.rejects(complete(w), /No pairing window is open|already paired/);
  // With a device paired, the operator can no longer open a window at all.
  await assert.rejects(f.op("devices-pair-open", null), /already paired/);
  // The code is never stored in the journal.
  assert(
    !JSON.stringify(f.store.db.prepare("SELECT * FROM cc_pairing_windows").all()).includes(w.code),
  );
});

test("a later device needs an approval signed by an active device, plus its own signature; revocation is signed too", async (t) => {
  const { f, c } = await clocked(t);
  const dev = await f.pairFirst();
  const key = deviceKey(),
    device = {
      label: "Test Phone",
      platform: "ios",
      publicKey: key.publicKey,
      keyStorage: "keychain-biometric",
      userPresence: true,
    };
  const approval = (signer = dev.key, extra = {}) => {
    const payload = {
      purpose: PURPOSE.approve,
      device,
      messageId: randomUUID(),
      at: new Date(c.now).toISOString(),
      ...extra,
    };
    return {
      payload,
      request: {
        device,
        approval: { deviceId: dev.id, alg: "ES256", payload, signature: signed(signer, payload) },
        signature: signed(key, payload),
      },
    };
  };
  await assert.rejects(
    f.op("devices-pair-approve", approval(deviceKey()).request),
    /signature does not verify/,
    "not signed by the paired device",
  );
  const wrongPurpose = approval(dev.key, { purpose: PURPOSE.revoke });
  await assert.rejects(
    f.op("devices-pair-approve", wrongPurpose.request),
    /Invalid device signature/,
    "a signature for another act",
  );
  const good = approval();
  const phone = (await f.op("devices-pair-approve", good.request)).device;
  assert.deepEqual(
    [phone.pairedVia, phone.userPresence],
    [{ kind: "approved", byDeviceId: dev.id }, true],
  );
  await assert.rejects(
    f.op("devices-pair-approve", good.request),
    /already used|already paired/,
    "an approval works once",
  );
  // Revocation needs a signature from an active device.
  const rev = (signerKey, signerId, target) => {
    const payload = {
      purpose: PURPOSE.revoke,
      deviceId: target,
      messageId: randomUUID(),
      at: new Date(c.now).toISOString(),
    };
    return {
      proof: { deviceId: signerId, alg: "ES256", payload, signature: signed(signerKey, payload) },
    };
  };
  await assert.rejects(
    f.op("devices-revoke", rev(deviceKey(), dev.id, phone.id)),
    /signature does not verify/,
  );
  const done = await f.op("devices-revoke", rev(dev.key, dev.id, phone.id));
  assert.equal(done.device.state, "revoked");
  await assert.rejects(
    f.op("devices-revoke", rev(key, phone.id, dev.id)),
    /signing device is not paired/,
    "a revoked device signs nothing",
  );
  const list = await f.op("devices-list", null);
  assert.deepEqual(
    list.devices.map((d) => [d.label, d.state]),
    [
      ["Test Mac", "active"],
      ["Test Phone", "revoked"],
    ],
  );
});

test("every pairing and revocation is announced: an urgent inbox item and a line in the daily digest", async (t) => {
  const at8 = new Date();
  at8.setHours(8, 0, 0, 0);
  const c = { now: at8.getTime() - 3600000 };
  const f = await fixture(t, { now: () => c.now });
  const dev = await f.pairFirst("Test Mac");
  const key = deviceKey(),
    device = {
      label: "Test Phone",
      platform: "ios",
      publicKey: key.publicKey,
      keyStorage: "keychain-biometric",
      userPresence: true,
    };
  const payload = {
    purpose: PURPOSE.approve,
    device,
    messageId: randomUUID(),
    at: new Date(c.now).toISOString(),
  };
  const phone = (
    await f.op("devices-pair-approve", {
      device,
      approval: { deviceId: dev.id, alg: "ES256", payload, signature: signed(dev.key, payload) },
      signature: signed(key, payload),
    })
  ).device;
  const rev = {
    purpose: PURPOSE.revoke,
    deviceId: phone.id,
    messageId: randomUUID(),
    at: new Date(c.now).toISOString(),
  };
  await f.op("devices-revoke", {
    proof: { deviceId: dev.id, alg: "ES256", payload: rev, signature: signed(dev.key, rev) },
  });
  const inbox = await f.op("decisions-inbox", null);
  const notices = inbox.items.filter((i) => i.key.startsWith("attention-device-"));
  assert.equal(notices.length, 3);
  assert(notices.every((n) => n.urgency === "now" && n.unread));
  assert(
    notices.some(
      (n) =>
        /^A new device was paired at \d\d:\d\d: Test Phone · iPhone · Protected by Face ID or Touch ID$/.test(
          n.title,
        ) && n.summary === "Not you? Revoke it in Settings › Devices.",
    ),
  );
  assert(
    notices.some((n) =>
      /^A device was revoked at \d\d:\d\d: Test Phone · iPhone · Protected by Face ID or Touch ID$/.test(
        n.title,
      ),
    ),
  );
  c.now = at8.getTime() + 60000;
  await f.control.decisions.composeDue();
  const digest = JSON.parse(
    f.store.db.prepare("SELECT json FROM cc_digests WHERE projectId IS NULL").get().json,
  );
  assert.deepEqual(digest.devices.map((d) => [d.label, d.action]).sort(), [
    ["Test Mac", "paired"],
    ["Test Phone", "paired"],
    ["Test Phone", "revoked"],
  ]);
  assert.match(digest.summary, /a new device, Test Phone, was paired/);
});

test("R3-1 (v1.13 §3.6 rule 3): no file turns pairing on; the operator path cannot pair any device or owner-capable channel, and nothing becomes the owner", async (t) => {
  const { f, c } = await clocked(t);
  // Production construction (as server.mjs does it): the compiled constant, and the host's flag read by the controller.
  assert.equal(
    FIRST_DEVICE_PAIRING,
    false,
    "this build ships with first-device pairing compiled off",
  );
  let hostSays = true;
  f.control.native = {
    ...f.control.native,
    hostFeature: (name) => name === HOST_DEVICE_FEATURE && hostSays,
  };
  f.control.devices = new Devices(f.control, { now: () => c.now });
  // Whatever a same-user process writes into the controller home (the old mode file included) changes nothing.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-pairing-mode-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const name of [
    "device-pairing.mode",
    "pairing.mode",
    "pairing",
    "device-pairing.json",
    "first-device",
    "operator.override",
  ])
    fs.writeFileSync(path.join(home, name), "on\n", { mode: 0o600 });
  f.control.humanLogDir = home;
  assert.equal(f.control.devices.pairingEnabled(), false);
  await assert.rejects(f.op("devices-pair-open", null), new RegExp(PAIRING_OFF));
  // Even a well-formed completion with a self-made key has no window to use.
  const key = deviceKey(),
    device = {
      label: "iPhone",
      platform: "ios",
      publicKey: key.publicKey,
      keyStorage: "keychain-biometric",
      userPresence: true,
    };
  const payload = {
    purpose: PURPOSE.pair,
    windowId: randomUUID(),
    code: "123456",
    device,
    messageId: randomUUID(),
    at: new Date(c.now).toISOString(),
  };
  await assert.rejects(
    f.op("devices-pair-complete", { payload, signature: signed(key, payload) }),
    new RegExp(PAIRING_OFF),
  );
  // An owner-capable chat channel window is gated the same way.
  const scope = { projects: "all", canAnswer: true, levels: [1, 2, 3] },
    p2 = {
      purpose: PAIR_OPEN_PURPOSE,
      kind: "discord-openclaw",
      label: "Chat",
      scope,
      messageId: randomUUID(),
      at: new Date(c.now).toISOString(),
    };
  await assert.rejects(
    f.op("cc-channel-pair-open", {
      kind: "discord-openclaw",
      label: "Chat",
      scope,
      proof: { deviceId: randomUUID(), alg: "ES256", payload: p2, signature: signed(key, p2) },
    }),
    new RegExp(PAIRING_OFF),
  );
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM cc_devices").get().n, 0);
  // So no answer can be the owner's: a self-signed proof never yields human, and a bound approval stays unanswered.
  const d = (await f.ask(level1())).decision;
  const pd = {
    decisionId: d.id,
    revision: 1,
    optionId: "a",
    digest: null,
    messageId: randomUUID(),
    note: "",
    confirmDestructive: false,
    at: new Date(c.now).toISOString(),
  };
  const r = await answer(f, d, "a", {
    deviceId: randomUUID(),
    alg: "ES256",
    payload: pd,
    signature: signed(key, pd),
  }).catch((e) => e);
  assert.notEqual(f.control.decisions.packet(d.id).choice?.by, "human", String(r?.message ?? ""));
  const bound = await boundApproval(f);
  await assert.rejects(answer(f, bound, "approve"), new RegExp(CONFIRM_ON_DEVICE));
  // Both halves are needed: a release that allows it AND the host's own device flag, checked in the controller.
  assert.equal(
    new Devices(f.control, { now: () => c.now, release: true }).pairingEnabled(),
    true,
    "release + host flag",
  );
  hostSays = false;
  assert.equal(
    new Devices(f.control, { now: () => c.now, release: true }).pairingEnabled(),
    false,
    "the host does not offer ctx.device",
  );
  f.control.native = {
    ...f.control.native,
    hostFeature: () => {
      throw Error("daemon gone");
    },
  };
  assert.equal(
    new Devices(f.control, { now: () => c.now, release: true }).pairingEnabled(),
    false,
    "an unreadable host is off",
  );
  hostSays = true;
  f.control.native = {
    ...f.control.native,
    hostFeature: (name) => name === HOST_DEVICE_FEATURE && hostSays,
  };
  assert.equal(
    new Devices(f.control, { now: () => c.now, release: "true" }).pairingEnabled(),
    false,
    "only the literal constant true",
  );
  // server.mjs constructs Devices with no options at all.
  assert.match(
    fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8"),
    /control\.devices = new Devices\(control\);/,
  );
});

test("R2-11 (v1.8): the second tap is signed: a proof without confirmDestructive cannot carry a destructive choice", async (t) => {
  const { f } = await clocked(t);
  const dev = await f.pairFirst();
  const d = (await f.ask(level1({ options: [option("a"), option("b", { destructive: true })] })))
    .decision;
  const unsigned = f.proofFor(dev, d, "b"); // signed with confirmDestructive: false
  await assert.rejects(
    f.op("decisions-choose", {
      messageId: unsigned.messageId,
      id: d.id,
      expectedRevision: d.revision,
      optionId: "b",
      note: "",
      confirmDestructive: true,
      proof: unsigned.proof,
    }),
    /does not match this answer/,
  );
  const tapped = f.proofFor(dev, d, "b", { confirmDestructive: true });
  const r = await f.op("decisions-choose", {
    messageId: tapped.messageId,
    id: d.id,
    expectedRevision: d.revision,
    optionId: "b",
    note: "",
    confirmDestructive: true,
    proof: tapped.proof,
  });
  assert.deepEqual([r.decision.choice.by, r.decision.choice.optionId], ["human", "b"]);
});

test("R2-9 and R2-10 (v1.8): a legacy owner answer without proof reads as the operator; a malformed approval is refused cleanly", async (t) => {
  const { f } = await clocked(t);
  const d = (await f.ask(level1())).decision;
  const legacy = {
    ...d,
    state: "chosen",
    revision: 2,
    choice: {
      optionId: "a",
      by: "human",
      at: new Date().toISOString(),
      note: "",
      via: "app-mac",
      channelId: null,
    },
  };
  f.store.db
    .prepare("UPDATE cc_decisions SET state='chosen',revision=2,json=? WHERE id=?")
    .run(JSON.stringify(legacy), d.id);
  const read = (await f.op("decisions-get", { id: d.id })).decision.choice;
  assert.deepEqual([read.by, read.proven, read.deviceId], ["operator", false, null]);
  for (const approval of [null, "x", { deviceId: randomUUID() }]) {
    const device = {
      label: "Test Phone",
      platform: "ios",
      publicKey: deviceKey().publicKey,
      keyStorage: "keychain-biometric",
      userPresence: true,
    };
    await assert.rejects(
      f.op("devices-pair-approve", { device, approval, signature: "AAAA" }),
      /^Error: Invalid pairing approval$/,
    );
  }
});

test("R2-3 and R2-7 (v1.8): the digest and the list never show an operator answer as the owner's", async (t) => {
  const at8 = new Date();
  at8.setHours(8, 0, 0, 0);
  const c = { now: at8.getTime() - 3600000 };
  const f = await fixture(t, { now: () => c.now });
  const dev = await f.pairFirst();
  const mine = (await f.ask(level1({ title: "Open the shop on Sundays?" }))).decision;
  const theirs = (await f.ask(level1({ title: "Hire a second designer?" }))).decision;
  await f.chooseProven(dev, mine, "a");
  await f.choose(theirs, "b");
  const list = (await f.op("decisions-inbox", null)).items;
  assert.match(
    list.find((i) => i.key === `decision-${mine.id}`).summary,
    /^You decided on Mac at \d\d:\d\d: Option A\.$/,
  );
  assert.match(
    list.find((i) => i.key === `decision-${theirs.id}`).summary,
    /^Answered by the operator at \d\d:\d\d, not confirmed on your device: Option B\.$/,
  );
  c.now = at8.getTime() + 60000;
  await f.control.decisions.composeDue();
  const digest = JSON.parse(
    f.store.db.prepare("SELECT json FROM cc_digests WHERE projectId IS NULL").get().json,
  );
  assert.deepEqual(digest.decisions.chosen.map((x) => [x.title, x.by, x.proven]).sort(), [
    ["Hire a second designer?", "operator", false],
    ["Open the shop on Sundays?", "human", true],
  ]);
  assert.match(
    digest.summary,
    /You decided 1 question, 1 question answered by the operator, not confirmed on your device[,.]/,
  );
});
