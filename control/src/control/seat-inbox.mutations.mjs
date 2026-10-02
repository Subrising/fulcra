// DESIGN-E §4 mutation run. Not a test file (no .test. in the name), so the ordinary sweep never runs it.
//
//   node src/control/seat-inbox.mutations.mjs
//
// For each mutation: apply exact-anchor edits to the working copy, run the named suite, require that the
// named test FAILS, then restore the original bytes -- always, in a finally. An anchor that does not occur
// exactly once aborts the run rather than silently mutating nothing, which is how a mutation list rots.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const B = path.join(here, "bindings.mjs"),
  C = path.join(here, "role-channels.mjs"),
  R = path.join(here, "rpc.mjs"),
  G = path.join(here, "admission-guard.mjs");
const Q = path.join(here, "quota-runtime.mjs");
const SUITE = path.join(here, "seat-inbox.test.mjs"),
  PERM = path.join(here, "permission-revocation.test.mjs");

const M = [
  {
    id: "E1",
    why: "hold not restricted to prime seats",
    expect: "E1 E19",
    edits: [
      [
        B,
        "    if (a.role !== 'prime') throw Error('Only a prime seat can be declared human-held');\n    seatIdentity(a.role, a.seat);",
        "    seatIdentity(a.role, a.seat);",
      ],
    ],
  },
  {
    id: "E2",
    why: "heldBy ignores the holder being under human control",
    expect: "E2:",
    edits: [
      [
        B,
        "    if (!s || s.mode !== 'human') return null;\n    return { role, seat, revision",
        "    if (!s) return null;\n    return { role, seat, revision",
      ],
    ],
  },
  {
    id: "E3a",
    why: "hold not pinned to the seat revision",
    expect: "E3:",
    edits: [
      [
        B,
        "    const h = this.db.prepare('SELECT * FROM seat_human_holds WHERE role=? AND seat=? AND revision=?').get(role, seat, b.revision);",
        "    const h = this.db.prepare('SELECT * FROM seat_human_holds WHERE role=? AND seat=?').get(role, seat);",
      ],
    ],
  },
  {
    id: "E3b",
    why: "hold not pinned to the holder session",
    expect: "E3:",
    edits: [[B, "    if (!h || h.session !== b.session) return null;", "    if (!h) return null;"]],
  },
  {
    id: "E4a",
    why: "the pump selects held rows",
    expect: "E4 E9",
    edits: [
      [
        C,
        `"SELECT * FROM role_channel_messages WHERE state='pending' ORDER BY rowid LIMIT 32"`,
        `"SELECT * FROM role_channel_messages WHERE state IN ('pending','held') ORDER BY rowid LIMIT 32"`,
      ],
    ],
  },
  {
    id: "E4b",
    why: "the held path writes a dispatchable state",
    expect: "E4 E9",
    edits: [
      [
        C,
        "held ? 'held' : 'reserved', new Date().toISOString());",
        "held ? 'pending' : 'reserved', new Date().toISOString());",
      ],
    ],
  },
  {
    id: "E5",
    why: "operator reply also written into role_channel_messages",
    expect: "E5 E12",
    edits: [
      [
        C,
        "          .run(a.messageId, a.channelId, fresh.primeSeat, hold.revision, hold.session, hold.generation, a.inReplyTo, recipient.id, recipient.generation, text, new Date().toISOString());",
        "          .run(a.messageId, a.channelId, fresh.primeSeat, hold.revision, hold.session, hold.generation, a.inReplyTo, recipient.id, recipient.generation, text, new Date().toISOString());\n        this.db.prepare(\"INSERT INTO role_channel_messages VALUES (?,?,?,?,?,?,?,?,?,'reserved',0,NULL,NULL,NULL,?,NULL,0)\").run(a.messageId, a.channelId, fresh.primeSeat, fresh.projectSeat, hold.session, recipient.id, recipient.generation, a.inReplyTo, text, new Date().toISOString());",
      ],
    ],
  },
  {
    id: "E6",
    why: "inReplyTo optional on seat-reply",
    expect: "E6 E7",
    edits: [
      [
        C,
        "if (!keys(a, 'channelId,expectedHolderGeneration,expectedSeatRevision,inReplyTo,messageId,text') || !uuid(a.channelId) || !uuid(a.messageId) || !uuid(a.inReplyTo)",
        "if (!(keys(a, 'channelId,expectedHolderGeneration,expectedSeatRevision,inReplyTo,messageId,text') || keys(a, 'channelId,expectedHolderGeneration,expectedSeatRevision,messageId,text')) || !uuid(a.channelId) || !uuid(a.messageId)",
      ],
    ],
  },
  {
    id: "E7",
    why: "a second reply to the same parent allowed",
    expect: "E6 E7",
    edits: [
      [
        C,
        "        if (this.db.prepare(\"SELECT id FROM seat_operator_acts WHERE kind='reply' AND parent=?\").get(a.inReplyTo)) throw Error('That message already has an operator reply; one reply answers one message');\n",
        "",
      ],
      [
        C,
        "CREATE UNIQUE INDEX IF NOT EXISTS seat_operator_acts_parent",
        "CREATE INDEX IF NOT EXISTS seat_operator_acts_parent",
      ],
    ],
  },
  {
    id: "E8",
    why: "reply parent not constrained to a message for the seat",
    expect: "E6 E7",
    edits: [[C, " || parent.toSession !== hold.session || parent.toSeat !== record.primeSeat", ""]],
  },
  {
    id: "E9",
    why: "reply spends no channel allowance",
    expect: "E5 E12",
    edits: [
      [
        C,
        "        const spent = this.db.prepare('UPDATE role_channels SET used=used+1 WHERE id=? AND used=?').run(a.channelId, fresh.used);\n        if (Number(spent.changes) !== 1 || this.row(a.channelId).used !== fresh.used + 1) throw Error('Channel allowance changed during reservation');\n        this.db.prepare(\"INSERT INTO seat_operator_acts",
        '        this.db.prepare("INSERT INTO seat_operator_acts',
      ],
    ],
  },
  {
    id: "E10",
    why: "reply ignores the seat revision and holder generation pins",
    expect: "E6 E7",
    edits: [
      [
        C,
        "    if (hold.revision !== pin.revision) throw new SourceChanged('The prime seat changed since this reply was prepared');\n    if (hold.generation !== pin.generation) throw new SourceChanged('The holder session control changed since this reply was prepared');\n",
        "",
      ],
    ],
  },
  {
    id: "E11",
    why: "seat-reply reachable without the operator secret",
    expect: "E11",
    edits: [
      [
        R,
        "    if (request.method === 'inspect') {",
        "    if (request.method === 'seat-reply') return control.channels.seatReply(a);\n    if (request.method === 'inspect') {",
      ],
    ],
  },
  {
    id: "E12",
    why: "thread labels an operator reply as a delegated seat message",
    expect: "E5 E12",
    edits: [
      [
        C,
        ".concat(acts.map(x => ({ messageId: x.id, origin: OPERATOR_ORIGIN,",
        ".concat(acts.map(x => ({ messageId: x.id, origin: DELEGATED_ORIGIN,",
      ],
    ],
  },
  {
    id: "E13",
    why: "hold without a history row",
    expect: "E1 E19",
    edits: [
      [
        B,
        "      this.db.prepare('INSERT INTO role_binding_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), a.role, a.seat, null, current.task, 'hold', current.session, current.session, current.revision, current.revision, note, at);\n",
        "",
      ],
    ],
  },
  {
    id: "E14",
    why: "hold bumps the seat revision",
    expect: "E1 E19",
    edits: [
      [
        B,
        "      this.db.prepare('INSERT INTO seat_human_holds VALUES (?,?,?,?,?,?)').run(a.role, a.seat, current.revision, current.session, note, at);",
        "      this.db.prepare('INSERT INTO seat_human_holds VALUES (?,?,?,?,?,?)').run(a.role, a.seat, current.revision, current.session, note, at);\n      this.db.prepare('UPDATE role_bindings SET revision=revision+1 WHERE role=? AND seat=?').run(a.role, a.seat);",
      ],
    ],
  },
  {
    id: "E15",
    why: "a human prime without a hold treated as held",
    expect: "E15",
    edits: [
      [
        C,
        "? this.heldFor(record.primeSeat, recipient.id) : null;",
        "? (this.heldFor(record.primeSeat, recipient.id) ?? { session: recipient.id, generation: recipient.generation }) : null;",
      ],
      [
        C,
        "        if (!again || now?.mode !== 'human' || now.generation !== held.generation) throw",
        "        if (now?.mode !== 'human' || now.generation !== held.generation) throw",
      ],
    ],
  },
  {
    id: "E16a",
    why: "pending-to-held conversion without the hold check",
    expect: "E16",
    edits: [
      [
        C,
        "m.toSeat === record.primeSeat && Boolean(this.heldFor(record.primeSeat, recipient.id));",
        "m.toSeat === record.primeSeat;",
      ],
    ],
  },
  {
    id: "E16b",
    why: "pending-to-held conversion for any seat, not only the prime side",
    expect: "E16",
    edits: [
      [
        C,
        "recipient.mode !== 'delegated' && m.toSeat === record.primeSeat && Boolean(this.heldFor(record.primeSeat, recipient.id));",
        "recipient.mode !== 'delegated';",
      ],
    ],
  },
  {
    id: "E16c",
    why: "mid-pass conversion without the hold check",
    expect: "E16",
    edits: [
      [
        C,
        "this.store.get(m.toSession)?.mode === 'human' && this.heldFor(record.primeSeat, m.toSession) && !this.store.delivery(m.messageId))",
        "this.store.get(m.toSession)?.mode === 'human' && !this.store.delivery(m.messageId))",
      ],
    ],
  },
  {
    id: "E16d",
    why: "pending-to-held conversion skips the originator checks",
    expect: "E16",
    edits: [
      [
        C,
        "      if (!toHold && (!recipient || recipient.mode !== 'delegated' || recipient.generation !== m.toGeneration)) { fail('Receiving seat control changed before this message could be delivered'); continue; }",
        "      if (toHold) { this.db.prepare(\"UPDATE role_channel_messages SET state='held' WHERE messageId=? AND state='pending'\").run(m.messageId); continue; }\n      if (!toHold && (!recipient || recipient.mode !== 'delegated' || recipient.generation !== m.toGeneration)) { fail('Receiving seat control changed before this message could be delivered'); continue; }",
      ],
    ],
  },
  {
    id: "E17",
    why: "seat-reply dispatches natively instead of through control.send",
    expect: "E17 T5",
    edits: [
      [
        C,
        "      const delivery = await this.control.send({ sessionId: act.toSession, messageId: act.id, text: body }, undefined, act.toGeneration,",
        "      const delivery = await (async () => { await this.control.native.send(act.toSession, body, act.id); return { state: 'delivered', result: {} }; })() ?? await this.control.send({ sessionId: act.toSession, messageId: act.id, text: body }, undefined, act.toGeneration,",
      ],
    ],
  },
  {
    id: "E18",
    why: "held inbound skips the sender authority re-derivation",
    expect: "E18",
    edits: [
      [
        C,
        "    // Checked before the reservation below, so a changed sender authority costs no allowance.\n    await this.assertSenderAuthority(sender.id);",
        "    if (!held) await this.assertSenderAuthority(sender.id);",
      ],
    ],
  },
  {
    id: "E19",
    why: "hold accepts a delegated holder",
    expect: "E1 E19",
    edits: [
      [
        B,
        "      if (s.mode !== 'human') throw Error('A seat is declared human-held only while its holder is under human control; a delegated holder receives and sends as itself');\n",
        "",
      ],
    ],
  },
  {
    id: "E20",
    why: "no re-check of the hold inside the reservation transaction",
    expect: "E20",
    edits: [
      [
        C,
        "      if (held) {\n        const now = this.store.get(recipient.id)",
        "      if (false) {\n        const now = this.store.get(recipient.id)",
      ],
    ],
  },
  {
    id: "E21",
    why: "admission guard edited",
    expect: "E21",
    edits: [
      [G, "export const BOOT = randomUUID();", "export const BOOT = randomUUID(); // edited"],
    ],
  },
  {
    id: "E22",
    why: "a hold writes session control",
    expect: "E22",
    edits: [
      [
        B,
        "      this.db.prepare('INSERT INTO seat_human_holds VALUES (?,?,?,?,?,?)').run(a.role, a.seat, current.revision, current.session, note, at);",
        "      this.db.prepare('INSERT INTO seat_human_holds VALUES (?,?,?,?,?,?)').run(a.role, a.seat, current.revision, current.session, note, at);\n      this.db.prepare('UPDATE sessions SET grantedAt=coalesce(grantedAt,0)+1 WHERE id=?').run(current.session);",
      ],
    ],
  },
  // ---- E-REVIEW.md §5: the reviewer's hand variants of the attacker set, now required to be killed by
  // seat-inbox.test.mjs alone. H-E2b, H-E20b and H-E20c are the reviewer's own equivalent mutants and are
  // listed in IMPLEMENTATION-E.md rather than here, because no test can distinguish them.
  {
    id: "H-E4a",
    why: "pump turns held -> pending beside a pending row",
    expect: "Q5b",
    edits: [
      [
        C,
        "      if (toHold) { this.db.prepare(\"UPDATE role_channel_messages SET state='held'",
        "      this.db.prepare(\"UPDATE role_channel_messages SET state='pending' WHERE state='held' AND toSession=?\").run(m.toSession);\n      if (toHold) { this.db.prepare(\"UPDATE role_channel_messages SET state='held'",
      ],
    ],
  },
  {
    id: "H-E4b",
    why: "sender same-id resend re-queues a held row once the prime is delegated",
    expect: "Q5 ",
    edits: [
      [
        C,
        "    const prior = this.message(a.channelId, a.messageId);\n    if (prior && prior.fromSession === sender.id",
        "    const prior = this.message(a.channelId, a.messageId);\n    if (prior && prior.state === 'held' && this.store.get(prior.toSession)?.mode === 'delegated') { this.db.prepare(\"UPDATE role_channel_messages SET state='pending' WHERE messageId=?\").run(prior.messageId); await this.pump(); }\n    if (prior && prior.fromSession === sender.id",
      ],
    ],
  },
  {
    id: "H-E4c",
    why: "pump pre-pass releases every held row to a delegated recipient",
    expect: "E4 E9",
    edits: [
      [
        C,
        "    const inspected = new Map(), authorised = new Map();",
        "    const inspected = new Map(), authorised = new Map();\n    for (const s of this.db.prepare(\"SELECT DISTINCT toSession FROM role_channel_messages WHERE state='held'\").all()) if (this.store.get(s.toSession)?.mode === 'delegated') this.db.prepare(\"UPDATE role_channel_messages SET state='pending' WHERE state='held' AND toSession=?\").run(s.toSession);",
      ],
    ],
  },
  {
    id: "X-held-via-resend",
    why: "D idempotent resend dispatches a held row once the prime is delegated",
    expect: "Q5 ",
    edits: [
      [
        C,
        "    const prior = this.message(a.channelId, a.messageId);\n    if (prior && prior.fromSession === sender.id",
        "    const prior = this.message(a.channelId, a.messageId);\n    if (prior && prior.state === 'held' && prior.fromSession === sender.id && prior.text === a.text && this.store.get(prior.toSession)?.mode === 'delegated') { this.db.prepare(\"UPDATE role_channel_messages SET state='reserved' WHERE messageId=?\").run(prior.messageId); const d = await this.control.send({ sessionId: prior.toSession, messageId: prior.messageId, text: prior.text }, undefined, this.store.get(prior.toSession).generation, { channel: { channelId: a.channelId, fromSeat: prior.fromSeat, toSeat: prior.toSeat, fromSession: sender.id, inReplyTo: prior.inReplyTo ?? null }, source: { kind: 'role-channel', channelId: a.channelId, fromSeat: prior.fromSeat, toSeat: prior.toSeat, fromSession: sender.id, inReplyTo: prior.inReplyTo ?? null } }).catch(e => ({ state: 'failed' })); this.db.prepare('UPDATE role_channel_messages SET state=? WHERE messageId=?').run(d.state, prior.messageId); return { channelId: a.channelId, messageId: a.messageId, state: d.state, resend: true }; }\n    if (prior && prior.fromSession === sender.id",
      ],
    ],
  },
  {
    id: "H-E6",
    why: "a missing parent row accepted",
    expect: "E6 E7",
    edits: [
      [
        C,
        "    if (!parent || parent.channel !== record.id ||",
        "    if (parent && (parent.channel !== record.id ||",
      ],
      [
        C,
        "!['held', 'delivered'].includes(parent.state)) throw new SourceChanged('A reply answers",
        "!['held', 'delivered'].includes(parent.state))) throw new SourceChanged('A reply answers",
      ],
      [
        C,
        "WHERE fromSession=? AND inReplyTo=? LIMIT 1').get(hold.session, parent.messageId)",
        "WHERE fromSession=? AND inReplyTo=? LIMIT 1').get(hold.session, parent?.messageId)",
      ],
    ],
  },
  {
    id: "H-E6b",
    why: "an operator act accepted as a parent (operator chains its own words)",
    expect: "Q1 ",
    edits: [
      [
        C,
        "      const parent = this.message(a.channelId, a.inReplyTo);\n      this.assertUsable(record);",
        "      const parent = this.message(a.channelId, a.inReplyTo) ?? this.db.prepare(\"SELECT id messageId, channel, 'delivery' toSeat, holderSession toSession, 'held' state FROM seat_operator_acts WHERE id=?\").get(a.inReplyTo);\n      this.assertUsable(record);",
      ],
      [
        C,
        "        const hold = this.assertReplyable(fresh, this.message(a.channelId, a.inReplyTo), pin);",
        "        const hold = this.assertReplyable(fresh, this.message(a.channelId, a.inReplyTo) ?? parent, pin);",
      ],
      [
        C,
        "check: () => this.assertReplyable(this.row(act.channel), this.message(act.channel, act.parent), pin) });",
        "check: () => this.assertReplyable(this.row(act.channel), this.message(act.channel, act.parent) ?? { messageId: act.parent, channel: act.channel, toSession: act.holderSession, toSeat: act.seat, state: 'held' }, pin) });",
      ],
    ],
  },
  {
    id: "H-E11",
    why: "seat-inbox and seat-hold routed before the operator gate",
    expect: "E11",
    edits: [
      [
        R,
        "    if (request.method === 'inspect') {",
        "    if (request.method === 'seat-inbox') return control.channels.inbox(a);\n    if (request.method === 'seat-hold') return control.bindings.hold(a);\n    if (request.method === 'inspect') {",
      ],
    ],
  },
  {
    id: "H-E11b",
    why: "a new capability-gated method that calls seatReply",
    expect: "Q8 ",
    edits: [
      [
        R,
        "    if (request.method === 'channels-thread') return control.channels.thread(a, request.capability);",
        "    if (request.method === 'channels-thread') return control.channels.thread(a, request.capability);\n    if (request.method === 'channels-reply-held') { control.bindings.checkRole(a.sessionId, request.capability); const { sessionId, ...rest } = a; return control.channels.seatReply(rest); }",
      ],
    ],
  },
  {
    id: "H-E17",
    why: "reply journaled and dispatched natively, bypassing control.send",
    expect: "E17 T5",
    edits: [
      [
        C,
        "      const delivery = await this.control.send({ sessionId: act.toSession, messageId: act.id, text: body }, undefined, act.toGeneration,\n        { source: { kind: 'direct' }, neverPark: true, check: () => this.assertReplyable(this.row(act.channel), this.message(act.channel, act.parent), pin) });",
        "      this.store.admit(act.id, act.toSession, 'send', { sessionId: act.toSession, messageId: act.id, text: body });\n      this.store.finish(act.id, 'intent', { generation: act.toGeneration, expectedLastUserAt: null, outputContext: {} });\n      await this.control.native.send(act.toSession, body, act.id);\n      const delivery = this.store.finish(act.id, 'delivered', { generation: act.toGeneration });",
      ],
    ],
  },
  {
    id: "H-E17b",
    why: "control.send used but the H check() dropped",
    expect: "Q6 ",
    edits: [
      [
        C,
        "{ source: { kind: 'direct' }, neverPark: true, check: () => this.assertReplyable(this.row(act.channel), this.message(act.channel, act.parent), pin) });",
        "{ source: { kind: 'direct' }, neverPark: true });",
      ],
    ],
  },
  {
    id: "H-E17c",
    why: "control.send uses the recipient CURRENT generation, not the pinned one",
    expect: "Q7 ",
    edits: [
      [
        C,
        "      const delivery = await this.control.send({ sessionId: act.toSession, messageId: act.id, text: body }, undefined, act.toGeneration,",
        "      const delivery = await this.control.send({ sessionId: act.toSession, messageId: act.id, text: body }, undefined, this.store.get(act.toSession)?.generation,",
      ],
    ],
  },
  {
    id: "X-reply-after-unhold",
    why: "reply allowed after seat-unhold while the holder is still human",
    expect: "A6 ",
    edits: [
      [
        C,
        "    const hold = this.heldFor(record.primeSeat, record.primeSession);\n    if (!hold) throw",
        "    const hold = this.heldFor(record.primeSeat, record.primeSession) ?? (this.store.get(record.primeSession)?.mode === 'human' ? { revision: pin.revision, generation: pin.generation, session: record.primeSession } : null);\n    if (!hold) throw",
      ],
    ],
  },
  {
    id: "X-envelope-omit",
    why: "native text without the controller envelope",
    expect: "E5 E12",
    edits: [
      [
        C,
        "const body = operatorEnvelope(record.primeSeat, record.primeSession, a.messageId, a.inReplyTo) + text;",
        "const body = text;",
      ],
    ],
  },
  // ---- Prime decisions on the review ----
  {
    id: "F1",
    why: "operator reply to a parent the holder already answered natively",
    expect: "F1:",
    edits: [
      [
        C,
        "    if (this.db.prepare('SELECT messageId FROM role_channel_messages WHERE fromSession=? AND inReplyTo=? LIMIT 1').get(hold.session, parent.messageId)) throw",
        "    if (false) throw",
      ],
    ],
  },
  {
    id: "F2a",
    why: "seat reply does not declare neverPark",
    expect: "F2:",
    edits: [
      [
        C,
        "{ source: { kind: 'direct' }, neverPark: true, check:",
        "{ source: { kind: 'direct' }, check:",
      ],
    ],
  },
  {
    id: "F2b",
    why: "quota admission ignores neverPark",
    expect: "F2:",
    edits: [
      [
        Q,
        "    if (supervision?.neverPark) throw new RecipientBusy(",
        "    if (false) throw new RecipientBusy(",
      ],
    ],
  },
  {
    id: "F3a",
    why: "unread operator replies not counted in channels-list",
    expect: "F3:",
    edits: [[C, ".get(r.id, row.id).n + operatorUnread;", ".get(r.id, row.id).n;"]],
  },
  {
    id: "F3b",
    why: "operator acts absent from channels-status",
    expect: "F3:",
    edits: [
      [
        C,
        "      operatorActs: this.db.prepare('SELECT id,kind,",
        "      operatorActsHidden: this.db.prepare('SELECT id,kind,",
      ],
    ],
  },
  {
    id: "F4a",
    why: "a failure that admitted nothing burns the parent",
    expect: "F4:",
    edits: [
      [
        C,
        "    else this.db.prepare(\"UPDATE seat_operator_acts SET kind='void-reply',state='failed',failure=? WHERE id=?\")",
        "    else this.db.prepare(\"UPDATE seat_operator_acts SET state='failed',failure=? WHERE id=?\")",
      ],
    ],
  },
  {
    id: "F4b",
    why: "a failure AT the native boundary is voided too",
    expect: "F4:",
    edits: [
      [
        C,
        "    if (this.store.delivery(act.id)) this.db.prepare(\"UPDATE seat_operator_acts SET state='failed',failure=? WHERE id=?\")",
        "    if (false) this.db.prepare(\"UPDATE seat_operator_acts SET state='failed',failure=? WHERE id=?\")",
      ],
    ],
  },
  {
    id: "F4c",
    why: "the unique parent index made non-partial again",
    expect: "F4:",
    edits: [
      [
        C,
        "ON seat_operator_acts(kind,parent) WHERE kind IN ('reply','receipt')\");",
        'ON seat_operator_acts(kind,parent)");',
      ],
      [
        C,
        "    if (index && !/WHERE/i.test(index.sql)) this.db.exec('DROP INDEX seat_operator_acts_parent');\n",
        "",
      ],
    ],
  },
  {
    id: "F4d",
    why: "no in-flight guard: a concurrent identical resend dispatches or overwrites",
    expect: "F4:",
    edits: [
      [
        C,
        "      if (prior.state !== 'busy' || this.replying.has(prior.id)) return this.publishReply(prior, true);",
        "      if (prior.state !== 'busy') return this.publishReply(prior, true);",
      ],
    ],
  },
  {
    id: "F5a",
    why: "reconcile voids even a reply that was dispatched",
    expect: "F5:",
    edits: [
      [
        C,
        "      if (delivery) this.db.prepare('UPDATE seat_operator_acts SET state=?,failure=? WHERE id=?').run(delivery.state, delivery.result?.error ?? null, act.id);\n      else this.settleFailure",
        "      this.settleFailure",
      ],
    ],
  },
  {
    id: "F5b",
    why: "an identical resend re-dispatches a reserved act",
    expect: "F5:",
    edits: [
      [
        C,
        "      if (prior.state !== 'busy' || this.replying.has(prior.id)) return",
        "      if (!['busy', 'reserved'].includes(prior.state) || this.replying.has(prior.id)) return",
      ],
    ],
  },
  {
    id: "F5c",
    why: "reconcile reachable without the operator secret",
    expect: "F5:",
    edits: [
      [
        R,
        "    if (request.method === 'inspect') {",
        "    if (request.method === 'seat-reply-reconcile') return control.channels.reconcileReply(a);\n    if (request.method === 'inspect') {",
      ],
    ],
  },
  {
    id: "E23",
    why: "raw permission answers exempted from human input (option 3b)",
    expect: "REPRODUCTION",
    suite: PERM,
    edits: [
      [G, "{ guard(agent, '', undefined, false); return requestId; }", "{ return requestId; }"],
    ],
  },
];

function failing(suite) {
  let out;
  try {
    out = execFileSync(process.execPath, ["--test", "--test-reporter=tap", suite], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = String(e.stdout ?? "");
  }
  return [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((x) => x[1]);
}
const only = process.argv.slice(2);
let bad = 0;
for (const m of M.filter((x) => !only.length || only.includes(x.id))) {
  const originals = new Map();
  try {
    for (const [file, from, to] of m.edits) {
      const text = originals.get(file) ?? fs.readFileSync(file, "utf8");
      originals.set(file, text);
      const current = fs.readFileSync(file, "utf8");
      if (current.split(from).length !== 2)
        throw Error(`${m.id}: anchor does not occur exactly once in ${path.basename(file)}`);
      fs.writeFileSync(
        file,
        current.replace(from, () => to),
      );
    }
    const failed = failing(m.suite ?? SUITE),
      killed = failed.some((name) => name.includes(m.expect));
    if (!killed) bad++;
    console.log(
      `${killed ? "KILLED  " : "SURVIVED"} ${m.id.padEnd(5)} ${m.why} -> expected red: "${m.expect}"; red: ${failed.length ? failed.map((n) => n.slice(0, 40)).join(" | ") : "none"}`,
    );
  } finally {
    for (const [file, text] of originals) fs.writeFileSync(file, text);
  }
}
console.log(bad ? `${bad} mutation(s) SURVIVED` : "all mutations killed");
process.exitCode = bad ? 1 : 0;
