// DESIGN-R R2: plugin-server handlers for the Recovery panel. Dependency-free and injected with the controller
// call, so they are tested with plain node. Every write goes to the controller's OPERATOR path (the same
// localCall management uses); the controller re-derives and gates every one. This file adds no authority.
import { validateRecovery } from "../shared/recovery-view.mjs";
const id = (v) => typeof v === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const reasonOk = (v) => typeof v === "string" && v.trim().length >= 12 && v.length <= 2000;
const HUMAN_TOUCHED =
  "Someone used this chat directly since it was handed to Fulcra, or it was restarted another way, so nothing changed. Hand it back to Fulcra, then try again";
// The controller's fresh-start words, made readable inside one sentence: no repeated "Stopped for review:" prefix,
// no doubled full stop, and the one internal race message said plainly.
const STARTED_WORKING =
  "It started working just before the fresh start, so nothing changed. Try again when it is idle";
function freshStartWords(text) {
  const words = String(text ?? "")
    .replace(/^Stopped for review:\s*/i, "")
    .trim()
    .replace(/[.\s]+$/, "");
  if (/no longer idle/i.test(words)) return STARTED_WORKING;
  if (/human input or changed native identity/i.test(words)) return HUMAN_TOUCHED;
  return words;
}
export function createRecovery(call, now = () => new Date().toISOString()) {
  async function read() {
    const observedAt = now();
    try {
      return {
        status: "observed",
        observedAt,
        recovery: validateRecovery(await call("recovery-status", null)),
      };
    } catch (e) {
      return { status: "error", observedAt, message: String(e.message ?? e).slice(0, 500) };
    }
  }
  async function act(input) {
    const observedAt = now(),
      done = (status, message, extra = {}) => ({ status, message, observedAt, ...extra });
    try {
      if (!input || typeof input !== "object") throw Error("Invalid recovery action");
      if (input.action === "resume") {
        if (
          !id(input.messageId) ||
          !id(input.sessionId) ||
          !id(input.interruptionId) ||
          !Number.isSafeInteger(input.expectedGeneration) ||
          !reasonOk(input.reason) ||
          (input.continuation !== undefined &&
            (typeof input.continuation !== "string" || input.continuation.length > 4000))
        )
          throw Error("Invalid resume");
        const d = await call("session-resume", {
          messageId: input.messageId,
          sessionId: input.sessionId,
          interruptionId: input.interruptionId,
          expectedGeneration: input.expectedGeneration,
          reason: input.reason.trim(),
          ...(input.continuation?.trim() ? { continuation: input.continuation.trim() } : {}),
        });
        const c = d.result?.continuation?.state;
        return done(
          d.state,
          d.state !== "delivered"
            ? "Resume was not applied: " + (d.result?.error ?? d.state)
            : c === "delivered"
              ? "Handed back and continued with one controller-written message. Resumed does not mean completed."
              : `Handed back; the continuation is ${c ?? "not sent"}. Press Resume again to retry it with the same identity.`,
          { messageId: input.messageId },
        );
      }
      if (input.action === "resume-team") {
        if (
          !id(input.messageId) ||
          !reasonOk(input.reason) ||
          !Array.isArray(input.items) ||
          !input.items.length ||
          input.items.length > 8
        )
          throw Error("Invalid team resume");
        const r = await call("session-resume-batch", {
          messageId: input.messageId,
          reason: input.reason.trim(),
          items: input.items,
        });
        const ok = r.results.filter((x) => x.outcome?.state === "delivered").length;
        return done(
          ok === r.results.length ? "delivered" : "partial",
          `Resumed ${ok} of ${r.results.length}, leaders first, each gated on its own.`,
          {
            messageId: input.messageId,
            results: r.results.map((x) => ({
              sessionId: x.sessionId,
              state: x.outcome?.state ?? "refused",
              error: x.error ?? null,
            })),
          },
        );
      }
      if (input.action === "dismiss") {
        if (!id(input.interruptionId) || !reasonOk(input.reason)) throw Error("Invalid dismissal");
        await call("session-interruption-dismiss", {
          interruptionId: input.interruptionId,
          reason: input.reason.trim(),
        });
        return done("dismissed", "Dismissed. The session stays under human control.");
      }
      if (input.action === "reconcile") {
        if (!id(input.messageId)) throw Error("Invalid reconcile");
        const d = await call("recover", input.messageId);
        return done(
          d.state,
          d.state === "delivered"
            ? "The host confirmed this delivery. Recovery takes the session over; hand it back when ready."
            : `Still ${d.state}; no instruction was re-sent.`,
          { messageId: input.messageId },
        );
      }
      if (input.action === "fresh-start") {
        if (!id(input.messageId) || !id(input.sessionId) || !reasonOk(input.reason))
          throw Error("Invalid fresh start");
        const d = await call("session-fresh-start", {
          messageId: input.messageId,
          sessionId: input.sessionId,
          reason: input.reason.trim(),
        });
        const state = d?.state ?? "refused";
        return done(
          state,
          state === "rotated"
            ? "Started fresh. The handoff is saved and the same chat continues in a new context."
            : state === "held"
              ? `Fresh start stopped for review: ${freshStartWords(d?.outcome) || "the controller held it"}.`
              : `Fresh start was not applied: ${freshStartWords(d?.error ?? d?.outcome ?? state)}.`,
          { messageId: input.messageId },
        );
      }
      throw Error("Unknown recovery action");
    } catch (e) {
      return done("error", String(e.message ?? e).slice(0, 500));
    }
  }
  return { read, act };
}
