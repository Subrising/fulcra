# AIN89: fixed-host operational visibility

The phone and Discord entry points need the same answer to “what is actually running?” The controller journal alone records ownership, not live activity; native closed sessions retain history. Add a read-only `hosts` action to the existing conversation client.

## Decision and boundaries

Reuse the installed native SDK and existing Mini activation guard / Book runtime pins. Query only the two configured hosts, concurrently, over local IPC-backed WebSocket and existing SSH. Run the Book probe on Book so its native credential stays there. The probe calls only `agents.list`; no provider preflight, resume, send, delegation or configuration change occurs. Return selected metadata from Fulcra task roots, not transcript bodies. Join Mini ownership by exact native ID and cwd. Book remains observation-only.

An alternative was to report only controller records, which cannot answer native activity. A general remote orchestration service would expand authority and deployment scope unnecessarily. This slice deliberately excludes cross-host assignment, model quotas and resource reservation. OS free memory and load are point-in-time observations, not a worker concurrency recommendation.

## Failure and state model

Each host independently becomes observed or unavailable. Unavailable has null counts, never zero. Ten pages of 100 entries, repeated-cursor and duplicate-session checks bound directory reads. A 35-second remote watchdog and 45-second local subprocess deadline bound hangs; stdout/stderr have a 1 MiB cap. Arbitrary hosts are rejected before execution. Exceptions are replaced with a fixed diagnostic so credentials or native stderr cannot escape. A failed page invalidates that host's entire snapshot. Snapshots are not transactionally simultaneous and do not grant control; observe again before acting.

## Delivery and verification

Requirement maps to `hosts.mjs`, the `hosts` action, and the installed OpenClaw skill. Unit/fault tests cover projection, pagination, loops, unavailable hosts, unknown ownership and fixed destinations. Real probes compare session identity, last user message timestamps and controller ownership before and after installation. No worker prompt is needed. The installer verifies the old manifest/profile, changes only its owned watcher profile and immutable client/skill pointers, then requires a fresh service heartbeat. It retains the SQLite watch queue. Existing installer rollback restores prior profile/client/skill on failure. No migration is required.

Operational budget: at most two short-lived Node probes and one SSH process per request, 45-second deadline, 1 MiB process output; callers should request snapshots when needed, not poll with a model. A failure is returned directly to the requesting conversation. Existing watchers retain their heartbeat/attention reporting. Previous release stays available for rollback. Independent Claude challenge/review and R3 approval remain deferred; this is a working preview, not a completed ADW release.
