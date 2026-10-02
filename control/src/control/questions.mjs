// H7 item 5. A worker's question goes to the seat that owns it, and the seat's reply answers it.
//
// Live (PRIME-ANSWERS-12): three Codex workers asked the USER a question with request_user_input. A pending question is
// a pending permission of kind 'question', so every controller send to the session refused ("Recipient is busy or
// waiting for permission"), the seat had no way to answer, and any human answer counts as human input to a delegated
// session -- which revokes it. The prime answered by hand and re-delegated.
//
// Now: the question is routed to the owning seat as a wake (wakes.mjs for role sessions; events.mjs 'permission' for
// manager workers), and role_send_session / manager_assign_worker to a session with a pending question DELIVER THE TEXT
// AS ITS ANSWER instead of a send. The answer is journaled first as a permission intent (pool 'question:<session>')
// pinning the exact request (digest) and the exact response, and the native guard admits exactly that response for
// exactly that request and nothing else (V4: hook-journal-policy.mjs admitQuestionAnswer, bound into the daemon). It takes the same fences as a send:
// delegated at the caller's generation, unchanged boot, no human input, the controller's own prompt identity, task
// authority -- and the question must belong to a turn the controller started (the session's expected prompt is a
// delivered controller send). A question on a human's turn is the human's.
import { uuid } from "./authority.mjs";
import { canonical, digest } from "./permission-policy.mjs";
import { permissionProjection } from "./permission-projection.mjs"; // merge: V4's controller-side projection (not the legacy guard)
import { authorityKey } from "./authority.mjs";

export const MAX_ANSWER_BYTES = 16384,
  MAX_ANSWERS_PER_SESSION = 100,
  MAX_ANSWERS_PER_QUESTION = 2,
  MAX_QUESTION_ANSWERS = 500;
// The response the providers read: answers keyed by question header (Codex maps by header; Claude's AskUserQuestion
// normalizer accepts the header too). One text answers every question in the request.
export function answerResponse(request, text) {
  const qs =
    Array.isArray(request?.input?.questions) && request.input.questions.length
      ? request.input.questions
      : [{}];
  const answers = {};
  qs.forEach((q, i) => {
    answers[typeof q?.header === "string" && q.header.trim() ? q.header : `Question ${i + 1}`] =
      text;
  });
  return { behavior: "allow", updatedInput: { answers } };
}

export class Questions {
  constructor(control) {
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.lastError = null;
  }
  // The first pending question on a session, or null. Read-only.
  async pending(id) {
    if (typeof this.control.native?.snapshot !== "function") return null;
    const a = await this.control.native.snapshot(id);
    return (
      (Array.isArray(a?.pendingPermissions) ? a.pendingPermissions : []).find(
        (p) => p?.kind === "question" && typeof p.id === "string",
      ) ?? null
    );
  }
  intent(id) {
    return this.db.prepare("SELECT * FROM permission_intents WHERE id=?").get(id) ?? null;
  }
  // Review H7 B1: a retry must take the route its FIRST attempt took, whatever is pending now. An id already journaled as
  // an answer is an answer (answer() reports the recorded outcome); an id already journaled as a delivery is a send
  // (send() returns the prior delivery); only a fresh id is routed by whether a question is pending.
  async answers(sessionId, messageId) {
    const intent = this.intent(messageId);
    if (intent) {
      if (intent.session !== sessionId || JSON.parse(intent.body).kind !== "question-answer")
        throw Error("Answer identity conflict");
      return true;
    }
    if (this.store.delivery(messageId)) return false;
    return Boolean(await this.pending(sessionId));
  }
  // Called by role_send_session and manager_assign_worker after their own ownership checks. `generation` is the one the
  // caller addressed; `check` re-proves the caller's authority at the no-gap point before the answer is journaled.
  async answer({ sessionId, messageId, text, generation, check }) {
    if (
      !uuid(sessionId) ||
      !uuid(messageId) ||
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > MAX_ANSWER_BYTES
    )
      throw Error("Invalid question answer");
    const prior = this.intent(messageId);
    if (prior) {
      const body = JSON.parse(prior.body);
      if (prior.session !== sessionId || body.kind !== "question-answer")
        throw Error("Answer identity conflict");
      return {
        sessionId,
        messageId,
        state:
          { answered: "answered", "answer-refused": "refused", intent: "uncertain" }[prior.state] ??
          "uncertain",
        requestId: body.requestId,
      };
    }
    return this.control.exclusive(sessionId, async () => {
      let s = this.store.get(sessionId);
      if (!s || s.mode !== "delegated" || s.generation !== generation)
        throw Error("Control changed; refresh before answering");
      if (authorityKey(await this.control.authority(s.task)) !== s.authority)
        throw Error("Task authority changed since handback");
      const current = await this.control.native.inspect(sessionId);
      s = this.store.get(sessionId);
      if (!s || s.mode !== "delegated" || s.generation !== generation)
        throw Error("Control changed; refresh before answering");
      if (
        current.archivedAt ||
        (current.boot ?? null) !== s.boot ||
        current.humanAt >= s.grantedAt ||
        this.control.promptIdentityChanged(current, s)
      ) {
        this.control.takeover(
          sessionId,
          "Native input identity changed before a question answer; handback required",
          { observed: current, cause: this.control.recovery?.cause(s, current) },
        );
        throw Error("Human activity or changed identity revoked delegation");
      }
      // The daemon's permission guard binds every permission intent to the agent's native session
      // (trusted-contribution.mjs agent.permission_respond), exactly as routine permission intents are (permissions.mjs).
      if (current.nativeIdentity?.conflict || !current.nativeId)
        throw Error("A question answer requires a resolved consistent native identity");
      const request = await this.pending(sessionId);
      if (!request) throw Error("The session has no pending question");
      const origin = s.expected && this.store.delivery(s.expected);
      if (origin?.kind !== "send" || origin.session !== sessionId || origin.state !== "delivered")
        throw Error(
          "The pending question belongs to a turn the controller did not start; its human answers it",
        );
      check?.();
      const response = answerResponse(request, text.trim());
      const body = {
        kind: "question-answer",
        generation: s.generation,
        boot: s.boot,
        nativeId: current.nativeId,
        origin: s.expected,
        authority: s.authority,
        requestId: request.id,
        requestDigest: digest(canonical(permissionProjection(request))),
        response: canonical(response),
        expectedLastUserAt: current.lastUserAt ?? null,
      };
      this.store.atomic(() => {
        // Review H7 M2: bounded here, BEFORE anything is written, in a budget of their own -- question answers never use
        // the routine-permission journal's capacity (permissions.mjs counts only its own pools) -- and charged to the
        // task's instruction allowance like any other instruction to it.
        const pool = "question:" + sessionId;
        if (
          this.db.prepare("SELECT count(*) n FROM permission_intents WHERE pool=?").get(pool).n >=
          MAX_ANSWERS_PER_SESSION
        )
          throw Error(`This session has received its ${MAX_ANSWERS_PER_SESSION} question answers`);
        if (
          this.db
            .prepare(
              "SELECT count(*) n FROM permission_intents WHERE pool=? AND json_extract(body,'$.requestId')=?",
            )
            .get(pool, request.id).n >= MAX_ANSWERS_PER_QUESTION
        )
          throw Error("This question has already been answered or refused; inspect the session");
        if (
          this.db
            .prepare("SELECT count(*) n FROM permission_intents WHERE pool LIKE 'question:%'")
            .get().n >= MAX_QUESTION_ANSWERS
        )
          throw Error("Question answer capacity reached");
        this.control.allowance?.charge(s.task, messageId);
        this.db
          .prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'intent',?,NULL,?)")
          .run(
            messageId,
            digest(canonical(["question-answer", sessionId, request.id, messageId])),
            sessionId,
            "question:" + sessionId,
            canonical(body),
            Date.now(),
          );
      });
      const finish = (state, result) =>
        this.db
          .prepare("UPDATE permission_intents SET state=?,result=? WHERE id=?")
          .run(state, canonical(result), messageId);
      try {
        const receipt = await this.control.native.answer(sessionId, messageId, response);
        if (
          receipt?.agentId !== sessionId ||
          receipt.requestId !== "orca-permission:" + messageId ||
          receipt.resolution?.behavior !== "allow"
        )
          throw Error("Native answer acknowledgment uncorrelated");
        finish("answered", {
          receipt,
          note: "The question was answered with the owning seat’s text",
        });
        return { sessionId, messageId, state: "answered", requestId: request.id };
      } catch (e) {
        const refused = e.message.includes("Orca native permission refused");
        finish(refused ? "answer-refused" : "answer-uncertain", { note: e.message });
        return {
          sessionId,
          messageId,
          state: refused ? "refused" : "uncertain",
          requestId: request.id,
          error: e.message,
        };
      }
    });
  }
}
