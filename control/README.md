# Fulcra: an AI working organization

Implementation in progress · README last revised 19 September 2026 · Australia/Brisbane

**Goal:** give the owner an outcome-driven organization of persistent, independently resumable AI sessions across providers and machines. the owner can lead through Discord/OpenClaw, direct Claude or Codex, or a shared visual application, wearing an EM, CTO, CPO, strategy, marketing or other hat. The system explains consequential alternatives and impacts before work, follows a proportionate ADW process, and connects reviewed decisions to delivered and verified results.

**Product direction:** Fulcra is a standalone native product built on a maintained Paseo fork. The existing Fulcra sidebar extension is an implementation boundary, not the intended product identity. Preserve upstream package names and history where useful; keep Fulcra-specific app identity, entry points and coordination changes explicit so upstream merges remain reviewable.

**First access routes:** Discord/OpenClaw is the phone conversation entry; the Fulcra app is the visual entry on iPhone and desktop, alongside direct Claude/Codex access. The main view explains the goal, current result, next step, recorded decision and readable outputs. Execution receipts, hashes and trace details are optional. A quiet or completed conversation never establishes delivery acceptance.

## Setup

**What this is.** A control runtime that creates, governs and resumes persistent
AI sessions across providers. It is a set of Node modules plus an operator RPC
surface over a Unix socket; it is not an application you install.

**Requirements.** Node 24 (developed against v24.21.0 — `node:sqlite`'s
`DatabaseSync` and the test runner's object-form `skip` are both required).
macOS today: several paths and the Book transport assume it. There is **no
`package.json` and no install step** — the runtime declares no dependencies of
its own, and the Paseo client and server are imported from the installation's
own tree.

**Running the tests.**

```sh
node --experimental-test-module-mocks --test src/control/*.test.mjs src/*.test.mjs
```

The flag is not optional: without it `native-memory-route.test.mjs` dies on
`mock.module is not a function`, which looks like a broken test and is not.

With `ORCA_MCP_TEST_NATIVE` set, a clean checkout is **fully green**. Without
it, expect one failure — `mcp-refresh-fence`, which needs that variable. Two
conditions produce more, and both explain themselves when they fire:

- `mcp-refresh-fence.test.mjs` needs `ORCA_MCP_TEST_NATIVE` pointing at a
  **pristine** — unpatched — compiled server `dist`. Twelve of its thirteen
  tests run against any dist; the thirteenth patches one and so cannot run
  against a tree that is already patched.
- If a suite aborts saying `admission-guard.mjs … is PINNED`, the working copy
  of that file has been deliberately held at older content because a live
  controller hashes it. Do not restore it in place; run guard-dependent suites
  in a detached worktree, as the message explains.

**Configuring a portable installation.** Set `ORCA_HOME` to a canonical,
owner-only directory containing a `config.json` with `version`, `daemon.port`,
`authority.companyId`, `authority.programmeId`, `providers.claude`,
`providers.codex` and `hosts`. Without `ORCA_HOME` the runtime uses this
machine's fixed paths.

What a new session spawns with — mode, thinking level and any approval prompt
list — is configured in the optional `defaults` block, or in
`$CONTROLLER_HOME/session-defaults.json` on a non-portable installation. See
[session defaults](docs/session-defaults.md) for the format, precedence and
refusals. A second document, `docs/portable-setup.md`, covers portable install
mechanics and currently lives on another branch, so whether it appears beside
this one depends on release composition — an open decision, not an omission.

## How a session is created

The control plane, drawn only from paths verified in this repository:

```
operator ──RPC over control.sock──► controller ──► native adapter ──► Paseo daemon ──► session
                                        │              │
              journal.sqlite ◄──────────┤              └─ sessionDefaults() decides mode,
              sessions, deliveries,     │                 thinking and approval options
              role_bindings, channels   │                 from settings + per-spawn override
                                        │
                     admission guard ───┘  runs inside the daemon and re-derives every
                     fence from the journal before any delegated input is admitted
```

Every creation path routes through `sessionDefaults`, and a test asserts that
structurally rather than by convention.

**Named gap:** GOAL.md asks for desktop and mobile diagrams. Those describe
product surfaces — the Fulcra app and the Discord/OpenClaw entry — which are not
in this repository and which I have not verified. A picture of them here would
be decoration, so there is none. [Architecture and
requirements](ARCHITECTURE.md) carries the responsibility diagram for the wider
system.

## Reading order

1. [Architecture and requirements](ARCHITECTURE.md) — what the organization must do, responsibility diagram, alternatives, limits.
2. [Capability and evidence matrix](CAPABILITIES.md) — documented capabilities, released-source findings, limits and unanswered questions.
3. [Implementation contract](IMPLEMENTATION.md) — the contract the controller implements.

Plans, proposals, the proof plan, research provenance, live-status snapshots and release gates live in the private `Subrising/fulcra-ops` repo, not here.

**Current implementation:** the outcome-first work brief reads a task-scoped published record and verifies a selected output before displaying it. Missing briefs stay explicit. Mini history accepts both legacy canonical and current projected pages; backward pagination follows display anchors because tool lifecycles can overlap. Book requires the matching receiver update. Standalone app packaging, default routing, installed cross-entry acceptance and independent release review remain unfinished. The canonical operating state is tracked in an internal decision record that is **not part of this repository** and will not resolve for anyone else (`shared-vault/decisions/orca-platform-operating-state-20260912.md` on the maintainer's machine); older notes below describe historical checkpoints.

## Important findings

- Paseo documents cross-provider/remote operation and explicit permission APIs. Its v0.8.0 permissions are daemon-wide; that does not establish per-session control rights. [Released permission design](https://github.com/getpaseo/paseo/blob/v0.8.0/docs/permissions.md).
- GitKraken Kepler supports non-Git folders and tasks. External sessions have limited graph detail, and arbitrary external-session control remains unproven. [Task resources](https://help.gitkraken.com/kepler/tasks-and-resources/), [graph limits](https://help.gitkraken.com/kepler/agent-graph/).
- Claude native messaging reaches other machines under specific Remote Control/authentication conditions. Its idle subscription is local and one-shot. [Claude messaging](https://code.claude.com/docs/en/cross-session-messaging).
- Archify and Radius address distinct obligations: explaining architecture changes and modeling/deploying applications. Neither a diagram validation nor a successful deployment command proves the user-facing outcome. [Archify scope](https://github.com/tt-a1i/archify/blob/v2.16.0/docs/deployment-ownership-profile-acceptance-2026-07-23.md), [Radius Canvas preview](https://edge.docs.radapp.io/integrations/github-copilot-app/canvas-extension/).

The active goal now covers completing the full vision and making memory usable throughout it. The earlier research-only assignment has advanced to an isolated implementation. Paseo 0.8.0 is installed in its own directory; its daemon has not been started. Existing repair work has not been reassigned. Radius deploy hold: released by David on 7 Oct 2026. Deploys go through Fulcra's confirm step. The full goal is incomplete.

The existing shared-memory MCP server can read a newly saved leadership record locally and through an SSH client on the MacBook, returning the same source hash; its private-note denial also passed. Native search timed out and no Claude/Codex model turn has yet used this integration. Native mini Claude admission now works, and the independent OpenClaw-owned Claude challenge has returned findings being resolved. Paseo provider admission remains to be tested.

The current OpenClaw programme owner was contacted successfully through its existing session. Direct Claude consultation was not completed: the relevant retained session is parked, and one forwarded tmux read failed. This limitation is preserved, not reported as a successful three-way test.

Working interface: the private Paseo workspace, reachable **only from the maintainer's Tailscale network** and therefore not a link anyone else can follow. Both mini providers have completed source-cited artifacts, retained their native sessions through restart, and completed an event-triggered revision/review sequence. The full goal and final ADW gate remain incomplete.
