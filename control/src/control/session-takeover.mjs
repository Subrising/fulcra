// One host-owned seam for manual switches and usage-limit recovery. Credentials are
// resolved only by agent.session_open; the daemon fences/reconnects the same native id.
import { randomUUID } from "node:crypto";
import { accountStatus, readAccounts, update } from "../../orca-organization/server/accounts.mjs";
const refused = (message) => ({ ok: false, outcome: "refused", message });
// Host refusal reasons that are safe to show. Anything else is reported as "unknown", never echoed.
const HOST_REASONS = new Set([
  "stale",
  "unsupported",
  "invalid_changes",
  "prepare_failed",
  "close_failed",
  "resume_failed",
]);
// FU-790: say which busy condition held. The code comes from the host; only known codes are shown.
const BUSY_TEXT = {
  active_turn: "The host could not switch this session; finish any active turn and try again",
  in_flight_run:
    "The host could not switch this session: a run is in progress. Wait for it, then try again",
  input_delivery:
    "The host could not switch this session: a message is being delivered. Wait a moment, then try again",
  pending_replacement:
    "The host could not switch this session: a session replacement is pending. Wait for it, then try again",
  pending_permission:
    "The host could not switch this session: a permission request is open. Answer it, then try again",
  foreground_mutation:
    "The host could not switch this session: another change is in progress. Wait for it, then try again",
  subagent_running:
    "The host could not switch this session: a subagent is running. Wait for it, or run fulcra agent reload <id> to end it, then try again",
  not_idle:
    "The host could not switch this session: it is not idle. Wait for it to be idle, then try again",
};
function busyMessage(detail) {
  const [code, n] = String(detail ?? "").split(":");
  if (code === "background_work" && /^\d{1,3}$/.test(n ?? ""))
    return `The host could not switch this session: background work is running (${n}). Wait for it, or run fulcra agent reload <id> to end it, then try again`;
  return (
    BUSY_TEXT[code] ??
    "The host could not switch this session; it is busy (reason not reported). Wait for it, then try again"
  );
}
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

export async function takeOverSession(
  sessionId,
  targetAccount,
  {
    control,
    root = control?.poolRoot,
    generation,
    now = Date.now,
    reconcile = false,
    switchId,
    reason = "manual",
    requireUnowned = false,
  } = {},
) {
  const accountId = typeof targetAccount === "string" ? targetAccount : targetAccount?.id;
  if (!["manual", "limit"].includes(reason)) return refused("Invalid account switch reason");
  if (
    !uuid(sessionId) ||
    !uuid(accountId) ||
    !root ||
    !control?.exclusive ||
    !control?.store ||
    !control.native?.recover
  )
    return refused("Account takeover is unavailable for this session");
  try {
    return await control.exclusive(sessionId, async () => {
      // FIX-8 B-1: `current` is absent for the owner's OWN chat -- an ordinary app chat the controller never enrolled.
      // It has no delegation to fence, so only the owner's manual switch applies to it; every other guard below stays
      // (idle, target account, the durable intent bound to boot and the human-input cursor, rollback on refusal).
      const current = control.store.get(sessionId) ?? null;
      if (requireUnowned && current?.mode === "delegated")
        return refused("Another owner controls this session");
      if (current && !["human", "delegated"].includes(current.mode))
        return refused("Session control changed; refresh before switching");
      if (reason !== "manual" && current?.mode !== "delegated")
        return refused("Session control changed; automatic account rotation requires delegation");
      if (current?.mode === "delegated" && current.generation !== generation)
        return refused("Session control changed; refresh before switching");
      if (control.native.route?.(sessionId))
        return refused("Switch this session on the host that runs it");
      const observed = await control.native.inspect(sessionId);
      if (observed.archivedAt)
        return refused("This session is archived. Restore it before switching accounts");
      if (
        current?.mode === "delegated" &&
        ((observed.boot ?? null) !== current.boot ||
          observed.humanAt >= current.grantedAt ||
          control.promptIdentityChanged(observed, current))
      ) {
        control.takeover(
          sessionId,
          "Native input identity changed before an account change; handback required",
          { observed, cause: control.recovery?.cause(current, observed) },
        );
        return refused("Human activity or changed identity revoked delegation");
      }
      const snapshot = await control.native.snapshot(sessionId);
      if (snapshot.archivedAt)
        return refused("This session is archived. Restore it before switching accounts");
      if (
        !["idle", "error", "closed"].includes(snapshot.status) ||
        observed.pending ||
        snapshot.pendingPermissions?.length
      )
        return refused(
          "A turn is running or waiting for input; finish it before switching accounts",
        );
      const fresh = control.store.get(sessionId);
      if (
        (fresh?.mode ?? null) !== (current?.mode ?? null) ||
        (fresh?.generation ?? null) !== (current?.generation ?? null)
      )
        return refused("Session control changed; refresh before switching");
      const pool = readAccounts(root),
        previous = pool.assignments[sessionId];
      const from = pool.accounts.find((a) => a.id === previous?.accountId);
      const unresolvedId = reconcile ? (switchId ?? previous?.takeover) : previous?.takeover;
      const unresolved = unresolvedId && control.store.delivery(unresolvedId);
      if (
        previous?.takeover &&
        (!reconcile ||
          previous.accountId !== accountId ||
          !unresolved ||
          !["intent", "uncertain"].includes(unresolved.state))
      )
        return refused("An earlier account switch needs reconciliation before switching again");
      if (
        unresolved &&
        (unresolved.kind !== "account-switch" ||
          unresolved.session !== sessionId ||
          !["intent", "uncertain"].includes(unresolved.state) ||
          (previous?.takeover && previous.takeover !== unresolved.id))
      )
        return refused("The account switch no longer matches this session");
      if (reconcile && !unresolved)
        return refused("There is no unresolved account switch to reconcile");
      // FU-655: the pool already holds this account for this session under the unresolved marker. The host restart below
      // proves the running account, so a changed boot or new human input cannot block the settle.
      const settling = Boolean(reconcile && unresolved && previous?.accountId === accountId);
      if (unresolved) {
        const body = JSON.parse(unresolved.body);
        reason = body.reason ?? reason;
        if (
          body.accountId !== accountId ||
          (body.generation ?? null) !== (current?.generation ?? null) ||
          (!settling &&
            (body.boot !== (observed.boot ?? null) || body.humanAt !== (observed.humanAt ?? 0)))
        )
          return refused("Session identity changed; the earlier switch needs host reconciliation");
      }
      if (reason !== "manual" && current?.mode !== "delegated")
        return refused("Session control changed; automatic account rotation requires delegation");
      // Revalidate inside the session fence; plugin reads are only advisory.
      const target = readAccounts(root).accounts.find((a) => a.id === accountId);
      if (!target || target.provider !== snapshot.provider)
        return refused("Choose an account for this session’s provider");
      const status = accountStatus(target, now());
      if (status.state !== "ok")
        return refused(
          status.state === "limited"
            ? `That account is limited until ${status.until}`
            : "That account is disabled or needs sign-in",
        );
      const prior = unresolved ? JSON.parse(unresolved.body) : null;
      const eventId = unresolved?.id ?? randomUUID(),
        at = prior?.at ?? new Date(now()).toISOString();
      const move = prior?.move ?? {
        from: from?.id ?? null,
        fromName: from?.name ?? "Unassigned",
        toName: target.name,
      };
      // Intent is durable before assignment/dispatch. Unknown outcomes block replay.
      if (!unresolved)
        control.store.admit(eventId, sessionId, "account-switch", {
          accountId,
          at,
          reason,
          move,
          generation: current?.generation ?? null,
          boot: observed.boot ?? null,
          humanAt: observed.humanAt ?? 0,
        });
      let assigned = false;
      const rollback = () =>
        update(root, (state) => {
          if (state.assignments[sessionId]?.takeover !== eventId) return;
          if (previous) state.assignments[sessionId] = previous;
          else delete state.assignments[sessionId];
        });
      try {
        await update(root, (state) => {
          const live = state.accounts.find((a) => a.id === accountId);
          const held = state.assignments[sessionId];
          if (
            !live ||
            live.provider !== snapshot.provider ||
            accountStatus(live, now()).state !== "ok" ||
            JSON.stringify(held) !== JSON.stringify(previous)
          )
            throw Error("Account changed");
          state.assignments[sessionId] = {
            accountId,
            provider: live.provider,
            at,
            ended: false,
            takeover: eventId,
          };
        });
        assigned = true;
        if (unresolved)
          control.store.finish(eventId, "intent", {
            message: "Reconciling the same account and session after an idle host inspection",
          });
        // No credential or new prompt is sent here. The daemon reruns session_open,
        // checks its own busy/authority fence, and resumes the saved persistence handle.
        let result = await control.native.recover(sessionId);
        // FU-585: after a host restart the session is not resident, so the host refuses the in-place restart. Load it
        // (the same step as `fulcra agent reload <id>`), then ask again once.
        // FU-790: an idle session the host does not hold can also come back as "stale", "unsupported" or
        // "prepare_failed". Every refusal except "busy" gets the same one load and one retry.
        if (
          result?.outcome === "refused" &&
          result.reason !== "busy" &&
          typeof control.native.reload === "function" &&
          (await control.native.reload(sessionId).then(
            () => true,
            () => false,
          ))
        )
          result = await control.native.recover(sessionId);
        if (result?.outcome !== "refreshed") {
          if (
            !unresolved &&
            (result?.outcome === "refused" || result?.reason === "prepare_failed")
          ) {
            await rollback();
            const reply = refused(
              result?.reason === "busy"
                ? busyMessage(result.busyDetail)
                : result?.reason === "not_resident"
                  ? "The host could not load this session after a restart; run fulcra agent reload <id> and try again"
                  : `The host could not switch this session (reason: ${HOST_REASONS.has(result?.reason) ? result.reason : "unknown"}); it is not busy. Run fulcra agent reload <id> and try again`,
            );
            control.store.finish(eventId, "refused", reply);
            return reply;
          }
          throw Error("Reconnect outcome requires reconciliation");
        }
        await update(root, (state) => {
          const held = state.assignments[sessionId];
          if (held?.takeover !== eventId || held.accountId !== accountId)
            throw Error("Account changed");
          delete held.takeover;
          held.ended = false;
          const live = state.accounts.find((a) => a.id === accountId);
          if (live) live.lastUsedAt = at;
          // Pool history is a projection of the journal switch, keyed for crash replay.
          // Limit rotation already wrote its own row when it selected this target.
          if (reason !== "limit" && !state.rotations.some((r) => r.switchId === eventId)) {
            state.rotations.push({
              at,
              session: sessionId,
              provider: target.provider,
              from: move.from,
              fromName: move.fromName,
              to: accountId,
              toName: move.toName,
              resetAt: null,
              earliestReset: null,
              stopId: null,
              reason,
              switchId: eventId,
            });
          }
        });
        const reply = {
          ok: true,
          outcome: "refreshed",
          sessionId,
          switchId: eventId,
          reason,
          account: {
            id: accountId,
            name: target.name,
            provider: target.provider,
          },
          at,
          message: `Switched to account "${target.name}" at ${at}`,
        };
        control.store.finish(eventId, "delivered", reply);
        return reply;
      } catch {
        const uncertain = assigned || Boolean(unresolved);
        const reply = uncertain
          ? {
              ok: false,
              outcome: "uncertain",
              switchId: eventId,
              message:
                "The account switch needs reconciliation; do not retry until the host confirms its session state",
            }
          : refused("The account changed before switching; refresh and try again");
        control.store.finish(eventId, uncertain ? "uncertain" : "refused", reply);
        return reply;
      }
    });
  } catch {
    return refused("The session is busy or needs reconciliation before switching accounts");
  }
}
