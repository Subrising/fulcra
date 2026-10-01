# Trusted bundled host plugins

Distribution authors supply an immutable `bundledPluginsDirectory` to `createPaseoDaemon` at startup.
Each child directory contains `paseo-plugin.json` with the matching ID and a prebuilt `index.host.js`.
V1.1 entry modules export `hostContract = "1.1"` and a default `TrustedPluginContribution` from
`@getpaseo/plugin/server`. The declaration selects an ABI; it does not grant trust. The distribution
must be outside `PASEO_HOME`, with protected ownership and permissions. Symlinks and escaped entries
are refused. Ordinary plugin management cannot install or enable these contributions.

Trusted contributions execute synchronously in the host and have its full authority. This is not a
sandbox against code running as the same operating-system user. Ordinary plugin calls to the host
security APIs throw. The explicit V1.0 compatibility path retains `LegacyTrustedPluginContribution`;
its catalog entries never claim V1.1.

## Register policy

```ts
import type { TrustedPluginContribution } from "@getpaseo/plugin/server";
export const hostContract = "1.1";
const setup: TrustedPluginContribution = (server) => {
  server.admission.onInput((agent, input) => {
    return journalAccepts(agent, input.operation, input.provenance) ? "allow" : "deny";
  });
  server.guard("agent.permission_respond", (agent, requestId, response, input) => {
    if (agent.permissions.status !== "known") return "deny";
    return resolvePermissionIntent(agent, requestId, response, input.operation);
  });
  server.claude.deny(() => ["Read(/example/private/**)", "Write(/example/private/**)"]);
  server.admission.mcpRefresh((agent) => ({
    allowed: journalOwns(agent, server.inputObservations),
    revision: supervisionRevision(agent.id),
  }));
  server.admission.codexTurn({
    check: (agent, turn, quota) => (quotaJournalAllows(agent, turn, quota) ? "allow" : "deny"),
    onQuotaReadFailure: (agent, turn, failure) => {
      recordDurableNoDispatchReceipt(agent, turn, failure);
    },
  });
};
export default setup;
```

The journal functions are controller policy. Hooks must be synchronous and explicitly allow.
Promises, malformed replies and throws refuse effects. Codex registers both callbacks atomically.
A quota-read failure always refuses native dispatch, even if the failure callback tries to allow.
Submission/acknowledgement errors are never classified as quota-read failures. A failed receipt write
cannot establish retry safety.

Input includes an immutable primary operation: a host UUID, agent, primary kind, message ID, payload
digest, verified plugin and journal attempt. Nested checks keep the primary identity through private
operation handles. Queued work carries those handles explicitly; inherited async context alone does
not confer attribution. Unattributed human input advances the human fence before policy refusal.
Existing-agent schedules start a fresh human scope; subscribers and daemon teardown use fresh daemon
scopes. Rewind, archive and delete preserve their pre-effect refusal boundaries.

## Bind an input

The browser-safe helpers in `@getpaseo/protocol/trusted-input` define canonical payload bytes. Hash
`canonicalTrustedPayload({agentId, kind, messageId, payload})` with SHA-256 over UTF-8 in host/controller
Node code. The digest includes actual prompt blocks, attachments and normalised effect-bearing options,
or the complete permission response or fixed command discriminator and arguments. Optional envelope
message IDs use null. `sendPromptToAgent` defaults unarchive and replacement to true;
`startAgentRun` defaults replacement to false. Direct manager run options use null for choices that
layer cannot make. Do not infer defaults from the current agent's preferences.

Keep the setup context and returned tokens private. Call
`server.issueProvenance({agentId, kind, messageId, payloadDigest, attemptId})` with full UUIDs for agent
and attempt, then send the returned string as `inputProvenance` on the bound RPC. Tokens are single-use,
expire after 60 seconds and are limited to 4096 outstanding per host. The host recomputes the digest
from the actual operation; a caller's digest is never an observation. Changed, replayed or expired
capabilities refuse before protected work. A message prefix does not establish provenance.

Authentication and input attribution are separate. The private transport and authenticated management
bridge are separate host integrations; these APIs do not expose a public mint RPC or daemon password.

## Observe authoritative facts

The storage index is complete before trusted setup, which still precedes provider launch/probes.
`server.inputObservations.require(agentId)` returns a frozen `{boot, humanAt}` or throws. Unknown,
deleted, unindexed, closed-host and unsafe-counter observations are unavailable. Lookups never create
membership or counters. Deleted IDs remain tombstoned; reloads retain counters; restart changes boot.
Controllers must read parent/root fences here instead of keeping hook-only caches.

`agent.permissions` is either unavailable or a deeply copied, frozen canonical request list plus
in-flight request IDs. Stored-only descriptors cannot claim live permission state. Permission intent
rewrites must resolve to a request still pending on the same agent. The host compares the pre-guard
snapshot after all guards and checks in-flight state before synchronous reservation and submission.

`agent.runtime` distinguishes unavailable state from known null fields. Live instances get fresh host
UUIDs on registration/replacement. Native session/model use live runtime information with the live
configuration/persistence fallback; service tier and timestamp projections are shared with their
provider/wire paths. Labels and journal expectations never supply runtime facts.
Live agent snapshots also expose `runtimeInstanceId`, the same host-owned instance UUID.
It is an observation, not a capability, and is omitted from stored/closed projections and
persistence. A controller can record it alongside a delivered creation receipt and
compare that creation-bound identity with trusted runtime facts before a first prompt.
A null native session ID alone never proves controller creation or first-delivery authority;
bootstrap policy must retain payload, operation, runtime-change and input-fence checks.

## Check activation

`DaemonClient.getPluginCatalog()` returns the entire catalog object; ordinary consumers use `.plugins`.
Old hosts' missing trusted fields remain absent. V1.1 hosts include `trustedHost: {contract:"1.1", boot}`
and report each V1.1 contribution's ID, contract and registered hooks. Require exactly the controller's
own ID and all five distinct hooks (`input`, `permission`, `deny`, `mcp`, `codex`), the expected contract
and the current connection's boot. Revalidate after connection or boot change. Ordinary plugin entries
and legacy reports are not V1.1 authority. Registration proves hooks exist, not that policy is correct.

Protocol, plugin and client must ship as a compatible release set before a controller dependency
update. Local source builds and draft PRs do not establish published-client compatibility.
