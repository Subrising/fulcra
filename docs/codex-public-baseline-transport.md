# Host public baseline text transport

This binding supplies host-selected **public text**, not a Codex profile/config/skills
migration or a native file-load receipt. It is independent of the session's
credential `CODEX_HOME`. Native input permissions, account selection, history,
project/cwd lookup and native instruction roots remain their existing paths.

At an interactive non-internal Codex launch, AgentManager reads only the kernel
user's fixed public files:

- `.config/fulcra/baseline/SHARED.md`
- `.config/fulcra/baseline/providers/codex.md`
- `.codex/AGENTS.override.md`, if present; otherwise `.codex/AGENTS.md`

Caller environment, runtime profile, account label and request config cannot
select the root or another filename. No account home/config/auth/skills is read,
written, linked or replaced. The common-file presence is the public baseline
opt-in; absent on a canonical unconfigured host means no new transport. A
configured but missing/unsafe file refuses with `HOST_PUBLIC_BASELINE_REFUSED`.
Platforms without POSIX ownership proof do not add this transport.

The reader requires regular singly-linked files and safe, owned canonical path
components; symlinks/aliases and group/other writable components are refused.
Files must belong to the host user or root, contain nonempty UTF-8 without NUL,
and fit 64 KiB each / 128 KiB total. Descriptor/path identity, owner/mode,
size/mtime/ctime and final whole-set checks bind the actual read. An unsafe
present override is refused, not silently replaced by AGENTS.md. Root must hold
inputs for any later activation comparison; file changes after capture do not
refresh a running session automatically.

Runtime-only `AgentLaunchContext.publicBaseline` carries independently copied
text, per-component SHA256 and a digest over ordered component IDs/hashes. Codex
captures launch env and baseline before asynchronous capability work, and owns
an independent config/text snapshot. Existing env/profile/home resolution is
retained; native account scope is not inferred from a null pooled assignment.

The public text is explicitly scoped as default guidance and prepended to the
existing `systemPrompt`, then daemon append, whose text/order remain unchanged.
It participates in the existing ordinary thread/start, thread/resume and
turn/start developerInstructions composition so an ordinary turn does not
replace it with the old instruction suffix. Existing project/cwd/native paths,
base instructions, collaboration-mode settings and provider/security options
are not rewritten. This describes source composition; it is not proof of an
installed native runtime's effective instruction precedence or model behavior.
Native consumer verification is still required.

History and internal helpers receive no public baseline. Native queued
preparation retains its existing readonly loaded-thread check and existing
instruction text: it adds no host baseline, does not resume/unarchive to inject
one, and creates no new transport receipt. All account/model/tier/native
session/client/permission/source/cancel/close/admission/final-write fences remain
in their existing code paths. There is no timer or extra model turn to check
this binding.

## Digest-only readback

The existing live `runtimeInfo.extra.hostPublicBaselineTransport` object is:

```
{ version: 1,
  state: "INJECTED" | "SUBMITTED",
  baselineSha256: <SHA256 of ordered component IDs/hashes>,
  developerInstructionsSha256: <SHA256 of exact composed request text>,
  files: [{id: "common"|"codex"|"router", sha256: <SHA256>}] }
```

`INJECTED` means locally composed into prepared developerInstructions. It does
**not** mean the native request was sent. `SUBMITTED` requires a successful
existing correlated native RPC with that exact text and current client/thread.
A loaded-thread skip remains INJECTED, never fabricated SUBMITTED. A queued
operation does not refresh/acknowledge this receipt; a previous receipt remains
only a record of its previous transport, not current effective model context.

The private SDK event updates the live Manager metadata only for the original
live agent/session; it is not a new public command, action capability, model
change, permission/run-state update or public stream event. Duplicate identical
submission status does not produce additional updates. Receipt values contain
no text, paths, environment, account credential or selected-profile claims.
They are independently cloned for callers. They are omitted from persistence,
closed snapshots and stored projection, preventing boot/old-cache replay.

Neither state proves native AGENTS/config/skills files were loaded, a model
consumed the text, hooks ran, a selected profile/account is active, or installed
adoption succeeded. The four effective-activation proofs remain OPEN. Root
selects genuine existing consumers, holds inputs and uses legitimate lifecycle
boundaries; global-file ownership stays with retained75. Closed smoke fixtures
and unbound/null-account metadata cannot substitute for actual consumers.
