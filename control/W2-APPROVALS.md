# W2: automatic tools and visible permission waits

Under a host-reported Claude auto or Codex full-access mode, Fulcra accepts ordinary
correlated tool permissions (including MCP, task communication, file writes and
commands) without asking the owner. Explicit other modes keep their existing policy.
Questions still require answers: they are not tool grants.

The controller, local native guard and remote receiver share the classifier.
The host must report its actual current mode; a saved default or tool-supplied
mode cannot authorize this path. The small product companion change exposes that
fact to the trusted permission hook. Old hosts safely retain the old scope.

## Actions that still escalate

1. Credential and Keychain access: credential/keychain/secret/password/token tool
   operations, known credential paths (including symlink targets), Keychain CLI
   operations and credential-returning CLI/environment reads. Reason: these can
   expose or change private authentication data.
2. Destructive shared-branch git: forced/deleting/mirroring pushes or history
   rewrite/delete operations targeting main, master, release/* or integration.
   Local history changes inspect the current branch. An unresolved destructive
   destination also escalates; an explicit task-branch destination does not.
   Reason: these can rewrite or delete other people's work.
3. Publishing/releases: publishing/deployment tool operations, package/container
   publication, release/tag publication and mutating GitHub release endpoints.
   Reason: these make work available outside the task.

Refusal reasons are fixed plain text and do not echo tool arguments.

## Boundaries

This governs permission requests Fulcra receives. It is not provider-level tool
interception, and cannot infer hidden effects of arbitrary scripts, external
programs or opaque MCP servers. Provider operations that do not request a
permission do not pass through this layer. Existing private-host deny rules stay
in force.

Existing delegation, routine-grant revocation, parent ownership, task authority,
native session identity, input generation, exact request/response binding,
one-shot admission and uncertain-response reconciliation remain required.
No broad authority is granted by request metadata. Ordinary tool completion is
verified by its correlated timeline result; a generic MCP result is not falsely
reported as a verified file-content hash. Retention/capacity and unavailable
identity remain fail-closed operational conditions.

Sessions shows Needs you whenever permission requests are pending, including the
live host overlay and app-link-only rows; such a session does not count as Working.
Today places its pending permission in Needs you with a link to the session.

## Verification

Scratch sessions only, scripted provider/host fixtures, no real accounts, Keychain,
live daemon, configuration or provider defaults. W3 retains default-mode ownership.

A correlated ordinary tool result that reports failure is recorded as tool-failed;
a test failure does not revoke automatic authority or turn into an approval ask.
Identity loss and an unconfirmed dispatch remain distinct operational failures.

Focused verification: 131 controller/receiver/policy/staging tests, 32 UI-model
tests, and 4 product mode-fact tests pass (167 total). Changed-file lint and
organization typecheck pass. No live acceptance is claimed.

Actual source-host tests and product typechecks remain integration gates: the
available dependency cache has older TTLCache, p-limit and ACP APIs than this
product source requires. Resource admission refused the host build and the final
product typecheck retry. One source-host projection test is excluded from the
focused controller run; the added real-host tests await aligned dependencies.
The broader book-control fixture also fails creation unchanged on the base.
