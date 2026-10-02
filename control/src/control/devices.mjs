// Fulcra Command Centre (CONTRACTS.md v1.6 §3.6, prime decision S-1): paired devices, the only way an app answer
// counts as the owner (`human`). Holding operator.secret is NOT proof: any process running as the same macOS user
// can read it. A device holds a P-256 key that never leaves it (keychain / Secure Enclave, confirmed with Touch ID or
// Face ID where the device has it) and signs each answer; this module verifies the signature. Everything here is
// reached through the operator gate (the plugin's socket path), and every write except opening the first-device
// window carries a device signature, so the operator secret alone can open a window and nothing else.
import {
  randomUUID,
  randomInt,
  createPublicKey,
  verify as verifySignature,
  timingSafeEqual,
} from "node:crypto";
import { uuid } from "./authority.mjs";
import { assertColumns } from "./schema.mjs";
import { canonicalJson } from "../../orca-organization/shared/cc/decision-rules.mjs";
import { personalMatch } from "../../orca-organization/shared/cc/refs.mjs";
import { hash } from "./store.mjs";
const keys = (a, names) =>
  a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).sort().join() === names;
export const PLATFORMS = Object.freeze(["macos", "ios", "android", "windows", "linux"]);
export const KEY_STORAGE = Object.freeze([
  "secure-enclave",
  "keychain-biometric",
  "android-keystore",
  "os-protected",
  "software",
]);
export const PAIRING_WINDOW_MS = 10 * 60000;
export const PROOF_WINDOW_MS = 5 * 60000;
const MAX_CODE_TRIES = 5,
  MAX_DEVICES = 32,
  MAX_HISTORY = 5000;
// What each signed write signs: canonical JSON of its payload, whose `purpose` names the act, so a signature made
// for one act can never be replayed as another (CONTRACT-CHANGE-J3-1).
export const PURPOSE = Object.freeze({
  pair: "fulcra.device.pair",
  approve: "fulcra.device.approve",
  revoke: "fulcra.device.revoke",
});
const DEVICE_COLUMNS =
  "id,label,platform,publicKey,alg,keyStorage,userPresence,pairedAt,pairedVia,state,revokedAt,lastUsedAt,revision";
const HISTORY_COLUMNS = "id,entityId,action,before,after,previousRevision,revision,actor,note,at";
const WINDOW_COLUMNS = "id,openedBy,openedAt,expiresAt,usedBy";
export class ProofRefused extends Error {}
// CONTRACTS v1.13 §3.6 rule 3 (R-A blocker R3-1): how "on" is decided. There is NO writable switch: J3's
// device-pairing.mode file is gone, and nothing a same-user process can write turns pairing on. First-device pairing
// needs BOTH
//   - this release-time constant, compiled into the controller: false until the P1 release that also ships the
//     permission-overlay deny on the controller home; and
//   - the host advertising the device capability (`devicePairing` in the native daemon's server-info features),
//     checked here in the controller over its own verified daemon connection, not only in the plugin server.
// Owner-capable chat channels (opened with a device proof) are gated the same way.
export const FIRST_DEVICE_PAIRING = false;
export const HOST_DEVICE_FEATURE = "devicePairing";
export const PAIRING_OFF = "Pairing arrives with the next Fulcra update";

// ES256 over canonical JSON. The signature is base64 of either the raw 64-byte r||s form (WebCrypto) or DER (Apple's
// Security framework); both are accepted, nothing else. The key must be a P-256 SPKI.
export function publicKeyFrom(spkiBase64) {
  if (
    typeof spkiBase64 !== "string" ||
    spkiBase64.length > 400 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(spkiBase64)
  )
    throw new ProofRefused("The device key is not a public key");
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
  } catch {
    throw new ProofRefused("The device key is not a public key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new ProofRefused("The device key must be P-256");
  return key;
}
export function verifies(spkiBase64, payload, signatureBase64) {
  if (
    typeof signatureBase64 !== "string" ||
    signatureBase64.length > 200 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)
  )
    return false;
  const key = publicKeyFrom(spkiBase64),
    data = Buffer.from(canonicalJson(payload)),
    sig = Buffer.from(signatureBase64, "base64");
  // v1.8 R2-12: decide the encoding by parsing, not by length (a DER signature can be exactly 64 bytes).
  const encoding = isDer(sig) ? "der" : sig.length === 64 ? "ieee-p1363" : null;
  if (!encoding) return false;
  try {
    return verifySignature("sha256", data, { key, dsaEncoding: encoding }, sig);
  } catch {
    return false;
  }
}
// A DER ECDSA signature: SEQUENCE { INTEGER r, INTEGER s } with every length consistent (short-form lengths only;
// a P-256 signature never needs more).
export function isDer(b) {
  if (b.length < 8 || b[0] !== 0x30 || b[1] !== b.length - 2) return false;
  let i = 2;
  for (let n = 0; n < 2; n++) {
    if (b[i] !== 0x02 || i + 1 >= b.length) return false;
    const len = b[i + 1];
    if (len < 1 || len > 33) return false;
    i += 2 + len;
    if (i > b.length) return false;
  }
  return i === b.length;
}

export class Devices {
  // `release` and `hostDevice` exist for tests; server.mjs passes neither, so production reads the compiled constant and
  // the controller's own native daemon connection (control.native.hostFeature).
  constructor(control, { now = Date.now, release = FIRST_DEVICE_PAIRING, hostDevice } = {}) {
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.now = now;
    this.release = release === true;
    this.hostDevice =
      hostDevice ??
      (() => {
        try {
          return this.control.native?.hostFeature?.(HOST_DEVICE_FEATURE) === true;
        } catch {
          return false;
        }
      });
    // The 6-digit code lives only in controller memory, as a hash with a try count: it is never written to the journal,
    // and a controller restart simply needs a new window.
    this.codes = new Map();
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS cc_devices(id TEXT PRIMARY KEY,label TEXT NOT NULL,platform TEXT NOT NULL,publicKey TEXT UNIQUE NOT NULL,alg TEXT NOT NULL,keyStorage TEXT NOT NULL,userPresence INTEGER NOT NULL,pairedAt TEXT NOT NULL,pairedVia TEXT NOT NULL,state TEXT NOT NULL,revokedAt TEXT,lastUsedAt TEXT,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_device_history(id TEXT PRIMARY KEY,entityId TEXT NOT NULL,action TEXT NOT NULL,before TEXT,after TEXT NOT NULL,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_pairing_windows(id TEXT PRIMARY KEY,openedBy TEXT NOT NULL,openedAt TEXT NOT NULL,expiresAt TEXT NOT NULL,usedBy TEXT);`);
    assertColumns(this.db, "cc_devices", DEVICE_COLUMNS);
    assertColumns(this.db, "cc_device_history", HISTORY_COLUMNS);
    assertColumns(this.db, "cc_pairing_windows", WINDOW_COLUMNS);
  }
  iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }
  row(id) {
    return this.db.prepare("SELECT * FROM cc_devices WHERE id=?").get(id) ?? null;
  }
  active() {
    return this.db.prepare("SELECT * FROM cc_devices WHERE state='active' ORDER BY pairedAt").all();
  }
  publicDevice(r) {
    return {
      version: 1,
      id: r.id,
      label: r.label,
      platform: r.platform,
      publicKey: r.publicKey,
      alg: r.alg,
      keyStorage: r.keyStorage,
      userPresence: Boolean(r.userPresence),
      pairedAt: r.pairedAt,
      pairedVia: JSON.parse(r.pairedVia),
      state: r.state,
      revokedAt: r.revokedAt,
      lastUsedAt: r.lastUsedAt,
      revision: r.revision,
    };
  }
  list() {
    const at = this.now(),
      open = this.db
        .prepare(
          "SELECT * FROM cc_pairing_windows WHERE usedBy IS NULL AND expiresAt>? ORDER BY openedAt DESC LIMIT 1",
        )
        .get(this.iso(at));
    return {
      version: 1,
      observedAt: this.iso(at),
      devices: this.db
        .prepare("SELECT * FROM cc_devices ORDER BY pairedAt")
        .all()
        .map((r) => this.publicDevice(r)),
      pairingWindow: open
        ? { id: open.id, expiresAt: open.expiresAt, codeAvailable: this.codes.has(open.id) }
        : null,
    };
  }
  history(id, entityId, action, before, after, actor, note) {
    if (this.db.prepare("SELECT count(*) n FROM cc_device_history").get().n >= MAX_HISTORY)
      throw Error("The device history is full; nothing was recorded");
    this.db
      .prepare("INSERT INTO cc_device_history VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        entityId,
        action,
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
        before?.revision ?? 0,
        after.revision,
        actor,
        note,
        this.iso(),
      );
  }
  // A signed write's own freshness and single use: `at` within 5 minutes, the messageId never seen before.
  fresh(payload) {
    if (!uuid(payload?.messageId)) throw new ProofRefused("The signed request has no message id");
    if (
      typeof payload.at !== "string" ||
      Number.isNaN(Date.parse(payload.at)) ||
      Math.abs(Date.parse(payload.at) - this.now()) > PROOF_WINDOW_MS
    )
      throw new ProofRefused("The signature is too old or from the future; sign again");
    if (this.db.prepare("SELECT id FROM cc_device_history WHERE id=?").get(payload.messageId))
      throw new ProofRefused("That signed request was already used");
  }
  describe(d) {
    if (!keys(d, "keyStorage,label,platform,publicKey,userPresence"))
      throw new ProofRefused("Invalid device description");
    if (
      typeof d.label !== "string" ||
      !d.label.trim() ||
      d.label.length > 60 ||
      personalMatch(d.label)
    )
      throw new ProofRefused("The device name must be 1–60 characters with no personal data");
    if (
      !PLATFORMS.includes(d.platform) ||
      !KEY_STORAGE.includes(d.keyStorage) ||
      typeof d.userPresence !== "boolean"
    )
      throw new ProofRefused("Invalid device description");
    publicKeyFrom(d.publicKey);
    return {
      label: d.label.trim(),
      platform: d.platform,
      publicKey: d.publicKey,
      keyStorage: d.keyStorage,
      userPresence: d.userPresence,
    };
  }
  insert(device, pairedVia, messageId, actor, note) {
    if (this.db.prepare("SELECT id FROM cc_devices WHERE publicKey=?").get(device.publicKey))
      throw new ProofRefused("That key is already paired");
    if (this.active().length >= MAX_DEVICES)
      throw Error(`At most ${MAX_DEVICES} devices can be paired`);
    const id = randomUUID(),
      at = this.iso();
    this.db
      .prepare("INSERT INTO cc_devices VALUES (?,?,?,?,'ES256',?,?,?,?,'active',NULL,NULL,1)")
      .run(
        id,
        device.label,
        device.platform,
        device.publicKey,
        device.keyStorage,
        device.userPresence ? 1 : 0,
        at,
        JSON.stringify(pairedVia),
      );
    const r = this.publicDevice(this.row(id));
    this.history(messageId, id, "paired", null, r, actor, note);
    return r;
  }

  // §3.6 rule 3. The operator opens a 10-minute window for the FIRST device only; the code is returned once, to show.
  pairingEnabled() {
    return this.release && this.hostDevice() === true;
  }
  openWindow(a) {
    if (a != null) throw Error("Opening a pairing window takes no input");
    if (!this.pairingEnabled()) throw new ProofRefused(PAIRING_OFF);
    return this.store.atomic(() => {
      if (this.active().length)
        throw Error("A device is already paired. Approve a new device from a paired one instead");
      const at = this.now(),
        id = randomUUID(),
        code = String(randomInt(0, 1000000)).padStart(6, "0");
      this.db
        .prepare("UPDATE cc_pairing_windows SET expiresAt=? WHERE usedBy IS NULL AND expiresAt>?")
        .run(this.iso(at), this.iso(at));
      this.db
        .prepare("INSERT INTO cc_pairing_windows VALUES (?,'operator',?,?,NULL)")
        .run(id, this.iso(at), this.iso(at + PAIRING_WINDOW_MS));
      this.codes.clear();
      this.codes.set(id, { hash: hash(code), tries: 0 });
      return {
        windowId: id,
        code,
        expiresAt: this.iso(at + PAIRING_WINDOW_MS),
        note: "Enter this code on the device you are pairing. It works once, for 10 minutes.",
      };
    });
  }
  // The first device registers its key with the code, and proves it holds the private half by signing the request:
  // { payload: { purpose: 'fulcra.device.pair', windowId, code, device, messageId, at }, signature } (CONTRACT-CHANGE-J3-1).
  completePairing(a) {
    if (
      !keys(a, "payload,signature") ||
      !keys(a.payload, "at,code,device,messageId,purpose,windowId") ||
      a.payload.purpose !== PURPOSE.pair
    )
      throw new ProofRefused("Invalid pairing request");
    if (!this.pairingEnabled()) throw new ProofRefused(PAIRING_OFF);
    const payload = a.payload,
      device = this.describe(payload.device);
    return this.store.atomic(() => {
      const at = this.now();
      const w = this.db
        .prepare(
          "SELECT * FROM cc_pairing_windows WHERE usedBy IS NULL AND expiresAt>? ORDER BY openedAt DESC LIMIT 1",
        )
        .get(this.iso(at));
      const code = w && this.codes.get(w.id);
      if (!w || !code || payload.windowId !== w.id)
        throw new ProofRefused("No pairing window is open. Open one in Settings › Devices");
      if (this.active().length)
        throw new ProofRefused(
          "A device is already paired. Approve a new device from a paired one instead",
        );
      const given = hash(typeof payload.code === "string" ? payload.code : "");
      if (
        !/^\d{6}$/.test(payload.code ?? "") ||
        !timingSafeEqual(Buffer.from(given), Buffer.from(code.hash))
      ) {
        // Guessing is bounded: the fifth wrong code forgets the code, which closes the window (the refusal below rolls
        // back any journal write, so the in-memory code is the thing that ends it).
        if (++code.tries >= MAX_CODE_TRIES) this.codes.delete(w.id);
        throw new ProofRefused("That code is not right");
      }
      this.fresh(payload);
      if (!verifies(device.publicKey, payload, a.signature))
        throw new ProofRefused("The device signature does not verify");
      const r = this.insert(
        device,
        { kind: "first-device", windowId: w.id },
        payload.messageId,
        "operator",
        "First device paired with a pairing window",
      );
      this.db.prepare("UPDATE cc_pairing_windows SET usedBy=? WHERE id=?").run(r.id, w.id);
      this.codes.delete(w.id);
      return { device: r };
    });
  }
  // A signature by an active device over `payload`. Returns that device row.
  signedBy(proof, purpose) {
    if (
      !keys(proof, "alg,deviceId,payload,signature") ||
      proof.alg !== "ES256" ||
      !uuid(proof.deviceId) ||
      proof.payload?.purpose !== purpose
    )
      throw new ProofRefused("Invalid device signature");
    const signer = this.row(proof.deviceId);
    if (!signer || signer.state !== "active")
      throw new ProofRefused("The signing device is not paired");
    this.fresh(proof.payload);
    if (!verifies(signer.publicKey, proof.payload, proof.signature))
      throw new ProofRefused("The device signature does not verify");
    return signer;
  }
  // §3.6 rule 4. Every later device needs an approval signed by an active device, and signs its own key too.
  approvePairing(a) {
    // v1.8 R2-10: the whole shape is checked before anything inside it is read.
    if (
      !keys(a, "approval,device,signature") ||
      !keys(a.approval, "alg,deviceId,payload,signature")
    )
      throw new ProofRefused("Invalid pairing approval");
    const device = this.describe(a.device);
    return this.store.atomic(() => {
      const payload = a.approval.payload;
      if (
        !keys(payload, "at,device,messageId,purpose") ||
        canonicalJson(payload.device) !== canonicalJson(a.device)
      )
        throw new ProofRefused("The signed approval does not match");
      const signer = this.signedBy(a.approval, PURPOSE.approve);
      // The new device proves it holds its key by signing the same approved payload.
      if (!verifies(device.publicKey, payload, a.signature))
        throw new ProofRefused("The new device signature does not verify");
      this.touch(signer.id);
      return {
        device: this.insert(
          device,
          { kind: "approved", byDeviceId: signer.id },
          payload.messageId,
          `device:${signer.id}`,
          `Approved on ${signer.label}`,
        ),
      };
    });
  }
  // One tap on any paired device, which signs the revocation. A device may revoke itself.
  revoke(a) {
    if (!keys(a, "proof")) throw new ProofRefused("Invalid revocation");
    return this.store.atomic(() => {
      const payload = a.proof.payload;
      if (!keys(payload, "at,deviceId,messageId,purpose") || !uuid(payload.deviceId))
        throw new ProofRefused("The signed revocation does not match");
      const signer = this.signedBy(a.proof, PURPOSE.revoke),
        target = this.row(payload.deviceId);
      if (!target || target.state !== "active") throw new ProofRefused("That device is not paired");
      const before = this.publicDevice(target),
        at = this.iso();
      this.db
        .prepare("UPDATE cc_devices SET state='revoked',revokedAt=?,revision=revision+1 WHERE id=?")
        .run(at, target.id);
      const after = this.publicDevice(this.row(target.id));
      this.history(
        payload.messageId,
        target.id,
        "revoked",
        before,
        after,
        `device:${signer.id}`,
        signer.id === target.id ? "Revoked itself" : `Revoked on ${signer.label}`,
      );
      // v1.13 R3-6: every chat channel this device authorised stops answering as the owner, in the same transaction.
      const channels =
        this.control.inboxChannels?.deviceRevoked(target.id, `device:${signer.id}`) ?? [];
      return { device: after, channelsPaused: channels };
    });
  }
  touch(id) {
    this.db.prepare("UPDATE cc_devices SET lastUsedAt=? WHERE id=?").run(this.iso(), id);
  }
  // §3.6 rule 1, for decision-choose. Returns the device when every condition holds; otherwise throws ProofRefused
  // with the reason, and the caller records the answer as `operator`.
  verifyChoice(proof, expected) {
    if (
      !keys(proof, "alg,deviceId,payload,signature") ||
      proof.alg !== "ES256" ||
      !uuid(proof.deviceId)
    )
      throw new ProofRefused("The proof is malformed");
    const device = this.row(proof.deviceId);
    if (!device || device.state !== "active") throw new ProofRefused("The device is not paired");
    if (
      !keys(
        proof.payload,
        "at,confirmDestructive,decisionId,digest,messageId,note,optionId,revision",
      )
    )
      throw new ProofRefused("The proof does not match this answer");
    const { at, ...rest } = proof.payload;
    if (canonicalJson(rest) !== canonicalJson(expected))
      throw new ProofRefused("The proof does not match this answer");
    if (
      typeof at !== "string" ||
      Number.isNaN(Date.parse(at)) ||
      Math.abs(Date.parse(at) - this.now()) > PROOF_WINDOW_MS
    )
      throw new ProofRefused("The proof is too old or from the future");
    if (!verifies(device.publicKey, proof.payload, proof.signature))
      throw new ProofRefused("The device signature does not verify");
    return device;
  }
  // Pairings and revocations in a period, for the inbox and the digest (§3.6 rule 5).
  events(sinceIso, untilIso = this.iso()) {
    return this.db
      .prepare(
        "SELECT h.id,h.action,h.at,d.label,d.platform,d.keyStorage,d.userPresence FROM cc_device_history h JOIN cc_devices d ON d.id=h.entityId WHERE h.action IN ('paired','revoked') AND h.at>? AND h.at<=? ORDER BY h.at DESC LIMIT 32",
      )
      .all(sinceIso, untilIso);
  }
}
