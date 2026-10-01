# Native memory investigation — 11 September 2026

Scope: read-only diagnosis through supported OpenClaw commands and profiling only this task's own processes. No live database was queried directly, no Gateway restarted, and no shared-memory implementation changed.

## Verified timeout-cleanup defect

The existing `shm-core.mjs` wrapper spawns `openclaw`, sets a timer, sends SIGKILL to that one child PID, then resolves on the child's `close` event. OpenClaw can respawn its launcher for compile-cache and startup-environment handling. Killing the outer launcher leaves its descendant alive with inherited output pipes; `close` waits for those pipes to close.

An instrumented native query created launcher PID 60563 and `openclaw-memory` PID 60573. The timer killed 60563 after 20 seconds. At 32 seconds, 60573 still existed with parent PID 1. This task subsequently stopped that exact owned process with SIGTERM and verified its absence. The performance samples and process record are in `runtime/search-profile.sample.txt`, `runtime/search-worker.sample.txt` and `runtime/search-profile-process.json`.

Setting only `NODE_DISABLE_COMPILE_CACHE=1` did not solve it: the inner startup-environment respawn still occurred. The wrapper's 10-second deadline returned after 47,138 ms after this task stopped the remaining owned child PID 61286. Retain that failed attempt in `runtime/search-no-respawn.json`.

With both `OPENCLAW_NO_RESPAWN=1` and `NODE_DISABLE_COMPILE_CACHE=1`, the existing wrapper's 10-second deadline returned after 10,031 ms. A process inventory immediately afterward contained no `openclaw-memory` process. Evidence: `runtime/search-in-process.json` and the tool transcript. This is a real bounded failure, not search success.

`OPENCLAW_NO_RESPAWN=1` is documented in the installed OpenClaw `docs/vps.md` as keeping process tracking simple. Its implementation is in `dist/entry.js` startup-environment respawn handling. The separate compile-cache launcher lives in `openclaw.mjs`, so both paths matter in this host environment. Apply any future environment overrides only to the owned memory-tool subprocess, after the integration review; do not change Gateway startup globally. Revalidate required startup environment, certificates and provider behavior if the embedding endpoint changes.

## Search delay remains unresolved

The sampled search child's main thread was inside `node::sqlite::StatementSync::All`, SQLite page reads and `pread`. The sample identifies database work, not the responsible SQL statement or a proven schema/lock defect. Do not equate slow-transaction warnings with a proven lock holder.

Installed source shows why status and search can differ: status opens the memory database read-only; CLI search borrows the canonical agent database and performs schema initialization before searching. Direct embedding service performance was 142 ms for the tested query, while exact memory reads and status succeeded. These observations narrow the next investigation; none proves the complete cause.

Next substantive search work requires isolating the expensive initialization/query path through the native implementation and assigning any fix to an explicit owner. Do not repeatedly lengthen deadlines, disable disclosure checks, edit the live database, or build an alternate memory store to hide this failure.

## Integration consequence

The exact-read MCP route and MacBook SSH transport are usable at the protocol level. Cross-provider model consumption, fresh indexed search, correction retrieval, durable writes and policy enforcement remain open. The next live trial is waiting for Claude sign-in and ADW's independent challenge, as recorded in LIVE-STATUS.md.
