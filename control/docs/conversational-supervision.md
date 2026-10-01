# AIN90: persistent supervision from ordinary conversation

The normal OpenClaw route could coordinate individual sessions but did not expose the controller's existing manager role. Add `supervise`, `supervisors` and `supervisor-result` to that same trusted local client. This enables an authorized Codex supervisor to use its already installed MCP manager tools and receive native worker events while retaining its normal conversational send/result binding.

## Architecture decision and scope

Reuse the existing recorded manager-tool capability, generation-checked handback, private origin binding, manager grant and event-linked worker implementation. A separate supervisor service or new controller RPC would add deployment and authority surface without being necessary for this slice. Listing groups alone would leave the conversational entry point unable to organize work.

`supervise` requires a human-owned Codex session, the exact current generation, a reason and a worker allowance of 1–6 concurrent live workers. It refuses any saved manager role and any session absent from the controller's recorded eligible candidates. Existing handback provides the concurrency check; only one call can acquire the expected next generation. The normal private binding is persisted before granting the separate manager role. No worker or model instruction is started by this action. The returned object contains no capability. There is no implicit role rotation, adoption or restoration of previous worker organizations.

The flow is human-owned candidate → delegated and bound → manager granted → ready. Lost responses or failures can leave a delegated session or a granted role; they must be inspected with `observe`/`supervisors`, never automatically retried or repaired by another handback. A changed generation or revoked capability stops the operation. The implementation does not attempt an unsafe rollback that could overwrite a newer human transfer.

The saved native provider metadata check restricts this conversational activation to Codex. It is a consistency check inside the existing trusted same-user boundary, not a malicious-shell sandbox. Existing manager MCP supports other providers, so assignments must explicitly require Codex-only workers while Claude is deferred; no claim of a controller-wide provider firewall is made. The test assignment is bounded to two Codex workers. No existing Claude session is run or resumed.

`supervisors` reports journal relationships, role allowance and saved worker events with session names/current saved generations. It neither inspects every live worker nor accepts an outcome. Use native observations for activity. A watch tracks one supervisor turn: an initial turn ending while workers run is not whole-group completion. Whole-group final notification and cross-host assignment remain separate work.

## Verification and rollout

Requirement maps to the conversation client's three actions and the installed `orca-work` instructions. Tests use real SQLite, RPC, event and manager components for activation, normal bound sending, concurrent requests, missing recorded capability, provider restriction, lost responses and takeover. Existing manager tests cover worker creation/assignment, quotas and native human barriers. A live operational canary should create a new Codex supervisor and two first-class workers, retain their identities through a revision, inspect actual outputs and return the test organization to human ownership. This is operational evidence, not independent ADW acceptance.

Ship only the immutable client/skill and its owned watcher profile using the existing manifest/profile-checked installer. Preserve queue, journal, original sessions and all held tasks. No native daemon restart, schema migration, Book mutation, external publication or permission automation is introduced. Restore the preceding release/profile/skill on rollout failure. Independent Claude lanes and broader R3 verification remain pending; existing user authorization permits the working preview, not fabricated review evidence.

## Latest supervisor turn

Live coordination exposed that worker events advance the supervisor's native last prompt. The existing receipt-specific result deliberately refuses a superseded current-turn identity. `supervisor-result` therefore reads the latest exact receipt of an active manager at the bound generation through the existing capability-scoped `result` RPC. It never weakens the controller's identity/boot/task/cursor checks, reads historical arbitrary receipts or claims to acknowledge an earlier ingress assignment. A changing native turn fails the read and requires a fresh observation. Tests establish that the original result still refuses after a later event, the explicit latest result names that later receipt and takeover revokes access. Whole-group acceptance and completion notification remain separate.
