// Fulcra Command Centre J3 (CONTRACTS.md §3, §4.2): the decision store, the one inbox the owner sees, held
// prime messages in that inbox, and the daily digest. The controller is the only authority for a decision:
// the plugin and any future channel are views that post an item and return an answer, and every rule of
// §3.2 is enforced HERE, whatever the caller already checked.
//
// Who acts is derived, never read from input:
//   - the operator gate (rpc.mjs, the Fulcra app's socket path) is `human`;
//   - a role-lane capability is `seat:<slug>` for the seat that session holds, else `session:<uuid>`.
// An agent can therefore ask, read and withdraw its own packets, and can never choose one the owner was asked.
import { setChannelTitle } from "./channel-titles.mjs";
import { randomUUID, createHash } from "node:crypto";
import { uuid, RecipientBusy, SourceChanged } from "./authority.mjs";
import { assertColumns } from "./schema.mjs";
import { readProjectDirectory } from "./projects.mjs";
import { JOURNAL_CAPACITY, deliveryCount } from "./journal-capacity.mjs";
import {
  validateAsk,
  canonicalJson,
  actionTarget,
  PacketRefused,
  LIMITS,
  FREE_TEXT_OPTION,
  KEY,
  VIA,
} from "../../orca-organization/shared/cc/decision-rules.mjs";
import { personalMatch } from "../../orca-organization/shared/cc/refs.mjs";
import { ProofRefused } from "./devices.mjs";
import {
  alreadyAnswered,
  answerSummary,
  proven,
} from "../../orca-organization/shared/cc/channel-text.mjs";
import { deviceLine } from "../../orca-organization/shared/cc/device-text.mjs";
import { heldSubject } from "./held-subject.mjs";
import { ownerAttested } from "./inbox-channels.mjs";
import { describeFailure } from "./management-refusal.mjs";
import { configuredDefaults } from "./provider-mode.mjs";
import { installationConfig } from "./installation-settings.mjs";
const keys = (a, names) =>
  a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).sort().join() === names;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// Bounded like every other controller table. Writes stop only at the cap, and the refusal says so; at 90%
// the inbox carries an attention item (CONTRACTS §1 Capacity).
// Authored tables are bounded (the refusal is shown); derived digests rotate instead (CONTRACTS v1.5 §1 Capacity).
// G4 review record: the fields, the three choices as options, and the repository shape GitHub allows.
const REVIEW_FIELDS = Object.freeze([
  "workspace",
  "repo",
  "number",
  "headSha",
  "choice",
  "note",
  "projectId",
]);
const REVIEW_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REVIEW_CHOICES = Object.freeze({
  approve: { id: "approve", title: "Approve", summary: "You approved this pull request." },
  request_changes: {
    id: "request-changes",
    title: "Request changes",
    summary: "You asked for changes before it goes in.",
  },
  comment: {
    id: "comment",
    title: "Comment",
    summary: "You left a comment without approving or asking for changes.",
  },
});
const REVIEW_IMPACTS = Object.freeze({
  benefit: "Your review is on record in Fulcra",
  cost: "None",
  time: "Now",
  risk: "None: it is a record only",
  reversibility: "reversible",
  blastRadius: null,
});
const APP_VIA_LIST = Object.freeze([
  "app-mac",
  "app-ios",
  "app-android",
  "app-windows",
  "app-linux",
  "app-web",
]);
export const DECISION_LIMITS = Object.freeze({ decisions: 5000, history: 25000, deliveries: 5000 });
export const DIGESTS_KEPT = 60;
export const STALE_REVISION = "Changed since you looked; refresh";
export const DIGEST_CHANGED = "This changed after you were asked";
export const NO_UPDATE = "No project update was written today";
export const CONFIRM_ON_DEVICE = "Confirm this on your paired device";
const DEVICE_VIA = Object.freeze({
  macos: "app-mac",
  ios: "app-ios",
  android: "app-android",
  windows: "app-windows",
  linux: "app-linux",
});
export const OPERATOR_LABEL =
  "answered by the operator, not confirmed on the owner's paired device";
const HELD_URGENT_MS = 3600000;
const DECISION_COLUMNS =
  "id,state,projectId,askedOf,level,createdAt,updatedAt,revision,askedBySession,askMessageId,json";
const HISTORY_COLUMNS = "id,entityId,action,before,after,previousRevision,revision,actor,note,at";
const DELIVERY_COLUMNS =
  "id,decisionId,revision,session,state,attempts,lastError,createdAt,at,deliveredAt";
const DIGEST_COLUMNS = "id,projectId,periodStart,periodEnd,json";
// The delivery identity of decision.chosen for one chosen revision. Derived, never random, so a retry after a
// crash between the choice and the send reuses the same controller delivery row and can never send twice.
export function chosenDeliveryId(decisionId, revision) {
  const h = sha256(`fulcra decision.chosen\n${decisionId}\n${revision}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 + (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
// v1.8 R2-7: "Already answered on iPhone at 09:14" only for a proven answer; otherwise it says the operator answered.
export const answeredText = (choice) => alreadyAnswered(choice);
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export class Decisions {
  // pumpEveryMs / composeEveryMs throttle the background pass (v1.5 #8); tests set them to 0.
  constructor(
    control,
    {
      now = Date.now,
      readProjects = readProjectDirectory,
      digestAt = {},
      pumpEveryMs = 5000,
      composeEveryMs = 60000,
      busyRetryMs = 15000,
      archiveProbeMs = 600000,
    } = {},
  ) {
    this.busyRetryMs = busyRetryMs;
    this.archiveProbeMs = archiveProbeMs;
    this.nextTry = new Map();
    this.archiveProbed = new Map();
    this.pumpEveryMs = pumpEveryMs;
    this.composeEveryMs = composeEveryMs;
    this.lastPump = -Infinity;
    this.lastCompose = -Infinity;
    // Per digest target ('' = All work): the slot already composed or found quiet, so it is not recomposed.
    this.settled = new Map();
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.now = now;
    this.readProjects = readProjects;
    // Local digest time per project (HH:MM, host timezone); `default` covers the rest. CONTRACTS §4.2: 08:00.
    this.digestAt = { default: "08:00", ...digestAt };
    // Bound actions (§3.2 #4). Each owning job registers how to read its bound object; nothing is bound until
    // it does, and a packet naming an unregistered kind is refused at ask time rather than accepted unchecked.
    this.binders = new Map();
    this.inFlight = new Set();
    this.pumping = null;
    this.delivering = Promise.resolve();
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS cc_decisions(id TEXT PRIMARY KEY,state TEXT NOT NULL,projectId TEXT,askedOf TEXT NOT NULL,level INTEGER NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,revision INTEGER NOT NULL,askedBySession TEXT NOT NULL,askMessageId TEXT UNIQUE NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cc_decisions_state ON cc_decisions(state,askedOf,level);
      CREATE TABLE IF NOT EXISTS cc_decision_history(id TEXT PRIMARY KEY,entityId TEXT NOT NULL,action TEXT NOT NULL,before TEXT,after TEXT NOT NULL,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_decision_deliveries(id TEXT PRIMARY KEY,decisionId TEXT NOT NULL,revision INTEGER NOT NULL,session TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,lastError TEXT,createdAt TEXT NOT NULL,at TEXT NOT NULL,deliveredAt TEXT,UNIQUE(decisionId,revision));
      CREATE TABLE IF NOT EXISTS cc_digests(id TEXT PRIMARY KEY,projectId TEXT,periodStart TEXT NOT NULL,periodEnd TEXT NOT NULL,json TEXT NOT NULL);`);
    assertColumns(this.db, "cc_decisions", DECISION_COLUMNS);
    assertColumns(this.db, "cc_decision_history", HISTORY_COLUMNS);
    assertColumns(this.db, "cc_decision_deliveries", DELIVERY_COLUMNS);
    assertColumns(this.db, "cc_digests", DIGEST_COLUMNS);
  }
  iso() {
    return new Date(this.now()).toISOString();
  }
  count(table) {
    return Number(this.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  }
  row(id) {
    return this.db.prepare("SELECT * FROM cc_decisions WHERE id=?").get(id) ?? null;
  }
  packet(id) {
    const r = this.row(id);
    return r ? JSON.parse(r.json) : null;
  }
  // The asker, from the grant. A seated session asks as its seat so a refreshed holder keeps the thread.
  asker(sessionId, capability) {
    const s = this.control.bindings.checkRole(sessionId, capability);
    const seat =
      this.db
        .prepare("SELECT seat FROM role_bindings WHERE session=? ORDER BY role,seat LIMIT 1")
        .get(s.id)?.seat ?? null;
    return {
      sessionId: s.id,
      seat: seat && KEY.test(seat) ? seat : null,
      actor: seat && KEY.test(seat) ? `seat:${seat}` : `session:${s.id}`,
    };
  }
  // §3.2 #5: the asking session, or whoever holds the asking seat now.
  // A packet the controller asked itself (askSystem, v1.15) has no asking session: no session, and no seat holder, is
  // its asker, so none can withdraw or supersede it.
  isAsker(p, who) {
    if (p.askedBy.system) return false;
    return (
      p.askedBy.sessionId === who.sessionId ||
      (p.askedBy.seat !== null && p.askedBy.seat === who.seat)
    );
  }
  assertCapacity(table, limit, what) {
    if (this.count(table) >= limit)
      throw Error(
        `The ${what} is full (${limit}); nothing was recorded. Ask the operator to archive old decisions`,
      );
  }
  history(id, entityId, action, before, after, previousRevision, revision, actor, note, at) {
    this.db
      .prepare("INSERT INTO cc_decision_history VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        entityId,
        action,
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
        previousRevision,
        revision,
        actor,
        note,
        at,
      );
  }
  write(p, action, actor, note, historyId = randomUUID(), before = null) {
    const at = p.updatedAt;
    this.db
      .prepare("UPDATE cc_decisions SET state=?,revision=?,updatedAt=?,json=? WHERE id=?")
      .run(p.state, p.revision, at, JSON.stringify(p), p.id);
    // J3b answered everywhere: in the same transaction, every channel post of this item now owes one update.
    if (p.state !== "open") this.control.inboxChannels?.closed(p);
    this.history(
      historyId,
      p.id,
      action,
      before,
      p,
      before?.revision ?? p.revision - 1,
      p.revision,
      actor,
      note,
      at,
    );
  }
  async bound(action) {
    if (action.type === "none") return null;
    const bind = this.binders.get(action.type);
    if (typeof bind !== "function")
      throw new PacketRefused(
        `Nothing can be bound to a ${action.type} action yet; ask without an action, or once that feature is installed`,
      );
    const object = await bind(actionTarget(action));
    return object == null ? null : sha256(canonicalJson(object));
  }

  // ---- Agent side (role lane) -------------------------------------------------------------------------------
  async ask(a, capability) {
    if (
      !a ||
      typeof a !== "object" ||
      Array.isArray(a) ||
      Object.keys(a).some((k) => !["sessionId", "messageId", "packet", "supersedes"].includes(k)) ||
      !uuid(a.messageId) ||
      (a.supersedes !== undefined && !uuid(a.supersedes))
    )
      throw Error("Invalid decision ask; it takes messageId, packet and optionally supersedes");
    return this.askAs(a, this.asker(a.sessionId, capability));
  }
  // CONTRACTS v1.15 §3.3: a controller component (J2's refresh, J8's promotions) asks the owner itself. There is NO
  // asking session: askedBy = {seat, sessionId: null, system: component}. No session can withdraw, supersede or veto
  // it, and its choice is never delivered to a session; the component consumes it (systemChoice / approvalFor).
  // Controller-internal: rpc.mjs never reaches it, so no request can name a component.
  async askSystem({ component, messageId, packet, ...extra } = {}, { seat = null } = {}) {
    if (
      Object.keys(extra).length ||
      !/^[a-z][a-z0-9-]{1,31}$/.test(component ?? "") ||
      !uuid(messageId)
    )
      throw Error("Invalid system ask; it takes component, messageId and packet");
    if (seat !== null && !KEY.test(seat)) throw Error("Invalid system ask seat");
    return this.askAs(
      { messageId, packet },
      { sessionId: null, seat, system: component, actor: `system:${component}` },
    );
  }
  // The component's own read of a packet it asked: its state and, once chosen, the choice. Nobody else's packet.
  systemChoice({ component, decisionId }) {
    const p = uuid(decisionId) ? this.packet(decisionId) : null;
    if (!p || p.askedBy.system !== component)
      throw Error("No decision this component asked has that id");
    return { decision: this.publicPacket(p) };
  }
  async askAs(a, who) {
    const { packet: body, warnings } = validateAsk(a.packet);
    // §3.2 #4 at ask time: the digest the asker states must be the digest of the bound object now.
    if (body.action.type !== "none") {
      const current = await this.bound(body.action);
      if (current === null) throw new PacketRefused("The bound action no longer exists");
      if (current !== body.action.digest)
        throw new PacketRefused(`${DIGEST_CHANGED}: the stated digest is not the current one`);
    }
    const fingerprint = canonicalJson({ body, supersedes: a.supersedes ?? null });
    return this.store.atomic(() => {
      const prior = this.db
        .prepare("SELECT * FROM cc_decisions WHERE askMessageId=?")
        .get(a.messageId);
      if (prior) {
        const asked = this.db
          .prepare("SELECT after FROM cc_decision_history WHERE id=? AND action='asked'")
          .get(a.messageId);
        if (
          prior.askedBySession !== (who.system ? `system:${who.system}` : who.sessionId) ||
          !asked ||
          JSON.parse(asked.after).fingerprint !== fingerprint
        )
          throw Error("Message identity already used");
        return { decision: this.publicPacket(JSON.parse(prior.json)), warnings, resend: true };
      }
      if (this.db.prepare("SELECT id FROM cc_decision_history WHERE id=?").get(a.messageId))
        throw Error("Message identity already used");
      this.assertCapacity("cc_decisions", DECISION_LIMITS.decisions, "decision store");
      this.assertCapacity("cc_decision_history", DECISION_LIMITS.history, "decision history");
      const at = this.iso(),
        id = randomUUID();
      let superseded = null;
      if (a.supersedes) {
        superseded = this.packet(a.supersedes);
        if (!superseded || !this.isAsker(superseded, who))
          throw Error("Only the asker can supersede a decision");
        if (superseded.state !== "open")
          throw Error(`That decision is ${superseded.state}; only an open one can be superseded`);
      }
      const askedBy = who.system
        ? { seat: who.seat, sessionId: null, system: who.system }
        : { seat: who.seat, sessionId: who.sessionId };
      const p = {
        version: 1,
        id,
        revision: 1,
        ...body,
        askedBy,
        state: "open",
        supersededBy: null,
        choice: null,
        delivery: null,
        createdAt: at,
        updatedAt: at,
      };
      // Key order as §3.1 writes it, so a stored packet reads like the contract.
      const ordered = {
        version: 1,
        id,
        revision: 1,
        kind: p.kind,
        level: p.level,
        projectId: p.projectId,
        taskId: p.taskId,
        askedBy: p.askedBy,
        askedOf: p.askedOf,
        title: p.title,
        situation: p.situation,
        options: p.options,
        recommendation: p.recommendation,
        evidence: p.evidence,
        action: p.action,
        expiresAt: p.expiresAt,
        state: "open",
        supersededBy: null,
        choice: null,
        delivery: null,
        createdAt: at,
        updatedAt: at,
      };
      this.db
        .prepare("INSERT INTO cc_decisions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          "open",
          p.projectId,
          p.askedOf === "human" ? "human" : `seat:${p.askedOf.seat}`,
          p.level,
          at,
          at,
          1,
          who.system ? `system:${who.system}` : who.sessionId,
          a.messageId,
          JSON.stringify(ordered),
        );
      this.history(
        a.messageId,
        id,
        "asked",
        null,
        { fingerprint, packet: ordered },
        0,
        1,
        who.actor,
        a.supersedes ? `Supersedes ${a.supersedes}` : "Asked",
        at,
      );
      if (superseded) {
        const before = superseded;
        this.write(
          {
            ...superseded,
            state: "superseded",
            supersededBy: id,
            revision: superseded.revision + 1,
            updatedAt: at,
          },
          "superseded",
          who.actor,
          `Superseded by ${id}`,
          randomUUID(),
          before,
        );
      }
      return {
        decision: this.publicPacket(ordered),
        warnings,
        resend: false,
        note: "Asked. Only the owner answers a packet asked of a human; an answer the owner did not confirm on a paired device is marked as answered by the operator. Nothing is ever chosen automatically. The choice reaches this session once as a decision.chosen message; role_decision_status reads it at any time.",
      };
    });
  }
  // ---- Operator side: G4 review record (PILLAR 7, the prime's one approved controller change) ---------------------
  // The owner's decision on a pull request in the review screen (approve / request changes / comment + note), recorded as a
  // record-only Inbox item: a question asked of the human, bound to nothing, already answered by the operator. No
  // authority: it chooses nothing else, is never delivered to a session (a system asker, like J2's refresh) and reaches
  // nowhere outside this journal. Idempotent on (workspace, PR, head commit, choice, note): a retry is the same item.
  // The workspace is only hashed into that identity; no path is stored or shown.
  recordReview(a, { via = "app-mac" } = {}) {
    if (
      !a ||
      typeof a !== "object" ||
      Array.isArray(a) ||
      Object.keys(a).some((k) => !REVIEW_FIELDS.includes(k)) ||
      REVIEW_FIELDS.slice(0, 6).some((k) => !Object.hasOwn(a, k))
    )
      throw Error(
        `Invalid review record; it takes ${REVIEW_FIELDS.join(", ")} (projectId optional)`,
      );
    const { workspace, repo, number, headSha, choice } = a,
      note = typeof a.note === "string" ? a.note.trim() : null;
    if (typeof workspace !== "string" || !workspace || workspace.length > 1024)
      throw Error("Invalid review workspace");
    if (typeof repo !== "string" || !REVIEW_REPO.test(repo))
      throw Error("Invalid review repository; it is owner/name");
    if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647)
      throw Error("Invalid pull request number");
    if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha))
      throw Error("Invalid head commit; it is the full 40-character commit id");
    if (!Object.hasOwn(REVIEW_CHOICES, choice))
      throw Error("Invalid review choice; it is approve, request_changes or comment");
    if (
      note === null ||
      note.length > LIMITS.note ||
      /[\u0000-\u0008\u000b-\u001f\u007f]/.test(note)
    )
      throw Error(`Invalid review note; it is text of at most ${LIMITS.note} characters`);
    if (a.projectId !== undefined && a.projectId !== null && !uuid(a.projectId))
      throw Error("Invalid review project");
    if (!APP_VIA_LIST.includes(via)) throw Error("Invalid review platform");
    const identity = sha256(
      canonicalJson({
        kind: "g4-review",
        workspace: sha256(workspace),
        repo,
        number,
        headSha,
        choice,
        note: sha256(note),
      }),
    );
    const messageId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
    const label = REVIEW_CHOICES[choice];
    const title = clip(
      `You reviewed PR #${number}: ${label.title}${note ? ` — ${note}` : ""}`,
      LIMITS.title,
    );
    const { packet: body } = validateAsk(
      {
        kind: "question",
        level: 3,
        projectId: a.projectId ?? null,
        taskId: null,
        askedOf: "human",
        title,
        situation: clip(
          `Pull request #${number} in ${repo}, at commit ${headSha.slice(0, 7)}. Recorded from the review screen; nothing was sent anywhere.`,
          LIMITS.situation,
        ),
        options: Object.values(REVIEW_CHOICES).map((o) => ({
          id: o.id,
          title: o.title,
          summary: o.summary,
          example: null,
          impacts: REVIEW_IMPACTS,
          destructive: false,
        })),
        recommendation: null,
        evidence: [],
        action: { type: "none" },
        expiresAt: null,
      },
      { atAsk: false },
    );
    const who = { sessionId: null, seat: null, system: "review", actor: "operator" };
    const fingerprint = canonicalJson({ body, record: identity });
    return this.store.atomic(() => {
      const prior = this.db
        .prepare("SELECT * FROM cc_decisions WHERE askMessageId=?")
        .get(messageId);
      if (prior) {
        const asked = this.db
          .prepare("SELECT after FROM cc_decision_history WHERE id=? AND action='asked'")
          .get(messageId);
        if (
          prior.askedBySession !== "system:review" ||
          !asked ||
          JSON.parse(asked.after).fingerprint !== fingerprint
        )
          throw Error("Message identity already used");
        return { decision: this.publicPacket(JSON.parse(prior.json)), resend: true };
      }
      this.assertCapacity("cc_decisions", DECISION_LIMITS.decisions, "decision store");
      this.assertCapacity("cc_decision_history", DECISION_LIMITS.history, "decision history");
      const at = this.iso(),
        id = randomUUID(),
        askedBy = { seat: null, sessionId: null, system: "review" };
      const asked = {
        version: 1,
        id,
        revision: 1,
        kind: body.kind,
        level: body.level,
        projectId: body.projectId,
        taskId: body.taskId,
        askedBy,
        askedOf: "human",
        title: body.title,
        situation: body.situation,
        options: body.options,
        recommendation: null,
        evidence: [],
        action: body.action,
        expiresAt: null,
        state: "open",
        supersededBy: null,
        choice: null,
        delivery: null,
        createdAt: at,
        updatedAt: at,
      };
      const chosen = {
        ...asked,
        state: "chosen",
        revision: 2,
        choice: {
          optionId: label.id,
          by: "operator",
          at,
          note,
          via,
          channelId: null,
          deviceId: null,
          proven: false,
        },
        delivery: null,
      };
      this.db
        .prepare("INSERT INTO cc_decisions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          "chosen",
          asked.projectId,
          "human",
          asked.level,
          at,
          at,
          2,
          "system:review",
          messageId,
          JSON.stringify(chosen),
        );
      this.history(
        messageId,
        id,
        "asked",
        null,
        { fingerprint, packet: asked },
        0,
        1,
        who.actor,
        "Review recorded",
        at,
      );
      this.history(
        randomUUID(),
        id,
        "chosen",
        asked,
        chosen,
        1,
        2,
        who.actor,
        note || "Chosen",
        at,
      );
      return { decision: this.publicPacket(chosen), resend: false };
    });
  }
  status(a, capability) {
    if (!keys(a, "decisionId,sessionId") || !uuid(a.decisionId))
      throw Error("Invalid decision status read");
    const who = this.asker(a.sessionId, capability),
      p = this.packet(a.decisionId);
    if (!p || !this.isAsker(p, who)) throw Error("No decision you asked has that id");
    return { decision: this.publicPacket(p) };
  }
  withdraw(a, capability) {
    if (
      !keys(a, "decisionId,expectedRevision,note,sessionId") ||
      !uuid(a.decisionId) ||
      !Number.isSafeInteger(a.expectedRevision) ||
      typeof a.note !== "string" ||
      a.note.trim().length < 8 ||
      a.note.length > LIMITS.note
    )
      throw Error(
        "Invalid decision withdrawal; it needs decisionId, expectedRevision and a note of 8–500 characters",
      );
    const personal = personalMatch(a.note);
    if (personal) throw Error(`The note contains ${personal}`);
    const who = this.asker(a.sessionId, capability);
    return this.store.atomic(() => {
      const p = this.packet(a.decisionId);
      if (!p || !this.isAsker(p, who)) throw Error("Only the asker can withdraw a decision");
      if (p.state === "withdrawn" && p.revision === a.expectedRevision + 1)
        return { decision: this.publicPacket(p), resend: true };
      if (p.state !== "open")
        throw Error(
          p.state === "chosen"
            ? `${answeredText(p.choice)}; a chosen decision cannot be withdrawn`
            : `That decision is already ${p.state}`,
        );
      if (p.revision !== a.expectedRevision) throw Error(STALE_REVISION);
      this.assertCapacity("cc_decision_history", DECISION_LIMITS.history, "decision history");
      const next = { ...p, state: "withdrawn", revision: p.revision + 1, updatedAt: this.iso() };
      this.write(next, "withdrawn", who.actor, a.note.trim(), randomUUID(), p);
      return { decision: this.publicPacket(next), resend: false };
    });
  }

  // ---- App side (operator gate = human) ---------------------------------------------------------------------
  get(a) {
    if (!keys(a, "id") || !uuid(a.id)) throw Error("Invalid decision read");
    const p = this.packet(a.id);
    if (!p) throw Error("No decision has that id");
    return { decision: this.publicPacket(p), answered: p.choice ? answeredText(p.choice) : null };
  }
  // §3.2 #3, #4, #6, #7 and #8. `actor` is supplied only by rpc.mjs (the operator gate) or a future verified
  // channel; nothing an agent sends reaches it.
  // §3.2 #6 v1.6 (prime decision S-1). Who answered is DERIVED here, never passed in: `human` (the owner) only with a
  // device proof the controller verifies (§3.6); otherwise the app path is `operator`, because holding the operator
  // secret proves nothing. Seat and session actors are for packets asked of a seat. `proofRefused` says why a
  // supplied proof did not count, so the app can tell the owner rather than silently downgrading.
  async choose(
    a,
    { actor = "operator", via = "app-mac", channelId = null, proof, channelOwner } = {},
  ) {
    if (actor === "human")
      throw Error("The owner is proven by a paired device, never named by the caller");
    // J3b: an owner-verified chat answer arrives with a one-time attestation minted by InboxChannels after it checked
    // the ingress origin; nothing else can produce one.
    if (channelOwner !== undefined) {
      if (!ownerAttested(channelOwner, channelId)) throw Error("Invalid channel owner proof");
      actor = "human";
    }
    if (
      !keys(a, "confirmDestructive,expectedRevision,id,messageId,note,optionId") ||
      !uuid(a.messageId) ||
      !uuid(a.id) ||
      !Number.isSafeInteger(a.expectedRevision) ||
      typeof a.optionId !== "string" ||
      !KEY.test(a.optionId) ||
      typeof a.note !== "string" ||
      a.note.length > LIMITS.note ||
      typeof a.confirmDestructive !== "boolean"
    )
      throw Error("Invalid choice");
    const personal = personalMatch(a.note);
    if (personal) throw Error(`The note contains ${personal}`);
    const replay = () => {
      const h = this.db.prepare("SELECT * FROM cc_decision_history WHERE id=?").get(a.messageId);
      if (!h) return null;
      const after = JSON.parse(h.after);
      if (
        h.action !== "chosen" ||
        h.entityId !== a.id ||
        after.choice?.optionId !== a.optionId ||
        after.choice?.note !== a.note.trim()
      )
        throw Error("Message identity already used");
      return { decision: this.publicPacket(this.packet(a.id)), resend: true };
    };
    const early = replay();
    if (early) return early;
    const p = this.packet(a.id);
    if (!p) throw Error("No decision has that id");
    let device = null;
    if (proof !== undefined) {
      if (actor !== "operator") throw Error("Only the app path carries a device proof");
      // v1.8 R2-11: the second tap is signed too.
      const expected = {
        decisionId: a.id,
        revision: a.expectedRevision,
        optionId: a.optionId,
        digest: p.action.type === "none" ? null : p.action.digest,
        messageId: a.messageId,
        note: a.note,
        confirmDestructive: a.confirmDestructive,
      };
      // v1.8 R2-5: a proof that was sent but fails refuses the answer and records nothing, so the app can sign again.
      // Only an answer sent with no proof at all is the operator's.
      try {
        device = this.control.devices.verifyChoice(proof, expected);
      } catch (e) {
        if (!(e instanceof ProofRefused)) throw e;
        throw Error(
          `Your device's confirmation did not check out: ${e.message}. Nothing was recorded; confirm again on your device`,
          { cause: e },
        );
      }
      actor = "human";
      // v1.8 R2-6: a proven answer's platform is the verified device's, never the caller's claim.
      via = DEVICE_VIA[device.platform] ?? via;
    }
    this.assertChoosable(p, a, actor);
    if (!VIA.includes(via)) throw Error("Invalid choice platform");
    // #4: recompute the bound object's digest at choice time. Outside the transaction (a binder may read
    // another store); the choice below is pinned to this revision, so nothing can change it in between.
    if (p.action.type !== "none" && (await this.bound(p.action)) !== p.action.digest)
      throw Error(DIGEST_CHANGED);
    const result = this.store.atomic(() => {
      const again = replay();
      if (again) return again;
      const current = this.packet(a.id);
      this.assertChoosable(current, a, actor);
      this.assertCapacity("cc_decision_history", DECISION_LIMITS.history, "decision history");
      this.assertCapacity(
        "cc_decision_deliveries",
        DECISION_LIMITS.deliveries,
        "decision delivery record",
      );
      const at = this.iso(),
        revision = current.revision + 1,
        deliveryId = chosenDeliveryId(current.id, revision);
      const next = {
        ...current,
        state: "chosen",
        revision,
        updatedAt: at,
        choice: {
          optionId: a.optionId,
          by: actor,
          at,
          note: a.note.trim(),
          via,
          channelId,
          deviceId: device?.id ?? null,
          proven: actor === "human",
        },
        // v1.15: a system packet's choice is consumed by its component, never delivered to a session.
        delivery: current.askedBy.system ? null : { state: "pending", at: null, attempts: 0 },
      };
      this.write(next, "chosen", actor, a.note.trim() || "Chosen", a.messageId, current);
      if (next.delivery)
        this.db
          .prepare("INSERT INTO cc_decision_deliveries VALUES (?,?,?,?,'pending',0,NULL,?,?,NULL)")
          .run(deliveryId, next.id, revision, next.askedBy.sessionId, at, at);
      if (device) this.control.devices.touch(device.id);
      return { decision: this.publicPacket(next), resend: false };
    });
    if (!result.resend) this.delivering = this.deliverPending();
    return result;
  }
  assertChoosable(p, a, actor) {
    // #7: chosen is terminal. A second answer changes nothing and says where the first one came from.
    if (p.state === "chosen") throw Error(answeredText(p.choice));
    if (p.state !== "open")
      throw Error(
        p.state === "withdrawn"
          ? "The asker withdrew this question"
          : p.state === "superseded"
            ? "This question was replaced by a newer one"
            : "This question expired without an answer",
      );
    if (p.expiresAt && Date.parse(p.expiresAt) <= this.now())
      throw Error("This question expired without an answer");
    if (p.revision !== a.expectedRevision) throw Error(STALE_REVISION);
    // #6 v1.6: a packet asked of a human is answered by the owner (proven) or recorded as the operator; a seat packet
    // only by that seat. An approval that binds an action needs the owner's proof.
    if (
      p.askedOf === "human"
        ? !["human", "operator"].includes(actor)
        : actor !== `seat:${p.askedOf.seat}`
    )
      throw Error(
        p.askedOf === "human"
          ? "Only the owner can answer this"
          : "Only the seat it was asked of can answer this",
      );
    if (p.action.type !== "none" && actor !== "human") throw Error(CONFIRM_ON_DEVICE);
    const option = p.options.find((o) => o.id === a.optionId);
    if (
      !option &&
      !(p.kind === "question" && p.options.length === 0 && a.optionId === FREE_TEXT_OPTION)
    )
      throw Error("That is not one of the options");
    if (!option && !a.note.trim()) throw Error("Write your answer in the note");
    // #3: a destructive option takes a second, explicit confirmation.
    if (option?.destructive && a.confirmDestructive !== true)
      throw Error("This option is hard to undo; confirm it a second time");
  }
  async approvalFor(a) {
    // §3.2 #4 v1.5 (R-J3-4): the executor presents the exact packet it was told about. Authority holds only if that
    // packet is a chosen approval answered `approve`, its action is exactly this one, and the digest still matches.
    if (
      !keys(a, "action,decisionId,revision") ||
      !uuid(a.decisionId) ||
      !Number.isSafeInteger(a.revision) ||
      !actionTarget(a.action ?? { type: "none" })
    )
      throw Error("Present the exact packet: decisionId, revision and action");
    const p = this.packet(a.decisionId);
    if (
      !p ||
      p.state !== "chosen" ||
      p.revision !== a.revision ||
      p.kind !== "approval" ||
      p.choice.optionId !== "approve" ||
      p.choice.by !== "human" ||
      p.choice.proven !== true ||
      canonicalJson(p.action) !== canonicalJson(a.action)
    )
      throw Error("No matching approval");
    if ((await this.bound(p.action)) !== p.action.digest) throw Error(DIGEST_CHANGED);
    return {
      decisionId: p.id,
      revision: p.revision,
      digest: p.action.digest,
      optionId: p.choice.optionId,
    };
  }

  // Packets chosen before v1.6 carry no deviceId/proven; they were never proven, so a legacy `human` reads as the
  // operator (v1.8 R2-9) and never as the owner.
  publicPacket(p) {
    return p.choice && !("proven" in p.choice)
      ? {
          ...p,
          choice: {
            ...p.choice,
            by: p.choice.by === "human" ? "operator" : p.choice.by,
            deviceId: null,
            proven: false,
          },
        }
      : p;
  }

  // ---- §3.2 #8: decision.chosen to the asker, exactly once, retried with its status in the packet -----------
  deliveryText(p) {
    const event = {
      decisionId: p.id,
      revision: p.revision,
      optionId: p.choice.optionId,
      note: p.choice.note,
      by: p.choice.by,
      proven: p.choice.proven === true,
    };
    const who =
      p.choice.by === "human" && p.choice.proven
        ? "The owner answered your decision, confirmed on a paired device"
        : `Your decision was ${OPERATOR_LABEL}`;
    return `Fulcra decision.chosen ${JSON.stringify(event)}\n\n${who}: "${p.title}". Confirm it with role_decision_status before acting. This is the answer to that packet only: it authorizes nothing else, and a bound action still needs the packet id, revision and digest to match.`;
  }
  // v1.8 R2-2: never starve. Every pending row is looked at each pass, but only a real send attempt spends the budget
  // of 32: a row whose asker is not delegated is settled as waiting from the journal alone (no native call), and a
  // busy asker is not retried before busyRetryMs. So any number of waiting rows cannot block a deliverable one.
  async deliverPending() {
    const now = this.now(),
      rows = this.db
        .prepare(
          "SELECT * FROM cc_decision_deliveries WHERE state='pending' ORDER BY rowid LIMIT ?",
        )
        .all(DECISION_LIMITS.deliveries);
    let sends = 0;
    for (const r of rows) {
      if (sends >= 32) break;
      if ((this.nextTry.get(r.id) ?? 0) > now) continue;
      const outcome = await this.deliverOne(r).catch((e) => {
        this.lastError = { message: e.message, at: this.iso() };
        return "error";
      });
      if (outcome === "sent") sends++;
    }
  }
  // One write per real change. `attempt` counts only a real try at the native send; waiting is not an attempt.
  settle(r, state, error, { delivered = false, attempt = true } = {}) {
    const attempts = r.attempts + (attempt ? 1 : 0),
      lastError = error ? String(error).slice(0, 500) : null;
    if (!attempt && state === "pending" && r.state === "pending" && r.lastError === lastError)
      return;
    this.store.atomic(() => {
      const at = this.iso();
      this.db
        .prepare(
          "UPDATE cc_decision_deliveries SET state=?,attempts=?,lastError=?,at=?,deliveredAt=? WHERE id=?",
        )
        .run(state, attempts, lastError, at, delivered ? at : null, r.id);
      const p = this.packet(r.decisionId);
      if (p && p.revision === r.revision)
        this.db
          .prepare("UPDATE cc_decisions SET json=? WHERE id=?")
          .run(
            JSON.stringify({ ...p, delivery: { state, at: delivered ? at : null, attempts } }),
            p.id,
          );
    });
  }
  // §3.2 #8 v1.5 (R-J3-8): the asking session, unless the asking seat was refreshed (D3) and that session no
  // longer holds it; then the seat's current holder. Fixed once the controller has a delivery row for it.
  target(r, p) {
    const seat = p.askedBy.seat;
    if (!seat) return p.askedBy.sessionId;
    const original = p.askedBy.sessionId;
    if (
      this.db
        .prepare("SELECT 1 FROM role_bindings WHERE seat=? AND session=? AND state='assigned'")
        .get(seat, original)
    )
      return original;
    return (
      this.db
        .prepare(
          "SELECT session FROM role_bindings WHERE seat=? AND state='assigned' AND session IS NOT NULL ORDER BY role LIMIT 1",
        )
        .get(seat)?.session ?? original
    );
  }
  // Returns 'sent' when a native send was attempted, 'waited' when the asker cannot take it yet, else 'settled'.
  async deliverOne(r) {
    if (this.inFlight.has(r.id)) return "settled";
    this.inFlight.add(r.id);
    try {
      // The controller's own delivery journal is the exactly-once record: a delivered row is never re-sent.
      const prior = this.store.delivery(r.id);
      if (prior?.state === "delivered")
        return this.settle(r, "delivered", null, { delivered: true, attempt: false });
      if (prior && ["refused", "abandoned", "uncertain"].includes(prior.state))
        return this.settle(
          r,
          "failed",
          `Controller delivery ${prior.state}; the answer stays readable with role_decision_status`,
          { attempt: false },
        );
      const p = this.packet(r.decisionId);
      if (!p || p.state !== "chosen" || p.revision !== r.revision)
        return this.settle(r, "failed", "The decision changed after it was chosen", {
          attempt: false,
        });
      const to = prior?.session ?? this.target(r, p);
      if (to !== r.session) {
        this.db.prepare("UPDATE cc_decision_deliveries SET session=? WHERE id=?").run(to, r.id);
        r = { ...r, session: to };
      }
      const session = this.store.get(to);
      // Definite: the session is gone. Everything below that is not a definite outcome is waiting (v1.5 #8).
      if (!session)
        return this.settle(
          r,
          "failed",
          "The asking session no longer exists; the answer stays readable with role_decision_status",
          { attempt: false },
        );
      if (session.mode !== "delegated") {
        // An archived asker is definite, not waiting (R2-2). Checked natively at most every archiveProbeMs per row.
        if (this.now() - (this.archiveProbed.get(r.id) ?? -Infinity) >= this.archiveProbeMs) {
          this.archiveProbed.set(r.id, this.now());
          const seen = await Promise.resolve(this.control.native?.inspect?.(session.id)).catch(
            () => null,
          );
          if (seen?.archivedAt) {
            this.settle(
              r,
              "failed",
              "The asking session was archived; the answer stays readable with role_decision_status",
              { attempt: false },
            );
            return "settled";
          }
        }
        this.settle(
          r,
          "pending",
          "Waiting: the asking session is under human control; the answer is delivered when it is handed back",
          { attempt: false },
        );
        return "waited";
      }
      // The seat-reply path: control.send pinned to the asker's current generation, never parked on quota,
      // and counted against the automation budget. check() re-reads the packet at the no-async-gap point.
      const delivery = await this.control.send(
        { sessionId: session.id, messageId: r.id, text: this.deliveryText(p) },
        undefined,
        session.generation,
        {
          source: { kind: "direct" },
          neverPark: true,
          automated: true,
          check: () => {
            const now = this.packet(r.decisionId);
            if (!now || now.state !== "chosen" || now.revision !== r.revision)
              throw new SourceChanged("The decision changed after it was chosen");
          },
        },
      );
      if (delivery.state === "delivered") {
        this.settle(r, "delivered", null, { delivered: true });
        return "sent";
      }
      this.settle(
        r,
        "failed",
        `Controller delivery ${delivery.state}${delivery.result?.error ? ": " + delivery.result.error : ""}`,
      );
      return "sent";
    } catch (e) {
      // Admitted means the controller owns the outcome: delivered, or a definite state that is never re-sent.
      const admitted = this.store.delivery(r.id);
      if (admitted?.state === "delivered") {
        this.settle(r, "delivered", null, { delivered: true });
        return "sent";
      }
      if (admitted) {
        this.settle(r, "failed", `Controller delivery ${admitted.state}: ${e.message}`);
        return "sent";
      }
      if (e instanceof SourceChanged) {
        this.settle(r, "failed", e.message);
        return "sent";
      }
      if (/Archived session/.test(e.message)) {
        this.settle(
          r,
          "failed",
          "The asking session was archived; the answer stays readable with role_decision_status",
        );
        return "sent";
      }
      // Nothing admitted means nothing was sent. Busy, a control change or another unreconciled delivery all wait,
      // and the same identity is tried again later with no risk of a duplicate.
      const busy =
        e instanceof RecipientBusy || e.message === "Session operation already in flight";
      this.nextTry.set(r.id, this.now() + this.busyRetryMs);
      this.settle(
        r,
        "pending",
        busy
          ? "Waiting: the asking session is busy; delivered when it is idle"
          : `Waiting: ${e.message}`,
        { attempt: !busy },
      );
      return "sent";
    } finally {
      this.inFlight.delete(r.id);
    }
  }
  // Expired packets become `expired`, never chosen (§3.2 #7).
  expire() {
    const now = this.iso();
    const due = this.db
      .prepare("SELECT json FROM cc_decisions WHERE state='open'")
      .all()
      .map((r) => JSON.parse(r.json))
      .filter((p) => p.expiresAt && p.expiresAt <= now);
    for (const p of due)
      this.store.atomic(() => {
        const current = this.packet(p.id);
        if (current.state !== "open") return;
        this.write(
          { ...current, state: "expired", revision: current.revision + 1, updatedAt: now },
          "expired",
          "system:decisions",
          "Expired without an answer",
          randomUUID(),
          current,
        );
      });
    return due.length;
  }
  // The background pass (v1.5 #8, R-J3-2). The controller calls it WITHOUT awaiting it, so it never holds up the
  // event-refresh chain; it is single-flight, runs at most every pumpEveryMs, and composes digests at most every
  // composeEveryMs. A pass with nothing due does no network I/O (composeDue returns before reading the directory).
  pump() {
    if (this.control.closing) return Promise.resolve();
    if (this.pumping) return this.pumping;
    const now = this.now();
    if (now - this.lastPump < this.pumpEveryMs) return Promise.resolve();
    this.lastPump = now;
    const compose = now - this.lastCompose >= this.composeEveryMs;
    if (compose) this.lastCompose = now;
    this.pumping = (async () => {
      this.expire();
      await this.deliverPending();
      if (compose) await this.composeDue(now);
    })()
      .catch((e) => {
        this.lastError = { message: e.message, at: this.iso() };
      })
      .finally(() => {
        this.pumping = null;
      });
    return this.pumping;
  }

  // ---- Held prime messages, as inbox items (metadata only; the body is read on open) -----------------------
  heldRows() {
    return this.db
      .prepare(`SELECT m.messageId,m.channel,m.fromSeat,m.toSeat,m.at,m.text FROM role_channel_messages m
      WHERE m.state='held' AND NOT EXISTS (SELECT 1 FROM seat_operator_acts a WHERE a.kind='reply' AND a.parent=m.messageId AND a.state!='void-reply')
      ORDER BY m.rowid DESC LIMIT 64`)
      .all();
  }
  // One held message, with the pins seat-reply and seat-unhold need. The text is untrusted evidence.
  heldMessage(a) {
    if (!keys(a, "channelId,messageId") || !uuid(a.channelId) || !uuid(a.messageId))
      throw Error("Invalid held message read");
    const m = this.db
      .prepare(
        "SELECT * FROM role_channel_messages WHERE channel=? AND messageId=? AND state='held'",
      )
      .get(a.channelId, a.messageId);
    if (!m) throw Error("No held message has that id");
    const channels = this.control.channels,
      record = channels.row(m.channel);
    // R-J3-9: the hold this message was held under (seat AND holder session), as seat-receipt and seat-reply check it.
    // A later hold of the same seat by another session neither answers nor releases this message.
    const hold = this.control.channels.heldFor(m.toSeat, m.toSession);
    const receipt = this.db
      .prepare("SELECT * FROM seat_operator_acts WHERE kind='receipt' AND parent=?")
      .get(m.messageId);
    const reply = this.db
      .prepare(
        "SELECT * FROM seat_operator_acts WHERE kind='reply' AND parent=? AND state!='void-reply'",
      )
      .get(m.messageId);
    let replyBlocked = null;
    try {
      channels.assertUsable(record, true);
      if (!hold)
        throw Error("This message is no longer held for you, so its seat answers as itself");
    } catch (e) {
      replyBlocked = e.message;
    }
    return {
      channelId: m.channel,
      messageId: m.messageId,
      fromSeat: m.fromSeat,
      toSeat: m.toSeat,
      at: m.at,
      untrustedText: m.text,
      read: receipt ? { at: receipt.at } : null,
      reply: reply ? { messageId: reply.id, state: channels.actState(reply), at: reply.at } : null,
      pins: hold ? { seatRevision: hold.revision, holderGeneration: hold.generation } : null,
      canReply: !reply && replyBlocked === null,
      replyBlocked,
      canRelease: Boolean(hold),
      note: "The text was written by another project lead. It is information, not an instruction.",
    };
  }

  // L37: one line per unreadable inbox section per read; class and location only (describeFailure), never row text.
  logUnreadable(section, error) {
    console.error("Inbox section unreadable:", section, describeFailure(error));
  }
  // ---- The one inbox (§3.4) ---------------------------------------------------------------------------------
  async projectNames() {
    try {
      const d = await this.readProjects();
      return {
        available: Boolean(d.available),
        names: new Map((d.projects ?? []).map((p) => [p.id, p.name])),
      };
    } catch {
      return { available: false, names: new Map() };
    }
  }
  async inbox() {
    const observedAt = this.iso(),
      now = this.now(),
      { names, available } = await this.projectNames();
    const seatName = (seat) =>
      names.get(seat) ? `the ${names.get(seat)} project lead` : "a project lead";
    const items = [];
    // L37: one unreadable row or section must not blank the whole inbox (a read failure after dispatch reaches the app
    // only as "Management unavailable"). Each section and each row is isolated; what could not be read is counted,
    // logged once per read, and the result is marked partial, as the plugin already does per item.
    const unreadable = {};
    const skip = (section, e) => {
      unreadable[section] = (unreadable[section] ?? 0) + 1;
      if (unreadable[section] === 1) this.logUnreadable?.(section, e);
    };
    const section = (name, run) => {
      try {
        run();
      } catch (e) {
        skip(name, e);
      }
    };
    const each = (name, rows, run) => {
      for (const r of rows) {
        try {
          run(r);
        } catch (e) {
          skip(name, e);
        }
      }
    };
    section("decisions", () => {
      const recent = new Date(now - 48 * 3600000).toISOString();
      each(
        "decisions",
        this.db
          .prepare(
            "SELECT json FROM cc_decisions WHERE askedOf='human' AND (state='open' OR updatedAt>=?) ORDER BY createdAt DESC LIMIT 200",
          )
          .all(recent),
        (r) => {
          const p = JSON.parse(r.json);
          const open = p.state === "open",
            chosen = p.options.find((o) => o.id === p.choice?.optionId);
          const summary = open
            ? p.situation
            : p.state === "chosen"
              ? `${answerSummary(p.choice, chosen?.title)}.`
              : p.state === "withdrawn"
                ? "The asker withdrew this question."
                : p.state === "superseded"
                  ? "Replaced by a newer question."
                  : "Expired without an answer.";
          items.push({
            key: `${p.kind}-${p.id}`,
            source: "decision",
            ref: `decision:${p.id}`,
            title: p.title,
            summary: clip(summary, 280),
            projectId: p.projectId,
            urgency: !open ? "fyi" : p.level === 1 || p.kind === "approval" ? "now" : "today",
            createdAt: p.createdAt,
            unread: open,
          });
        },
      );
    });
    section("held", () =>
      each("held", this.heldRows(), (m) => {
        const age = now - Date.parse(m.at),
          read = this.db
            .prepare("SELECT id FROM seat_operator_acts WHERE kind='receipt' AND parent=?")
            .get(m.messageId);
        const item = {
          key: `held-${m.channel}-${m.messageId}`,
          source: "held",
          ref: uuid(m.fromSeat)
            ? `project:${m.fromSeat}`
            : KEY.test(m.fromSeat)
              ? `seat:${m.fromSeat}`
              : null,
          title: heldSubject(m.text, `Message waiting from ${seatName(m.fromSeat)}`),
          summary: clip(
            `From ${seatName(m.fromSeat)}. Sent ${age < 3600000 ? "less than an hour" : plural(Math.floor(age / 3600000), "hour")} ago. Open it to read, reply or release the hold.`,
            280,
          ),
          projectId: names.has(m.fromSeat) ? m.fromSeat : null,
          urgency: age > HELD_URGENT_MS ? "now" : "today",
          createdAt: m.at,
          unread: !read,
        };
        // The real subject (first line of the body) is for the Fulcra app's inbox only. Chat channels must never show any
        // part of a held body, so they read this generic title instead. Kept beside the item (channel-titles.mjs), never on
        // it: the owned channel refuses hidden fields (U5-D01).
        setChannelTitle(item, `Message waiting from ${seatName(m.fromSeat)}`);
        items.push(item);
      }),
    );
    section("digests", () =>
      each("digests", this.latestDigests(), (d) => {
        const j = JSON.parse(d.json);
        items.push({
          key: `digest-${d.id}`,
          source: "digest",
          ref: null,
          title: clip(`Daily digest · ${j.projectName}`, 120),
          summary: clip(j.summary, 280),
          projectId: d.projectId,
          urgency: "fyi",
          createdAt: j.composedAt,
          unread: now - Date.parse(j.composedAt) < 24 * 3600000,
        });
      }),
    );
    section("devices", () => items.push(...this.deviceNotices(now)));
    section("attention", () => items.push(...this.attention(observedAt)));
    const rank = { now: 0, today: 1, fyi: 2 };
    items.sort(
      (x, y) =>
        rank[x.urgency] - rank[y.urgency] ||
        (y.createdAt > x.createdAt ? 1 : y.createdAt < x.createdAt ? -1 : 0),
    );
    const count = (f) => items.filter(f).length,
      incomplete = Object.keys(unreadable).length > 0;
    return {
      version: 1,
      observedAt,
      partial: !available || incomplete,
      ...(incomplete ? { unreadable } : {}),
      items: items.slice(0, 200),
      counts: {
        now: count((i) => i.urgency === "now"),
        today: count((i) => i.urgency === "today"),
        fyi: count((i) => i.urgency === "fyi"),
        decisions: count((i) => i.source === "decision" && !i.key.startsWith("approval-")),
        approvals: count((i) => i.key.startsWith("approval-")),
        held: count((i) => i.source === "held"),
        digests: count((i) => i.source === "digest"),
        total: items.length,
      },
    };
  }
  // §3.6 rule 5: every pairing and revocation is announced for a week, urgency now, so a pairing the owner did not
  // make is seen at once. Labels are device names (checked for personal data when paired).
  deviceNotices(now) {
    return [...this.channelNotices(now), ...this.deviceEvents(now)];
  }
  // v1.13 R3-7: a paired chat channel (especially one whose answers count as the owner's) is announced like a device.
  channelNotices(now) {
    if (!this.control.inboxChannels) return [];
    return this.control.inboxChannels
      .events(new Date(now - 7 * 86400000).toISOString(), new Date(now).toISOString())
      .map((e) => ({
        key: `attention-channel-${e.id}`,
        source: "attention",
        ref: null,
        projectId: null,
        urgency: e.action === "revoked" ? "fyi" : "now",
        createdAt: e.at,
        unread: now - Date.parse(e.at) < 24 * 3600000,
        title: clip(channelTitle(e), 120),
        summary:
          e.action === "paired"
            ? e.ownerCapable
              ? "Answers given there count as yours. Not you? Revoke it in Settings › Channels."
              : "Answers given there are marked as answered by the operator. Not you? Revoke it in Settings › Channels."
            : e.action === "device-revoked"
              ? "Its answers no longer count as yours. Pair it again from a device you trust, or revoke it in Settings › Channels."
              : "It can no longer show or answer anything.",
      }));
  }
  deviceEvents(now) {
    if (!this.control.devices) return [];
    return this.control.devices
      .events(new Date(now - 7 * 86400000).toISOString(), new Date(now).toISOString())
      .map((e) => ({
        key: `attention-device-${e.id}`,
        source: "attention",
        ref: null,
        projectId: null,
        urgency: "now",
        createdAt: e.at,
        unread: now - Date.parse(e.at) < 24 * 3600000,
        title: clip(
          e.action === "paired"
            ? `A new device was paired at ${hhmm(e.at)}: ${deviceLine(e)}`
            : `A device was revoked at ${hhmm(e.at)}: ${deviceLine(e)}`,
          120,
        ),
        summary:
          e.action === "paired"
            ? "Not you? Revoke it in Settings › Devices."
            : "It can no longer answer for you. If you did not do this, check your other devices.",
      }));
  }
  // CONTRACTS §1 Capacity: 90% of any bound raises an attention item; the cap itself refuses writes.
  attention(at) {
    const out = [];
    const full = [
      ["cc_decisions", DECISION_LIMITS.decisions, "saved decisions"],
      ["cc_decision_history", DECISION_LIMITS.history, "decision history"],
      ["cc_decision_deliveries", DECISION_LIMITS.deliveries, "answer deliveries"],
    ]
      .map(([table, limit, what]) => [this.count(table) / limit, what])
      .concat([[deliveryCount(this.db) / JOURNAL_CAPACITY, "the work record"]]);
    for (const [ratio, what] of full)
      if (ratio >= 0.9)
        out.push({
          key: `attention-capacity-${what.replace(/\W+/g, "-")}`,
          source: "attention",
          ref: null,
          title: `Storage for ${what} is ${Math.floor(ratio * 100)}% full`,
          summary:
            ratio >= 1
              ? "It is full: new items are refused until old ones are archived. Ask the operator to archive."
              : "New items still work. Ask the operator to archive old ones before it fills.",
          projectId: null,
          urgency: "fyi",
          createdAt: at,
          unread: true,
        });
    // CONTRACTS §1 Capacity (v1.14): the Organisation stores (project updates and ownership) warn here too. They have no
    // archive yet, so the words say what happens instead of asking for one.
    for (const store of [this.control.briefs, this.control.remits])
      for (const u of store?.capacityUsage?.() ?? [])
        if (u.ratio >= 0.9)
          out.push({
            key: `attention-capacity-${u.what.replace(/\W+/g, "-").toLowerCase()}${u.projectId ? `-${u.projectId}` : ""}`,
            source: "attention",
            ref: null,
            projectId: u.projectId,
            title: `Storage for ${u.what} is ${Math.floor(u.ratio * 100)}% full`,
            summary:
              u.ratio >= 1
                ? "It is full: new ones are refused. Clearing out old records arrives in a later Fulcra update; tell the operator."
                : "New ones still work. It fills up over time, and clearing out old records arrives in a later Fulcra update.",
            urgency: "fyi",
            createdAt: at,
            unread: true,
          });
    out.push(...this.orchestrationMismatches(at));
    const failed = this.count("cc_decision_deliveries WHERE state='failed'");
    if (failed)
      out.push({
        key: "attention-undelivered-answers",
        source: "attention",
        ref: null,
        title: `${plural(failed, "answer")} could not be passed on`,
        summary:
          "The session that asked is not reachable. It can still read your answer when it next checks.",
        projectId: null,
        urgency: "fyi",
        createdAt: at,
        unread: true,
      });
    return out;
  }

  // DESIGN-NEXT-BUILD A3 (prime Q3): leads are seated after they are created and a live session's model is never
  // switched, so a seated orchestrator (prime or project lead) whose recorded model or effort differs from the
  // installation's orchestration default is shown, once per seat, as information. Computed on read from the seat and
  // its journaled creation; a session created before the result recorded its model is not compared.
  orchestrationMismatches(at) {
    let defaults;
    try {
      defaults = configuredDefaults(installationConfig()).roles?.orchestration;
    } catch {
      return [];
    }
    if (!defaults) return [];
    const bare = (m) => (typeof m === "string" ? m.slice(m.indexOf("/") + 1) : null),
      out = [];
    const seats = this.db
      .prepare(
        "SELECT role,seat,projectId,session FROM role_bindings WHERE state='assigned' AND session IS NOT NULL AND role IN ('prime','project-orchestrator') ORDER BY role,seat LIMIT 64",
      )
      .all();
    for (const s of seats) {
      const row = this.db
        .prepare(
          "SELECT result FROM deliveries WHERE kind='create' AND state='delivered' AND json_extract(result,'$.id')=? LIMIT 1",
        )
        .get(s.session);
      let created;
      try {
        created = row ? JSON.parse(row.result) : null;
      } catch {
        created = null;
      }
      const provider = typeof created?.model === "string" ? created.model.split("/")[0] : null,
        want = provider ? defaults[provider] : null;
      if (!want) continue;
      const have = { model: bare(created.model), effort: created.mode?.thinkingOptionId ?? null },
        wanted = {
          model: want.model ? bare(want.model) : null,
          effort: want.thinkingOptionId ?? null,
        };
      const differs =
        (wanted.model && have.model && wanted.model !== have.model) ||
        (wanted.effort && have.effort && wanted.effort !== have.effort);
      if (!differs) continue;
      const lead = s.role === "prime" ? "A prime" : "A project lead";
      out.push({
        key: `attention-orchestration-${s.role}-${String(s.seat).toLowerCase()}`
          .replace(/[^a-z0-9-]/g, "-")
          .slice(0, 200),
        source: "attention",
        ref: s.role === "project-orchestrator" && uuid(s.seat) ? `project:${s.seat}` : null,
        projectId: uuid(s.projectId) ? s.projectId : null,
        title: clip(`${lead} runs different model settings from the orchestration default`, 120),
        summary: clip(
          `It runs ${have.model ?? "an unrecorded model"} at ${have.effort ?? "unrecorded"} effort; the orchestration default is ${wanted.model ?? have.model} at ${wanted.effort ?? have.effort} effort. Nothing is changed automatically.`,
          280,
        ),
        urgency: "fyi",
        createdAt: at,
        unread: true,
      });
    }
    return out;
  }
  // ---- Daily digest (§4.2): derived from the journal, no LLM, nothing sent outside Fulcra -------------------
  latestDigests() {
    return this.db
      .prepare(
        "SELECT d.* FROM cc_digests d WHERE d.rowid IN (SELECT max(rowid) FROM cc_digests GROUP BY coalesce(projectId,'')) ORDER BY d.periodEnd DESC LIMIT 16",
      )
      .all();
  }
  digest(a) {
    if (!keys(a, "id") || !uuid(a.id)) throw Error("Invalid digest read");
    const d = this.db.prepare("SELECT * FROM cc_digests WHERE id=?").get(a.id);
    if (!d) throw Error("No digest has that id");
    return {
      id: d.id,
      projectId: d.projectId,
      periodStart: d.periodStart,
      periodEnd: d.periodEnd,
      digest: JSON.parse(d.json),
    };
  }
  // Today's local slot for a project, in the host timezone.
  slot(projectId, now) {
    const [h, m] = (this.digestAt[projectId ?? ""] ?? this.digestAt.default).split(":").map(Number),
      d = new Date(now);
    d.setHours(h, m, 0, 0);
    return d;
  }
  // A target's slot that has passed and is not yet settled (composed, or found quiet).
  dueSlot(projectId, now) {
    const slot = this.slot(projectId, now);
    return now >= slot.getTime() && this.settled.get(projectId ?? "") !== slot.toISOString()
      ? slot
      : null;
  }
  async composeDue(now = this.now()) {
    // Nothing due for All work (whose slot covers every default-time project) nor for a project with its own time:
    // return before the directory read, so an idle pass costs no network call.
    if (
      !this.dueSlot(null, now) &&
      !Object.keys(this.digestAt)
        .filter((k) => k !== "default")
        .some((id) => this.dueSlot(id, now))
    )
      return [];
    const { names, available } = await this.projectNames();
    const targets = [...names]
      .map(([id, name]) => ({ id, name }))
      .concat([{ id: null, name: "All work" }]);
    const made = [];
    for (const t of targets) {
      const slot = this.slot(t.id, now);
      if (now < slot.getTime()) continue;
      const periodEnd = slot.toISOString(),
        key = t.id ?? "";
      if (this.settled.get(key) === periodEnd) continue;
      // All work is settled only after a pass that could see every project; a partial directory is retried.
      const settle = () => {
        if (t.id !== null || available) this.settled.set(key, periodEnd);
      };
      if (
        this.db
          .prepare("SELECT id FROM cc_digests WHERE coalesce(projectId,'')=? AND periodEnd=?")
          .get(key, periodEnd)
      ) {
        settle();
        continue;
      }
      const last = this.db
        .prepare(
          "SELECT periodEnd FROM cc_digests WHERE coalesce(projectId,'')=? ORDER BY periodEnd DESC LIMIT 1",
        )
        .get(t.id ?? "");
      const periodStart = last?.periodEnd ?? new Date(slot.getTime() - 24 * 3600000).toISOString();
      const json = this.composeDigest({
        projectId: t.id,
        projectName: t.name,
        periodStart,
        periodEnd,
        composedAt: new Date(now).toISOString(),
        directoryAvailable: available,
      });
      // A quiet project gets no digest of its own; "All work" is always written.
      if (
        t.id !== null &&
        !json.brief &&
        !json.decisions.openCount &&
        !json.decisions.chosenCount
      ) {
        settle();
        continue;
      }
      this.store.atomic(() => {
        if (
          this.db
            .prepare("SELECT id FROM cc_digests WHERE coalesce(projectId,'')=? AND periodEnd=?")
            .get(t.id ?? "", periodEnd)
        )
          return;
        const id = randomUUID();
        this.db
          .prepare("INSERT INTO cc_digests VALUES (?,?,?,?,?)")
          .run(id, t.id, periodStart, periodEnd, JSON.stringify(json));
        // Derived rows rotate in the same transaction and never refuse (v1.5 §1 Capacity): newest DIGESTS_KEPT per target.
        this.db
          .prepare(
            "DELETE FROM cc_digests WHERE coalesce(projectId,'')=? AND id NOT IN (SELECT id FROM cc_digests WHERE coalesce(projectId,'')=? ORDER BY periodEnd DESC LIMIT ?)",
          )
          .run(key, key, DIGESTS_KEPT);
        made.push(id);
      });
      settle();
    }
    return made;
  }
  briefs(projectId, periodStart, periodEnd) {
    if (
      projectId === null ||
      !this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cc_project_briefs'")
        .get()
    )
      return { latest: null, before: null, inPeriod: [] };
    const parse = (r) => {
      try {
        return { ...JSON.parse(r.json), writtenAt: r.writtenAt };
      } catch {
        return null;
      }
    };
    const inPeriod = this.db
      .prepare(
        "SELECT json,writtenAt FROM cc_project_briefs WHERE projectId=? AND writtenAt>? AND writtenAt<=? ORDER BY revision",
      )
      .all(projectId, periodStart, periodEnd)
      .map(parse)
      .filter(Boolean);
    const before = this.db
      .prepare(
        "SELECT json,writtenAt FROM cc_project_briefs WHERE projectId=? AND writtenAt<=? ORDER BY revision DESC LIMIT 1",
      )
      .get(projectId, periodStart);
    return { latest: inPeriod.at(-1) ?? null, before: before ? parse(before) : null, inPeriod };
  }
  composeDigest({
    projectId,
    projectName,
    periodStart,
    periodEnd,
    composedAt,
    directoryAvailable,
  }) {
    const all = this.db
      .prepare("SELECT json FROM cc_decisions WHERE askedOf='human'")
      .all()
      .map((r) => JSON.parse(r.json))
      .filter((p) => (projectId === null ? true : p.projectId === projectId));
    const chosen = all
      .filter((p) => p.state === "chosen" && p.choice.at > periodStart && p.choice.at <= periodEnd)
      .map((p) => {
        const c = this.publicPacket(p).choice;
        return {
          id: p.id,
          title: p.title,
          optionTitle: p.options.find((o) => o.id === c.optionId)?.title ?? "A written answer",
          at: c.at,
          by: c.by,
          proven: proven(c),
        };
      });
    // Still waiting = open when composed (a late digest after downtime must not hide them); answers are the period's.
    const open = all
      .filter((p) => p.state === "open")
      .map((p) => ({ id: p.id, title: p.title, level: p.level, kind: p.kind }));
    const { latest, before, inPeriod } = this.briefs(projectId, periodStart, periodEnd);
    const shipped = inPeriod
      .flatMap((b) => (Array.isArray(b.shipped) ? b.shipped : []))
      .slice(0, 10)
      .map((s) => ({ text: String(s.text ?? "").slice(0, 200), ref: s.ref ?? null }));
    const heldRows = projectId === null ? this.heldRows() : [];
    const devices =
      projectId === null && this.control.devices
        ? this.control.devices
            .events(periodStart, periodEnd)
            .map((e) => ({ label: e.label, action: e.action, at: e.at }))
            .slice(0, 10)
        : [];
    const channels =
      projectId === null && this.control.inboxChannels
        ? this.control.inboxChannels
            .events(periodStart, periodEnd)
            .map((e) => ({
              label: e.label,
              kind: e.kind,
              action: e.action,
              ownerCapable: e.ownerCapable,
              at: e.at,
            }))
            .slice(0, 10)
        : [];
    const held =
      projectId === null
        ? { waiting: heldRows.length, oldestAt: heldRows.at(-1)?.at ?? null }
        : null;
    const parts = [];
    if (open.length) parts.push(`${plural(open.length, "decision")} waiting for you`);
    // v1.8 R2-3: the owner's proven decisions are counted apart from the operator's answers.
    const mine = chosen.filter((c) => c.proven).length,
      operators = chosen.length - mine;
    if (mine) parts.push(`you decided ${plural(mine, "question")}`);
    if (operators)
      parts.push(
        `${plural(operators, "question")} answered by the operator, not confirmed on your device`,
      );
    if (held?.waiting) parts.push(`${plural(held.waiting, "held message")}`);
    for (const d of devices)
      parts.push(
        d.action === "paired"
          ? `a new device, ${d.label}, was paired`
          : `the device ${d.label} was revoked`,
      );
    for (const c of channels)
      parts.push(
        channelTitle(c)
          .replace(/ at \d\d:\d\d/, "")
          .replace(/^./, (x) => x.toLowerCase()),
      );
    const lead = latest ? latest.headline : NO_UPDATE;
    const summary = clip(
      `${lead}. ${parts.length ? parts.join(", ").replace(/^./, (c) => c.toUpperCase()) + "." : "Nothing is waiting for you."}`.replace(
        /\.\./g,
        ".",
      ),
      400,
    );
    return {
      version: 1,
      projectId,
      projectName,
      periodStart,
      periodEnd,
      composedAt,
      brief: latest
        ? { headline: latest.headline, health: latest.health ?? null, writtenAt: latest.writtenAt }
        : null,
      healthChange:
        latest && before && before.health !== latest.health
          ? { from: before.health, to: latest.health }
          : null,
      noUpdate: latest ? null : NO_UPDATE,
      shipped,
      decisions: {
        chosen: chosen.slice(0, 10),
        open: open.slice(0, 10),
        chosenCount: chosen.length,
        openCount: open.length,
      },
      held,
      devices,
      channels,
      deployments: [],
      partial: !directoryAvailable,
      summary,
    };
  }
}
function channelTitle(e) {
  const kind =
    e.kind === "discord-openclaw"
      ? "chat channel"
      : e.kind === "session"
        ? "session channel"
        : "command-line channel";
  const at = e.at ? ` at ${hhmm(e.at)}` : "";
  if (e.action === "paired")
    return e.ownerCapable
      ? `A ${kind} that answers as you was paired${at}: ${e.label}`
      : `A ${kind} was paired${at}: ${e.label}`;
  if (e.action === "device-revoked")
    return `The ${kind} ${e.label} was paused${at}: the device that authorised it was revoked`;
  return `The ${kind} ${e.label} was revoked${at}`;
}
