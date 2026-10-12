# Host-link notices and worker creation

Status: proposed design. Implementation has not started.

## Problem

- FU-105 — Cross-host worker notices: `role:main-assistant` resolves only against local chats. Remote holders cause `role has no chat`.
- FU-76 — Cross-host spawn: leads need a restricted route to create workers on another computer.

The approved review separates reporting lines from creation ancestry (`PASEO-VS-FULCRA-2026-10-12.md:38`).
It describes remote delivery limits at line 350 and report-up suppression at lines 369–372.

The current base has no host-link transport. The previous remote receiver is retired (`control/src/book/README.md:1`).
Do not restore that receiver or use daemon passwords for the new route.

## Security boundary

The owner grants a directed link between two daemon identities.
Each link has a separate random credential, a fixed destination, and explicit operations.
Transport requires HTTPS; HTTP is permitted only for loopback tests.
The destination records allowed source leads, target workspace roots, providers, models, restriction limits, and worker limits.
Creating workers is disabled unless the owner grants it.
Notice-only links cannot create workers.

A lead authenticates locally with its own chat token.
The source daemon derives the sender identity from that token.
Caller fields and labels cannot claim another chat or grant a link.
The daemon keeps link credentials private and never sends them to workers.

The destination authenticates the link before resolving a role or starting a provider.
It applies its own policy to every request.
It rejects unknown, revoked, expired, or wrongly scoped credentials.
Link and chat credentials cannot authenticate to the general WebSocket or MCP control endpoint.
An unconfigured link fails; it never falls back to a daemon password.

This boundary restricts a compromised worker or lead to the granted link operations.
It does not protect against a compromised owner account or destination daemon.
A compromised source daemon can claim identities permitted by its link grant.

## Worker creation

The source uses an owner-defined workload rule to select the destination.
GPU and heavy workloads select the configured PC target.
Other workloads use their configured target.
Missing targets and unsupported workloads fail without local substitution.
The destination rechecks the workload against its link policy.

Accept a bounded prompt, a permitted provider/model, and a workspace identifier mapped by destination policy.
Reject caller-supplied executable paths, environment variables, credentials, role claims, and arbitrary target directories.
Keep destination account selection and provider permissions under destination authority.
Preserve restriction limits; remote creation cannot select a broader permission mode.
Workers cannot create further remote workers without a separate owner grant.

Persist the request identity before creation.
Bind the receipt to the link, source lead, request body, destination, and created worker.
An identical retry returns the retained receipt.
A changed body under the same identity fails.
Uncertain creation requires reconciliation against the retained worker identity; it must not create a second worker.

Issue a separate token for each created chat, scoped to its allowed follow-up operations.
Revoking a link blocks later admissions.
Revocation does not prove that previously admitted provider work stopped.

## Notices

The destination resolves `role:main-assistant` at delivery time.
Missing or ambiguous holders refuse delivery.
The source validates the reporter's recorded reporting line.
The destination admits only notice text from an allowed link and reporter.
Notice text cannot create a role grant or authorize another operation.

Use the destination's existing held-send path so a notice cannot cancel a running turn.
Keep the finish-notification ownership checks and lead-success suppression rules.
Resolve role changes again before final input admission.
Retain one notice identity across uncertain transport replies.
Expose delivery failure to the sender without an acknowledgement-only wake.

## Verification

Use isolated daemon homes and ephemeral ports. Keep all installed daemons and live configurations unchanged.

- Exercise real HTTP transport between two isolated daemons.
- Create one remote worker through an authenticated lead; verify its parent route and one initial turn.
- Test the configured PC workload rule without creating sessions on the installed PC daemon.
- Deliver a remote notice to the current role holder, including a busy holder and a role change before delivery.
- Preserve armed finish notifications, notice-loop prevention, and normal lead-success suppression.
- Refuse wrong-link, revoked, expired, notice-only, and foreign-chat tokens before any provider starts.
- Refuse forged sender IDs, unauthorized providers, broader permission modes, disallowed paths, and worker recursion.
- Test duplicate requests, changed retry bodies, lost replies, crash recovery, and offline destinations.
- Run focused tests, workspace typecheck, lint, formatting, and the normal Git hooks.
- Obtain one fresh security review before delivery. Recheck only fixes from that review.

Live Mac-to-Mac and Mac-to-PC acceptance remains separate from isolated transport proof.
This batch permits no live installation, daemon restart, or configuration change.
