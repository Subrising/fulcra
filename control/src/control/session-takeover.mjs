// One host-owned seam for manual switches and usage-limit recovery. Credentials are
// resolved only by agent.session_open; the daemon fences/reconnects the same native id.
import { randomUUID } from "node:crypto";
import { accountStatus, readAccounts, update } from "../../orca-organization/server/accounts.mjs";
const refused = (message) => ({ ok: false, outcome: "refused", message });
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
      if (current && !["human", "delegated"].includes(current.mode))
        return refused("Session control changed; refresh before switching");
      if (reason === "limit" && current?.mode !== "delegated")
        return refused("Session control changed; automatic account rotation requires delegation");
      if (current?.mode === "delegated" && current.generation !== generation)
        return refused("Session control changed; refresh before switching");
      if (control.native.route?.(sessionId))
        return refused("Switch this session on the host that runs it");
      const observed = await control.native.inspect(sessionId);
      if (
        current?.mode === "delegated" &&
        (observed.archivedAt ||
          (observed.boot ?? null) !== current.boot ||
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
      if (
        !["idle", "error"].includes(snapshot.status) ||
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
      if (unresolved) {
        const body = JSON.parse(unresolved.body);
        reason = body.reason ?? reason;
        if (
          body.accountId !== accountId ||
          (body.generation ?? null) !== (current?.generation ?? null) ||
          body.boot !== (observed.boot ?? null) ||
          body.humanAt !== (observed.humanAt ?? 0)
        )
          return refused("Session identity changed; the earlier switch needs host reconciliation");
      }
      if (reason === "limit" && current?.mode !== "delegated")
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
        const result = await control.native.recover(sessionId);
        if (result?.outcome !== "refreshed") {
          if (
            !unresolved &&
            (result?.outcome === "refused" || result?.reason === "prepare_failed")
          ) {
            await rollback();
            const reply = refused(
              "The host could not switch this session; finish any active turn and try again",
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
          if (reason === "manual" && !state.rotations.some((r) => r.switchId === eventId)) {
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
          account: { id: accountId, name: target.name, provider: target.provider },
          at,
          message: `Continued on account "${target.name}" at ${at}`,
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
