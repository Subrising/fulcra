import { randomUUID } from "node:crypto";
import { journal, atomic } from "./journal.mjs";
import { canonical, bookProvider, digest } from "./protocol.mjs";
import { nativeIdentity } from "../control/native-identity.mjs";
// One cached instance in the daemon. Earlier hooks check; ONLY the final hook consumes.
export function createReceiverGuard(file, release) {
  const boot = randomUUID(),
    humans = new Map();
  let saturated = false;
  const observation = (id) => ({
    boot,
    fenceProtocol: "orca-input-sequence-v1",
    humanAt: humans.get(id) ?? 0,
    saturated,
    receiverRelease: release,
  });
  function guard(agent, prompt, options, busy, final = false) {
    if (!options?.clientMessageId?.startsWith("orca-control:")) {
      if (agent) {
        const next = (humans.get(agent.id) ?? 0) + 1;
        if ((!humans.has(agent.id) && humans.size >= 10000) || next >= Number.MAX_SAFE_INTEGER)
          saturated = true;
        else humans.set(agent.id, next);
      }
      return; // Human input does not open or depend on the journal.
    }
    let db;
    try {
      db = journal(file);
      atomic(db, () => {
        const intent = db
          .prepare("SELECT * FROM receiver_intents WHERE id=?")
          .get(options.clientMessageId.slice(13));
        const s =
          intent && db.prepare("SELECT * FROM receiver_sessions WHERE id=?").get(intent.session);
        const a = intent && JSON.parse(intent.body),
          b = s?.binding && JSON.parse(s.binding),
          identity = agent && nativeIdentity(agent);
        if (
          !s ||
          !agent ||
          s.phase !== "created" ||
          s.agent !== agent.id ||
          s.cwd !== agent.cwd ||
          agent.provider !== bookProvider(JSON.parse(s.creation)) ||
          agent.labels?.owner !== "orca-book-task" ||
          agent.labels?.task !== s.task ||
          agent.labels?.["orca.route"] !== s.id ||
          s.mode !== "delegated" ||
          s.generation !== a.generation ||
          !b ||
          canonical(b) !== canonical(a.binding) ||
          b.boot !== boot ||
          saturated ||
          b.boundary !== (humans.get(agent.id) ?? 0) + 1 ||
          identity.conflict ||
          (s.native && identity.nativeId !== s.native) ||
          (a.expectedNativeId !== null && identity.nativeId !== a.expectedNativeId) ||
          (a.expectedNativeId === null &&
            (a.expectedLastUserAt !== null ||
              b.lastPromptId !== null ||
              b.boundary !== 1 ||
              db
                .prepare("SELECT id FROM receiver_intents WHERE session=? AND consumed=1")
                .get(s.id))) ||
          busy ||
          agent.archivedAt ||
          (agent.pendingPermissions?.size ?? agent.pendingPermissions?.length ?? 0) ||
          (agent.lastUserMessageAt?.toISOString() ?? null) !== a.expectedLastUserAt ||
          prompt !== a.text ||
          !["prepared", "acknowledged"].includes(intent.state) ||
          intent.consumed
        )
          throw Error("Changed, consumed or unauthorized receiver intent");
        if (final && !s.native && identity.nativeId)
          db.prepare("UPDATE receiver_sessions SET native=? WHERE id=?").run(
            identity.nativeId,
            s.id,
          );
        if (final)
          db.prepare(
            "UPDATE receiver_intents SET consumed=1,state='admitted' WHERE id=? AND consumed=0",
          ).run(intent.id);
      });
    } catch (e) {
      throw Error("Orca native admission refused: " + e.message);
    } finally {
      db?.close();
    }
  }
  function mcpRefreshAdmission(agent) {
    let db;
    try {
      db = journal(file, true);
      db.exec("PRAGMA busy_timeout=0; BEGIN");
      const s = db.prepare("SELECT * FROM receiver_sessions WHERE agent=?").get(agent.id);
      const binding = s?.binding && JSON.parse(s.binding),
        identity = nativeIdentity(agent);
      const pending =
        s &&
        db
          .prepare(
            "SELECT id,state,consumed FROM receiver_intents WHERE session=? AND state NOT IN ('acknowledged','refused') ORDER BY id",
          )
          .all(s.id);
      const permissions =
        s &&
        db
          .prepare(
            "SELECT id,state,input,proof FROM receiver_permissions WHERE session=? ORDER BY id",
          )
          .all(s.id);
      const allowed = Boolean(
        s &&
        s.phase === "created" &&
        s.mode === "delegated" &&
        s.cwd === agent.cwd &&
        bookProvider(JSON.parse(s.creation)) === agent.provider &&
        agent.labels?.owner === "orca-book-task" &&
        agent.labels?.task === s.task &&
        agent.labels?.["orca.route"] === s.id &&
        binding?.boot === boot &&
        !saturated &&
        binding.boundary === (humans.get(agent.id) ?? 0) + 1 &&
        !identity.conflict &&
        s.native &&
        s.native === identity.nativeId &&
        binding.nativeId === identity.nativeId &&
        !pending.length,
      );
      return {
        revision: digest({
          session: s,
          input: observation(agent.id),
          pending,
          permissions,
          allowed,
        }),
        allowed,
      };
    } finally {
      db?.close();
    }
  }
  return { boot, observation, guard, mcpRefreshAdmission };
}
