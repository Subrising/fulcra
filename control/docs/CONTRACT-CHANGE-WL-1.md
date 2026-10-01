# WL additive lifecycle interface (for orchestrator ratification)

The frozen v1.16 contracts have no worktree lifecycle API. This requested feature adds
operator-authenticated `worktree-lifecycle-preview`, `worktree-lifecycle-apply` and
`worktree-lifecycle-retention`, with typed plugin equivalents `organization.cleanup-*`.
Shapes are in `orca-organization/shared/worktree-lifecycle.ts`. No existing shape changes.

Preview returns a 15-minute server-side plan token; apply accepts only that token and
`confirm: true`, never caller-supplied paths. Plans are single-use; restart invalidates them.
This intentionally uses a short-lived plan token in place of entity revision/messageId.
The public RPC returns the original in-memory result on retry; an unknown plan after restart is refused rather than replayed. The retention adapter writes a single
validated scalar atomically; concurrent saves are last-writer-wins in this initial seam.
Request ratification of those two exceptions to §1 mutable-entity conventions.

`cc_job_cleanup` is append-only audit with intent/complete/needs-attention state, bounded
at 10,000 jobs; at the cap deletion stops before touching files. Archive UI and 90% Inbox
notification remain integration follow-ups. V2 consumes `worktreeLifecycle.retentionDays`
in its config through the injected settings adapter; the current base uses a sidecar.
Only WL and V2 are affected. Nothing here changes provider settings, grants or holds.

Large scans use an operation envelope `{pending, operationId, value?}`. Preview starts
with `{}` and polls with `{operationId}`. Apply retries the same plan token and returns
the original result while that operation remains in memory, avoiding ambiguous socket
timeouts. Restart still refuses a consumed/unknown plan rather than repeating deletion.
Preview kept-file names are capped at 100 per job for the bounded controller response;
the internal preservation list remains complete. Scans stop safely at 100,000 entries
per job; a larger job is marked for attention rather than consuming unbounded memory.
