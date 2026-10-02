# W2 shared account takeover seam

Early interface commit: `0b8441b0` on `cc/v02-u7-w2` (published for W1).
The implementation now exports `takeOverSession` from
`src/control/session-takeover.mjs`, with a matching `.d.mts` declaration.

```js
const result = await takeOverSession(sessionId, accountId, {
  control,
  root,
  generation,
});
```

`control` is the existing host controller; `root` defaults to its `poolRoot`.
The plugin entry point is `localCall("session-takeover", { session, accountId })`.
For W1 adapter compatibility, an optional `reason: "manual"` is accepted;
`reason: "limit"` from callers is refused and only rotation supplies it internally.
It is a strict management write requiring local owner management authority, never
a read or device command (even a device claiming both management permissions is
refused). It captures the current generation and calls this seam. The reply
includes the account-switch delivery `state`, `switchId` when recorded, and a
plain `message`. Read-only plugin invocations and session-capability lanes refuse.
Delegated sessions require their current `generation`. The target may also be
`{ id: accountId }`; credentials are never arguments. W1 owns the UI/chat-command
wiring; the controller command is implemented here. Both usage-limit reconnect paths now call this same seam.

Result: `{ ok, outcome, message }`, with `outcome` `refreshed`, `refused`, or
`uncertain`. Success includes public account identity, session id, and timestamp.
An uncertain result includes `switchId` for the existing controller `recover`
action. No prompt is sent by this function.

## Continuity and running turns

A running turn or pending permission is refused with a plain message. A successful
manual switch keeps the full delegated row, generation and native human-input /
prompt identity unchanged. Revocation happens only when the pre-switch inspection
already reports an archive, changed boot, human cursor at/after delegation, or
changed prompt identity; the quiet reconnect itself sends no human input. An idle or
provider-error session uses the existing native `recover` / same-config MCP
reconnect. The product's `reloadQuietMcpSession` reruns `agent.session_open`,
retains `cwd` and the persistence handle, and verifies the resumed native id.
Claude takes B's OAuth token only through its process environment, with the same
conversation/transcript location. Codex uses B's existing `auth.json` and the
account pool's shared sessions/rollout/index/SQLite base. No provider settings or
shared config keys are changed. The existing product u7 implementation suffices;
there are no product source changes.

A takeover pins the target assignment through launch. Missing credentials or a
newly disabled/limited/removed target cannot fall back to another account or the
machine login. The native guard permits exactly one matching account-switch
intent, bound to generation, boot, human-input cursor and target. Other pending
operations, changed authority, running turns and remote-host switches refuse.

## History and uncertain outcomes

The controller journal records one canonical `account-switch` delivery associated
with the session, with `reason: "manual" | "limit"` in its body and result. Its result contains `Continued on account "B" at <timestamp>`. This is
included in the task's session-delivery history, without adding a model prompt.
Successful manual moves also project into the pool history used by Settings Recent
moves, keyed by the same switch ID so reconciliation cannot duplicate the row.
The durable intent retains the original source account and timestamp. Limit
rotation already writes its pool row, now tagged with reason `limit`; reconnect
does not append a second row. W1 owns displaying reason labels in its UI schema.

Automatic (`limit`) reconnects require delegation inside the session fence,
including reconciliation of earlier limit intents. Manual switches may act on
human-held sessions. Target provider and availability are revalidated inside
that fence and again under the account-store lock.

A definite pre-close refusal restores the previous assignment. A lost reply or
failure after close begins retains uncertainty and blocks ordinary retries.
`control.recover(switchId)` explicitly rechecks the idle host, same target and
same generation/boot/human cursor, then re-establishes that account through the
same quiet reconnect. This sends no conversational instruction. Reconciliation
handles interruption before assignment and after pin cleanup; failed preparation
never erases earlier uncertainty. Generic disposition cannot silently abandon a
pinned switch. Changed host identity requires host-level reconciliation and is
not auto-overridden.

## Verification and handoff

Tests use temporary homes, stub credentials and CLI processes. No real accounts,
Keychain entries, live services, app installations or provider settings are used.
Focused regressions cover both providers' history, B's environment credential,
Codex's shared rollout and SQLite base, running/limited refusal, guard races,
missing credentials, lost replies and interrupted persistence writes.

The task-local `../evidence/` directory holds fail-before/pass-after logs,
changed-file ESLint results, workspace typecheck output and the final handoff.
The release gate and merged W1 acceptance remain with the update-7 team.
