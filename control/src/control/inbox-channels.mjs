// Fulcra J3b (CONTRACTS v1.6 §3.5, CC-PLAN §2 D4): one inbox, any channel. The controller's decision store stays the
// only authority; a channel is a view that can show an item and return an answer, and nothing a channel does
// bypasses §3.2. Named inbox-channels so it never collides with the seat-to-seat RoleChannels (role-channels.mjs).
//
// Who a channel answer is from (v1.6, prime decision S-1):
//   - discord-openclaw: the owner (`human`) ONLY when the channel was paired from a window opened with a paired-device
//     proof (pairedBy "human") AND the answer carries the OpenClaw ingress origin with senderIsOwner === true and
//     the bound agent, channel and sender. Anything short of that origin is refused; a channel paired from an
//     operator-opened window answers as `operator`.
//   - session and cli: always `operator` (their typed text cannot be told apart from an agent's in the same account).
// v1.13 (R-A J3-R3):
//   - R3-2 session proof: the answer names a human-input entry ({boot, n}, or "latest"), which must be in the bound
//     session's human-log (the pinned guard's), newer than the post, and the session's human-typed message after the
//     post must contain the option's number or title. Otherwise NOT_FROM_YOU. (The cli refuses non-TTY answers.)
//   - R3-3 Discord answers are turn-bound: OpenClaw sessionKey + turn id, and a turn already seen is refused. Residual:
//     the controller trusts the ingress's senderIsOwner report, which a same-user process holding the channel file
//     could imitate (S-2 option B; gateway-signed origins are future work for the OpenClaw owner).
//   - R3-4 chat posts are not edited (list-only, a documented deviation): an update shown in a chat reply is settled
//     only when a LATER owner turn arrives, so a reply that never reached the owner shows it again.
//   - R3-5 wrong codes are counted per window and throttled in time; nobody can close the owner's window by guessing.
//   - R3-6 revoking a device pauses, and downgrades to the operator, every chat channel that device authorised.
// Held-message bodies never leave through a channel (rule 4).
import { channelTitleOf } from "./channel-titles.mjs";
import { randomUUID, randomInt, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { uuid } from "./authority.mjs";
import { assertColumns } from "./schema.mjs";
import { hash } from "./store.mjs";
import { ProofRefused, PAIRING_OFF } from "./devices.mjs";
import { readHumanLog } from "./human-log.mjs";
import { sealedHumanAt } from "./boot-chain.mjs";
import { personalMatch } from "../../orca-organization/shared/cc/refs.mjs";
import { canonicalJson } from "../../orca-organization/shared/cc/decision-rules.mjs";
import {
  decisionText,
  heldText,
  itemLine,
  answeredLine,
  closedLine,
} from "../../orca-organization/shared/cc/channel-text.mjs";
const keys = (a, names) =>
  a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).sort().join() === names;
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
export const CHANNEL_KINDS = Object.freeze(["discord-openclaw", "session", "cli"]);
export const CHANNEL_PAIR_MS = 10 * 60000;
export const NOT_FROM_YOU = "I can't confirm this came from you; answer in the Fulcra app";
export const PAIR_OPEN_PURPOSE = "fulcra.channel.pair-open";
const MAX_CHANNELS = 64,
  MAX_POSTS = 20000,
  MAX_HISTORY = 5000,
  MAX_WRONG_CODES = 5,
  MAX_TURNS = 20000;
// R3-5: after k wrong codes in the last 10 minutes, the next try waits 2^k seconds (at most a minute).
export const CODE_THROTTLE_MAX_MS = 60000;
export const THROTTLED = "Too many wrong codes just now. Wait a minute, then type the code again";
const CHANNEL_COLUMNS =
  "id,kind,label,binding,scope,pairedAt,pairedBy,state,revision,capabilityHash,at";
const HISTORY_COLUMNS = "id,entityId,action,before,after,previousRevision,revision,actor,note,at";
const POST_COLUMNS = "id,channelId,itemKey,externalRef,postedAt,updatedAt,state";
// One-time proof, minted only here after the owner origin checked out, that Decisions.choose accepts as `human`.
// rpc.mjs cannot mint one, so no request can name the owner.
const ATTESTED = new WeakSet();
export const ownerAttested = (attestation, channelId) => {
  const ok = ATTESTED.has(attestation) && attestation.channelId === channelId;
  ATTESTED.delete(attestation);
  return ok;
};

export class InboxChannels {
  constructor(control, { now = Date.now } = {}) {
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.now = now;
    // Pairing windows (and their 6-digit codes, hashed) live only in controller memory: a restart needs a new window.
    this.windows = new Map();
    this.wrongAt = [];
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS cc_channels(id TEXT PRIMARY KEY,kind TEXT NOT NULL,label TEXT NOT NULL,binding TEXT NOT NULL,scope TEXT NOT NULL,pairedAt TEXT NOT NULL,pairedBy TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,capabilityHash TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_channel_history(id TEXT PRIMARY KEY,entityId TEXT NOT NULL,action TEXT NOT NULL,before TEXT,after TEXT NOT NULL,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_channel_posts(id TEXT PRIMARY KEY,channelId TEXT NOT NULL,itemKey TEXT NOT NULL,externalRef TEXT,postedAt TEXT NOT NULL,updatedAt TEXT,state TEXT NOT NULL,UNIQUE(channelId,itemKey));
      CREATE TABLE IF NOT EXISTS cc_channel_authority(channelId TEXT PRIMARY KEY,deviceId TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_channel_marks(postId TEXT PRIMARY KEY,boot TEXT NOT NULL,humanAt INTEGER NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_channel_turns(turnHash TEXT PRIMARY KEY,channelId TEXT NOT NULL,use TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_channel_shown(postId TEXT PRIMARY KEY,turnHash TEXT NOT NULL,at TEXT NOT NULL);`);
    assertColumns(this.db, "cc_channel_authority", "channelId,deviceId,at");
    assertColumns(this.db, "cc_channel_marks", "postId,boot,humanAt,epoch,seq,at");
    assertColumns(this.db, "cc_channel_turns", "turnHash,channelId,use,at");
    assertColumns(this.db, "cc_channel_shown", "postId,turnHash,at");
    assertColumns(this.db, "cc_channels", CHANNEL_COLUMNS);
    assertColumns(this.db, "cc_channel_history", HISTORY_COLUMNS);
    assertColumns(this.db, "cc_channel_posts", POST_COLUMNS);
  }
  iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }
  row(id) {
    return this.db.prepare("SELECT * FROM cc_channels WHERE id=?").get(id) ?? null;
  }
  publicChannel(r) {
    const binding = JSON.parse(r.binding);
    return {
      version: 1,
      id: r.id,
      revision: r.revision,
      kind: r.kind,
      label: r.label,
      binding,
      scope: JSON.parse(r.scope),
      pairedAt: r.pairedAt,
      pairedBy: r.pairedBy,
      state: r.state,
      answersCountAsOwner: r.kind === "discord-openclaw" && r.pairedBy === "human",
    };
  }
  history(id, entityId, action, before, after, actor, note) {
    if (this.db.prepare("SELECT count(*) n FROM cc_channel_history").get().n >= MAX_HISTORY)
      throw Error("The channel history is full; nothing was recorded");
    this.db
      .prepare("INSERT INTO cc_channel_history VALUES (?,?,?,?,?,?,?,?,?,?)")
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
  scope(s) {
    if (
      !keys(s, "canAnswer,levels,projects") ||
      typeof s.canAnswer !== "boolean" ||
      !Array.isArray(s.levels) ||
      !s.levels.length ||
      !s.levels.every((l) => [1, 2, 3].includes(l)) ||
      new Set(s.levels).size !== s.levels.length ||
      !(
        s.projects === "all" ||
        (Array.isArray(s.projects) && s.projects.length <= 64 && s.projects.every(uuid))
      )
    )
      throw Error("Invalid channel scope");
    return { projects: s.projects, canAnswer: s.canAnswer, levels: [...s.levels].sort() };
  }
  // The ingress origin of an owner turn (inbox-relay.mjs chatOrigin): the owner flag, agent, channel and sender, plus
  // the OpenClaw conversation and the turn it arrived in (R3-3).
  chatOrigin(o) {
    return (
      keys(o, "agentId,nativeChannelId,senderId,senderIsOwner,sessionKey,turnId") &&
      o.senderIsOwner === true &&
      [o.agentId, o.nativeChannelId, o.senderId, o.sessionKey, o.turnId].every(
        (v) => typeof v === "string" && v && v.length <= 200,
      )
    );
  }
  turnHash(o) {
    return sha(JSON.stringify([o.sessionKey, o.turnId]));
  }
  // R3-3: an owner turn is used once for an answer (or a pairing). A replayed turn id is refused.
  useTurn(channelId, o, use) {
    const h = this.turnHash(o);
    if (this.db.prepare("SELECT turnHash FROM cc_channel_turns WHERE turnHash=?").get(h))
      throw Error(`${NOT_FROM_YOU} (that message was already used)`);
    // Derived rows rotate: the oldest turns are forgotten first (v1.5 §1 Capacity), never refusing the owner.
    this.db
      .prepare(
        "DELETE FROM cc_channel_turns WHERE turnHash IN (SELECT turnHash FROM cc_channel_turns ORDER BY at LIMIT max(0,(SELECT count(*) FROM cc_channel_turns)-?))",
      )
      .run(MAX_TURNS - 1);
    this.db
      .prepare("INSERT INTO cc_channel_turns VALUES (?,?,?,?)")
      .run(h, channelId ?? "", use, this.iso());
  }
  // Does this origin match the channel's binding? sessionKeyHash is absent only on channels paired before v1.13.
  bound(binding, o) {
    return (
      this.chatOrigin(o) &&
      o.agentId === binding.agentId &&
      sha(o.nativeChannelId) === binding.nativeChannelHash &&
      sha(o.senderId) === binding.ownerSenderHash &&
      (binding.sessionKeyHash === undefined || sha(o.sessionKey) === binding.sessionKeyHash)
    );
  }

  // ---- App side (operator gate) ---------------------------------------------------------------------------------
  list() {
    return {
      version: 1,
      observedAt: this.iso(),
      channels: this.db
        .prepare("SELECT * FROM cc_channels ORDER BY pairedAt")
        .all()
        .map((r) => this.publicChannel(r)),
    };
  }
  // §3.5 rule 1: pairing starts in the app. With a paired-device proof the window pairs an owner-capable channel
  // (pairedBy "human"); without one, the operator pairs a channel whose answers are the operator's.
  openWindow(a) {
    if (
      !a ||
      typeof a !== "object" ||
      Object.keys(a).some((k) => !["kind", "label", "scope", "proof"].includes(k))
    )
      throw Error("Invalid channel pairing request");
    if (!CHANNEL_KINDS.includes(a.kind)) throw Error("Unknown channel kind");
    if (
      typeof a.label !== "string" ||
      !a.label.trim() ||
      a.label.length > 80 ||
      personalMatch(a.label)
    )
      throw Error("The channel name must be 1–80 characters with no personal data");
    const scope = this.scope(a.scope);
    let pairedBy = "operator",
      openedBy = null;
    if (a.proof !== undefined) {
      // v1.8 R2-1: an owner-capable channel is gated like first-device pairing.
      if (!this.control.devices?.pairingEnabled()) throw new ProofRefused(PAIRING_OFF);
      if (a.kind !== "discord-openclaw")
        throw Error(
          "Only a chat channel can answer as you; session and command-line channels are the operator",
        );
      const payload = a.proof?.payload;
      if (
        !keys(payload, "at,kind,label,messageId,purpose,scope") ||
        payload.purpose !== PAIR_OPEN_PURPOSE ||
        payload.kind !== a.kind ||
        payload.label !== a.label ||
        canonicalJson(payload.scope) !== canonicalJson(a.scope)
      )
        throw new ProofRefused("The signed request does not match");
      this.store.atomic(() => {
        const signer = this.control.devices.signedBy(a.proof, PAIR_OPEN_PURPOSE);
        openedBy = signer.id;
        this.control.devices.history(
          payload.messageId,
          signer.id,
          "channel-pair-opened",
          null,
          { revision: this.control.devices.row(signer.id).revision },
          `device:${signer.id}`,
          `Opened a ${a.kind} pairing`,
        );
      });
      pairedBy = "human";
    }
    const now = this.now(),
      id = randomUUID(),
      code = String(randomInt(0, 1000000)).padStart(6, "0");
    for (const [k, w] of this.windows) if (w.expiresAt <= now) this.windows.delete(k);
    this.windows.set(id, {
      kind: a.kind,
      label: a.label.trim(),
      scope,
      pairedBy,
      openedBy,
      expiresAt: now + CHANNEL_PAIR_MS,
      codeHash: hash(code),
      wrong: 0,
    });
    return {
      windowId: id,
      code,
      expiresAt: this.iso(now + CHANNEL_PAIR_MS),
      pairedBy,
      note:
        a.kind === "discord-openclaw"
          ? "Type this code in your Fulcra Discord conversation within 10 minutes."
          : "Enter this code with `fulcra inbox pair` within 10 minutes.",
    };
  }
  setState(a, state, action) {
    if (!keys(a, "expectedRevision,id") || !uuid(a.id) || !Number.isSafeInteger(a.expectedRevision))
      throw Error("Invalid channel change");
    return this.store.atomic(() => {
      const r = this.row(a.id);
      if (!r) throw Error("No channel has that id");
      if (r.state === "revoked") throw Error("That channel is already revoked");
      if (r.revision !== a.expectedRevision) throw Error("Changed since you looked; refresh");
      if (r.state === state) return { channel: this.publicChannel(r) };
      const before = this.publicChannel(r);
      this.db
        .prepare("UPDATE cc_channels SET state=?,revision=revision+1,at=? WHERE id=?")
        .run(state, this.iso(), a.id);
      const after = this.publicChannel(this.row(a.id));
      this.history(randomUUID(), a.id, action, before, after, "operator", action);
      return { channel: after };
    });
  }
  pause(a) {
    return this.setState(a, "paused", "paused");
  }
  resume(a) {
    return this.setState(a, "active", "resumed");
  }
  revoke(a) {
    return this.setState(a, "revoked", "revoked");
  }

  // ---- Channel side: completing a pairing (the code is the credential) --------------------------------------------
  // The channel proves it by echoing the code: the owner types it in Discord (arriving through the owner-verified
  // ingress origin), or the session / CLI submits it. The server keeps only hashes of external ids.
  completePairing(a) {
    if (
      !a ||
      typeof a !== "object" ||
      typeof a.code !== "string" ||
      !/^\d{6}$/.test(a.code) ||
      (a.windowId !== undefined && !uuid(a.windowId))
    )
      throw Error("Invalid pairing code");
    const now = this.now();
    for (const [k, w] of this.windows) if (w.expiresAt <= now) this.windows.delete(k);
    // R3-5: a time throttle on wrong codes (no window is ever closed by someone else's guesses) ...
    this.wrongAt = this.wrongAt.filter((t) => t > now - CHANNEL_PAIR_MS);
    if (
      this.wrongAt.length &&
      now < this.wrongAt.at(-1) + Math.min(CODE_THROTTLE_MAX_MS, 1000 * 2 ** this.wrongAt.length)
    )
      throw Error(THROTTLED);
    const target = a.windowId !== undefined ? this.windows.get(a.windowId) : null;
    const entry =
      a.windowId !== undefined
        ? target && timingSafeEqual(Buffer.from(target.codeHash), Buffer.from(hash(a.code)))
          ? [a.windowId, target]
          : null
        : [...this.windows].find(([, w]) =>
            timingSafeEqual(Buffer.from(w.codeHash), Buffer.from(hash(a.code))),
          );
    if (!entry) {
      this.wrongAt.push(now);
      // ... and a per-window counter: a window named by its id closes after five wrong codes for IT.
      if (target && ++target.wrong >= MAX_WRONG_CODES) this.windows.delete(a.windowId);
      throw Error("That code is not right, or it has expired. Get a new one in the Fulcra app");
    }
    const [windowId, w] = entry;
    let binding;
    const { windowId: _named, ...rest } = a;
    if (w.kind === "discord-openclaw") {
      const o = a.origin;
      if (!keys(rest, "code,origin") || !this.chatOrigin(o)) throw Error(NOT_FROM_YOU);
      // R3-3: the OpenClaw conversation (sessionKey) is bound too, as a hash.
      binding = {
        kind: "discord-openclaw",
        agentId: o.agentId,
        nativeChannelHash: sha(o.nativeChannelId),
        ownerSenderHash: sha(o.senderId),
        sessionKeyHash: sha(o.sessionKey),
      };
    } else if (w.kind === "session") {
      if (!keys(rest, "code,sessionId") || !uuid(a.sessionId) || !this.store.get(a.sessionId))
        throw Error("Pair from an existing Fulcra session");
      binding = { kind: "session", sessionId: a.sessionId };
    } else {
      if (
        !keys(rest, "code,hostId") ||
        typeof a.hostId !== "string" ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(a.hostId) ||
        personalMatch(a.hostId)
      )
        throw Error("Pair with this computer's Fulcra id");
      binding = { kind: "cli", hostId: a.hostId };
    }
    return this.store.atomic(() => {
      if (
        this.db.prepare("SELECT count(*) n FROM cc_channels WHERE state!='revoked'").get().n >=
        MAX_CHANNELS
      )
        throw Error(`At most ${MAX_CHANNELS} channels can be paired`);
      if (w.kind === "discord-openclaw") this.useTurn(null, a.origin, "pair");
      this.windows.delete(windowId); // single use
      const id = randomUUID(),
        capability = randomBytes(32).toString("base64url"),
        at = this.iso();
      this.db
        .prepare("INSERT INTO cc_channels VALUES (?,?,?,?,?,?,?,'active',1,?,?)")
        .run(
          id,
          w.kind,
          w.label,
          JSON.stringify(binding),
          JSON.stringify(w.scope),
          at,
          w.pairedBy,
          hash(capability),
          at,
        );
      const channel = this.publicChannel(this.row(id));
      this.history(
        randomUUID(),
        id,
        "paired",
        null,
        channel,
        w.pairedBy === "human" ? "human" : "operator",
        `Paired ${w.kind}`,
      );
      // R3-6: which device authorised an owner-capable channel, so revoking that device reaches it.
      if (w.pairedBy === "human" && w.openedBy)
        this.db.prepare("INSERT INTO cc_channel_authority VALUES (?,?,?)").run(id, w.openedBy, at);
      return { channel, capability, note: "Keep this capability private; it is shown once." };
    });
  }

  // ---- Channel side: capability-scoped reads and answers ----------------------------------------------------------
  check(channelId, capability) {
    const r = uuid(channelId) ? this.row(channelId) : null;
    if (
      !r ||
      typeof capability !== "string" ||
      !timingSafeEqual(Buffer.from(r.capabilityHash), Buffer.from(hash(capability)))
    )
      throw Error("Channel capability revoked or invalid");
    if (r.state === "revoked") throw Error("Channel capability revoked or invalid");
    if (r.state === "paused") throw Error("This channel is paused in the Fulcra app");
    return r;
  }
  // Is this item inside the channel's scope? Decisions by project and level; everything else only for "all" projects.
  inScope(r, item) {
    const s = JSON.parse(r.scope);
    if (s.projects !== "all" && !(item.projectId && s.projects.includes(item.projectId)))
      return false;
    if (item.source === "decision") {
      const p = this.control.decisions.packet(item.ref.slice("decision:".length));
      return Boolean(p) && s.levels.includes(p.level);
    }
    return ["held", "digest", "attention"].includes(item.source);
  }
  // Held messages are read only in the Fulcra app. Whatever title the app inbox shows (C2 #3: a subject from the body),
  // every chat surface gets the generic title; if it's missing, a fixed line -- never anything derived from the body.
  async items(r) {
    return (await this.control.decisions.inbox()).items
      .filter((i) => i.source !== "outcome" && this.inScope(r, i))
      .slice(0, 50)
      .map((i) =>
        i.source === "held"
          ? {
              ...i,
              title:
                typeof channelTitleOf(i) === "string"
                  ? channelTitleOf(i)
                  : "A held message is waiting",
            }
          : i,
      );
  }
  async listFor(a, capability) {
    if (!(keys(a, "channelId") || keys(a, "channelId,origin"))) throw Error("Invalid channel read");
    const r = this.check(a.channelId, capability),
      items = await this.items(r);
    // Updates owed to this channel are shown once, then settled (answered everywhere, exactly once per post).
    // A terminal (CLI, session) shows each owed update once and settles it. A chat reply (R3-4) settles an update only
    // when a LATER owner turn lists again, so an update in a reply that never reached the owner is shown again.
    let updates;
    if (r.kind === "discord-openclaw") {
      if (!this.bound(JSON.parse(r.binding), a.origin)) throw Error(NOT_FROM_YOU);
      updates = this.store.atomic(() => this.showUpdatesInTurn(r.id, this.turnHash(a.origin)));
    } else if (a.origin !== undefined) throw Error("Only a chat channel carries an origin");
    else updates = this.takeUpdates(r.id);
    const text =
      [
        ...updates.map((u) => `Update: ${u.title}. ${u.line}`),
        ...items.map((i, n) => itemLine(n + 1, i)),
      ].join("\n") || "Nothing is waiting for you.";
    return {
      channelId: r.id,
      kind: r.kind,
      items: items.map((i, n) => ({
        n: n + 1,
        key: i.key,
        source: i.source,
        title: i.title,
        urgency: i.urgency,
      })),
      updates,
      text,
    };
  }
  async showFor(a, capability) {
    if (!keys(a, "channelId,key") || typeof a.key !== "string") throw Error("Invalid channel read");
    const r = this.check(a.channelId, capability),
      items = await this.items(r),
      n = items.findIndex((i) => i.key === a.key),
      item = items[n];
    if (!item) throw Error("That item is not in this channel");
    let text,
      packet = null;
    if (item.source === "decision") {
      packet = this.control.decisions.packet(item.ref.slice("decision:".length));
      text = decisionText(packet, n + 1);
    } else if (item.source === "held") text = heldText(item, n + 1);
    else text = `${n + 1}. ${item.title}\n${item.summary}`;
    const post = this.post(r.id, item.key, null);
    // R3-2: where the bound session's human input stood when it was shown the item, so an answer can prove a newer one.
    if (r.kind === "session" && packet) await this.mark(JSON.parse(r.binding).sessionId, post);
    return {
      channelId: r.id,
      key: item.key,
      n: n + 1,
      source: item.source,
      text,
      decision: packet && {
        id: packet.id,
        revision: packet.revision,
        state: packet.state,
        options: packet.options.map((o, i) => ({
          n: i + 1,
          id: o.id,
          title: o.title,
          destructive: o.destructive,
        })),
        bound: packet.action.type !== "none",
      },
    };
  }
  // An adapter records the chat message it posted for an item, so it can be edited when the item is answered.
  postedFor(a, capability) {
    if (
      !keys(a, "channelId,externalRef,key") ||
      typeof a.key !== "string" ||
      typeof a.externalRef !== "string" ||
      !a.externalRef ||
      a.externalRef.length > 200
    )
      throw Error("Invalid post record");
    const r = this.check(a.channelId, capability);
    return { post: this.post(r.id, a.key, a.externalRef) };
  }
  post(channelId, itemKey, externalRef) {
    return this.store.atomic(() => {
      const prior = this.db
        .prepare("SELECT * FROM cc_channel_posts WHERE channelId=? AND itemKey=?")
        .get(channelId, itemKey);
      if (prior) {
        if (externalRef && prior.externalRef !== externalRef)
          this.db
            .prepare("UPDATE cc_channel_posts SET externalRef=? WHERE id=?")
            .run(externalRef, prior.id);
        return { ...this.db.prepare("SELECT * FROM cc_channel_posts WHERE id=?").get(prior.id) };
      }
      if (this.db.prepare("SELECT count(*) n FROM cc_channel_posts").get().n >= MAX_POSTS)
        throw Error("The channel post record is full");
      const at = this.iso(),
        id = randomUUID();
      this.db
        .prepare("INSERT INTO cc_channel_posts VALUES (?,?,?,?,?,?,'posted')")
        .run(id, channelId, itemKey, externalRef, at, at);
      return { ...this.db.prepare("SELECT * FROM cc_channel_posts WHERE id=?").get(id) };
    });
  }
  // §3.5 rule 3, called by Decisions inside the transaction that closes a packet: every post of that item now owes
  // its channel one update (updatedAt NULL until the adapter applies it).
  closed(packet) {
    const state = packet.state === "chosen" ? "updated-answered" : "withdrawn";
    this.db
      .prepare(
        "UPDATE cc_channel_posts SET state=?,updatedAt=NULL WHERE itemKey=? AND state='posted'",
      )
      .run(state, `${packet.kind}-${packet.id}`);
  }
  pendingUpdates(channelId) {
    return this.db
      .prepare(
        "SELECT * FROM cc_channel_posts WHERE channelId=? AND updatedAt IS NULL AND state IN ('updated-answered','withdrawn') ORDER BY postedAt",
      )
      .all(channelId)
      .map((p) => {
        const packet = this.control.decisions.packet(p.itemKey.slice(p.itemKey.indexOf("-") + 1));
        return {
          postId: p.id,
          key: p.itemKey,
          externalRef: p.externalRef,
          state: p.state,
          title: packet?.title ?? "An item",
          line: packet ? closedLine(packet) : "No longer open.",
        };
      });
  }
  updatesFor(a, capability) {
    if (!keys(a, "channelId")) throw Error("Invalid channel read");
    const r = this.check(a.channelId, capability);
    return { channelId: r.id, updates: this.pendingUpdates(r.id) };
  }
  // The adapter applied one update. Exactly once: a second acknowledgment changes nothing.
  updatedFor(a, capability) {
    if (!keys(a, "channelId,postId") || !uuid(a.postId))
      throw Error("Invalid update acknowledgment");
    const r = this.check(a.channelId, capability);
    const changed = this.db
      .prepare(
        "UPDATE cc_channel_posts SET updatedAt=? WHERE id=? AND channelId=? AND updatedAt IS NULL",
      )
      .run(this.iso(), a.postId, r.id).changes;
    return { postId: a.postId, applied: Number(changed) === 1 };
  }
  // R3-4: a chat reply shows each owed update; one shown in an EARLIER owner turn is settled now (that reply was seen,
  // since the owner has written again), and is not shown again.
  showUpdatesInTurn(channelId, turnHash) {
    const out = [];
    for (const u of this.pendingUpdates(channelId)) {
      const shown = this.db
        .prepare("SELECT turnHash FROM cc_channel_shown WHERE postId=?")
        .get(u.postId);
      if (shown && shown.turnHash !== turnHash) {
        this.db
          .prepare("UPDATE cc_channel_posts SET updatedAt=? WHERE id=? AND updatedAt IS NULL")
          .run(this.iso(), u.postId);
        continue;
      }
      if (!shown)
        this.db
          .prepare("INSERT INTO cc_channel_shown VALUES (?,?,?)")
          .run(u.postId, turnHash, this.iso());
      out.push(u);
    }
    return out;
  }
  async mark(sessionId, post) {
    let o;
    try {
      o = await this.control.native.inspect(sessionId);
    } catch {
      return;
    }
    const cursor = o?.timelineCursor;
    if (
      typeof o?.boot !== "string" ||
      !Number.isSafeInteger(o.humanAt) ||
      !cursor ||
      (typeof cursor.epoch !== "string" && typeof cursor.epoch !== "number") ||
      !Number.isSafeInteger(cursor.seq)
    )
      return;
    const prior = this.db.prepare("SELECT boot FROM cc_channel_marks WHERE postId=?").get(post.id);
    // The first showing counts; a daemon restart since then starts a new mark.
    if (prior && prior.boot === o.boot) return;
    this.db
      .prepare("INSERT OR REPLACE INTO cc_channel_marks VALUES (?,?,?,?,?,?)")
      .run(post.id, o.boot, o.humanAt, String(cursor.epoch), cursor.seq, this.iso());
  }
  // R3-2 (§3.5 rule 2, session): the named human-input entry exists in the bound session's human-log, is newer than
  // the post, and a human-typed message after the post contains the option's number or title.
  // The entry is a genuine human input to this session. Legacy: the pinned guard logged exactly it. V4 owned daemon
  // (W1): the daemon's own human-input counter, which counts only human-context input (never an agent's or the
  // controller's), reached it -- live for the current boot, sealed and anchored (boot-chain.mjs) for an earlier one.
  async humanInputReached(sessionId, entry) {
    if (!this.control.bootChainDir) {
      const log = readHumanLog(this.control.humanLogDir, entry.boot);
      return Boolean(log.header && log.records.some((x) => x.a === sessionId && x.n === entry.n));
    }
    let o;
    try {
      o = await this.control.native.inspect(sessionId);
    } catch {
      return false;
    }
    const reached =
      o?.boot === entry.boot
        ? o.humanAt
        : sealedHumanAt(this.control.bootChainDir, entry.boot, sessionId);
    return Number.isSafeInteger(reached) && entry.n <= reached;
  }
  async sessionProof(r, item, a) {
    const binding = JSON.parse(r.binding),
      sessionId = binding.sessionId;
    const post = this.db
      .prepare("SELECT id FROM cc_channel_posts WHERE channelId=? AND itemKey=?")
      .get(r.id, item.key);
    const mark =
      post && this.db.prepare("SELECT * FROM cc_channel_marks WHERE postId=?").get(post.id);
    if (!mark) throw Error(`${NOT_FROM_YOU} (show it in this session first)`);
    let entry = a.humanInput;
    if (entry === "latest") {
      let o;
      try {
        o = await this.control.native.inspect(sessionId);
      } catch {
        throw Error(NOT_FROM_YOU);
      }
      entry = { boot: o?.boot, n: o?.humanAt };
    }
    if (
      !keys(entry, "boot,n") ||
      typeof entry.boot !== "string" ||
      !Number.isSafeInteger(entry.n) ||
      entry.n < 1
    )
      throw Error(NOT_FROM_YOU);
    if (entry.boot !== mark.boot || entry.n <= mark.humanAt)
      throw Error(`${NOT_FROM_YOU} (no answer was typed after it was shown)`);
    if (!(await this.humanInputReached(sessionId, entry))) throw Error(NOT_FROM_YOU);
    let messages;
    try {
      messages = await this.control.native.humanMessagesSince(sessionId, {
        epoch: /^\d+$/.test(mark.epoch) ? Number(mark.epoch) : mark.epoch,
        seq: mark.seq,
      });
    } catch {
      throw Error(NOT_FROM_YOU);
    }
    const p = this.control.decisions.packet(item.ref.slice("decision:".length)),
      i = p.options.findIndex((o) => o.id === a.optionId);
    const says = (text) => {
      const t = String(text).trim().toLowerCase();
      if (i < 0) return a.optionId === "answer" && t.length > 0;
      const title = p.options[i].title.toLowerCase();
      return (
        t === String(i + 1) ||
        new RegExp(`^(?:option\\s+)?${i + 1}[.)!]?$`).test(t) ||
        new RegExp(`\\b(?:option|answer|choose|pick)\\s+${i + 1}\\b`).test(t) ||
        t.includes(title)
      );
    };
    // Human inputs after the post are numbered mark.humanAt+1, +2, ...: entry n is the (n - mark.humanAt)-th human
    // message after the post, and THAT message must name the option. Counts that don't line up refuse.
    const own = Array.isArray(messages) ? messages[entry.n - mark.humanAt - 1] : undefined;
    if (!own || !says(own.text))
      throw Error(`${NOT_FROM_YOU} (your message does not name that option)`);
  }
  // R3-6: the device that authorised these chat channels was revoked. They stop answering as the owner (downgraded
  // to the operator, permanently) and are paused until the owner looks at them. Called inside Devices.revoke.
  deviceRevoked(deviceId, actor) {
    const out = [];
    for (const { channelId } of this.db
      .prepare("SELECT channelId FROM cc_channel_authority WHERE deviceId=?")
      .all(deviceId)) {
      const r = this.row(channelId);
      if (!r || r.state === "revoked" || r.pairedBy !== "human") continue;
      const before = this.publicChannel(r);
      this.db
        .prepare(
          "UPDATE cc_channels SET state='paused',pairedBy='operator',revision=revision+1,at=? WHERE id=?",
        )
        .run(this.iso(), channelId);
      const after = this.publicChannel(this.row(channelId));
      this.history(
        randomUUID(),
        channelId,
        "device-revoked",
        before,
        after,
        actor,
        "Paused: the device that authorised this channel was revoked. Its answers no longer count as yours",
      );
      out.push({ id: channelId, label: r.label });
    }
    return out;
  }
  // R3-7: channel pairings, revocations and device-revoked pauses in a period, for Security and the digest.
  events(sinceIso, untilIso = this.iso()) {
    return this.db
      .prepare(
        "SELECT h.id,h.entityId,h.action,h.at,h.after,c.kind,c.label FROM cc_channel_history h JOIN cc_channels c ON c.id=h.entityId WHERE h.action IN ('paired','revoked','device-revoked') AND h.at>? AND h.at<=? ORDER BY h.at DESC LIMIT 32",
      )
      .all(sinceIso, untilIso)
      .map((e) => ({
        id: e.id,
        channelId: e.entityId,
        action: e.action,
        at: e.at,
        kind: e.kind,
        label: e.label,
        ownerCapable: JSON.parse(e.after).pairedBy === "human",
      }));
  }
  // Terminal channels (CLI, sessions) cannot edit what they printed, so list shows owed updates once and settles them.
  takeUpdates(channelId) {
    const u = this.pendingUpdates(channelId);
    for (const x of u)
      this.db
        .prepare("UPDATE cc_channel_posts SET updatedAt=? WHERE id=? AND updatedAt IS NULL")
        .run(this.iso(), x.postId);
    return u;
  }

  // §3.5 rule 2: proof of origin on every answer.
  async answerFor(a, capability) {
    if (
      !a ||
      typeof a !== "object" ||
      Object.keys(a).some(
        (k) =>
          ![
            "channelId",
            "key",
            "optionId",
            "note",
            "messageId",
            "expectedRevision",
            "confirmDestructive",
            "origin",
            "humanInput",
          ].includes(k),
      ) ||
      typeof a.key !== "string" ||
      typeof a.optionId !== "string" ||
      !uuid(a.messageId) ||
      !Number.isSafeInteger(a.expectedRevision)
    )
      throw Error("Invalid channel answer");
    const r = this.check(a.channelId, capability),
      scope = JSON.parse(r.scope),
      binding = JSON.parse(r.binding);
    if (!scope.canAnswer) throw Error("This channel can show items but not answer them");
    let owner;
    if (r.kind === "discord-openclaw") {
      if (!this.bound(binding, a.origin) || a.humanInput !== undefined) throw Error(NOT_FROM_YOU);
    } else if (a.origin !== undefined) throw Error("Only a chat channel carries an origin");
    if (r.kind !== "session" && a.humanInput !== undefined)
      throw Error("Only a session channel names a human input");
    const item = (await this.items(r)).find((i) => i.key === a.key);
    if (!item || item.source !== "decision") throw Error("That is not a decision in this channel");
    if (r.kind === "session") await this.sessionProof(r, item, a);
    if (r.kind === "discord-openclaw") {
      // R3-3: the owner's turn is spent by this answer, before the choice; a replay of the same turn is refused.
      this.store.atomic(() => this.useTurn(r.id, a.origin, `answer:${a.key}`));
      if (r.pairedBy === "human") {
        owner = Object.freeze({ channelId: r.id });
        ATTESTED.add(owner);
      }
    }
    const result = await this.control.decisions.choose(
      {
        messageId: a.messageId,
        id: item.ref.slice("decision:".length),
        expectedRevision: a.expectedRevision,
        optionId: a.optionId,
        note: typeof a.note === "string" ? a.note : "",
        confirmDestructive: a.confirmDestructive === true,
      },
      { via: r.kind, channelId: r.id, channelOwner: owner },
    );
    return { ...result, text: answeredLine(result.decision) };
  }
}
