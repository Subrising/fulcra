> **Retired in 0.2.7.** The SSH transport (`transport.mjs`, `receiver-cli.mjs`) is removed. The controller no longer starts remote receivers and ignores `book-transport.json`. The text below is history.

# Book operator task control — AIN99

## Provider-bound source preparation — AIN121

The source supports Claude and Codex worker creation, native identity checks, ordinary conversation and Mini-supervised saved Book workers. Provider-omitted receiver requests remain legacy Codex with unchanged retry bodies. A retained creation identity cannot change provider. Native creation requires the configured family policy and explicit Claude model; it does not substitute a different account or model. Source capability is separate from installed host-runtime enrollment and live acceptance.

`resume-group` can rebind an existing Mini supervisor and its complete saved Mini/Book team. Remote receiver grants are prepared while every controller session remains human-owned. Instructions stay disabled until all acknowledgements and native identities are revalidated; one controller transaction then activates the selected generations, relationships and private conversation grant. No session is recreated, allowance reset, previous assignment replayed or old work accepted. Book supervisors, remote automated permission grants and cross-host leadership transfer still require separate implementation.

A durable `remote_resume_members` record accompanies each prepared Book route. Lost replies, failed token publication and controller restart revoke these grants before final refusal. Offline revocation leaves the original receipt unresolved; recover that same receipt, preserving newer human control and acknowledged newer generations. A partial preparation must never be rolled back by replacing the journal with a backup. Earlier source lacks this recovery logic: drain every preparation before a downgrade. Installed service promotion and native cross-host team-resume acceptance remain separate release requirements.

## Original Codex delivery record

Source base: `e46e37ab99161e87c9b676216ade65f89f04b482`, reconstructed native `source-cache` under the AIN99 task directory. No iCloud placeholder source was used. This slice supports one operator-controlled NEW Book Codex session through ordinary Fulcra conversation `create(host:macbook)`, `delegate`, `send`, `observe`, `result`, `wait`, and `takeover`. It creates no teams and rejects Book parent/supervisor, automated permission, leadership and group-resumption grants. Discovery does not enroll the three existing Book sessions.

## Authority and linearization

Mini's existing Controller, task authority, ingress, grants, delivery journal and task instruction allowance remain authoritative. `HostNative` adds only durable routing/transport state in that same current journal: random central session UUID, creation receipt, fixed host, native agent UUID, exact cwd, generation and phase. No journal copies, second budget ledger, arbitrary remote `agent.run`, or remote parent authority exist.

The fixed SSH command invokes one authenticated subordinate receiver request. A private key signs canonical requests and responses; each reply binds its request digest. Receiver identity is durably pinned to ONE controller UUID and host. Creation retains its route before native creation and retries only the same native idempotency key. Session identity includes host, route, task, owner, cwd, provider and pinned native session UUID. Old saved sessions are never adopted.

Mini charges an instruction once at common admission, before transport. Book durably prepares its exact message/generation/body and calls native `send` at most once. Lost responses or receiver process death never replay a send. Recovery uses the exact native receipt, text fingerprint, session and consumed receiver intent. Results use the retained pre-send timeline cursor and revalidate native identity, boot, human sequence and exact prompt across the read. Capacity is bounded at 1000 routes/sessions/intents; reaching it fails closed and requires deliberate future retention work, not journal deletion.

The Book daemon owns the boot and monotonic native human-input sequence. Earlier native hooks validate; the final hook, immediately before `session.startTurn`, atomically consumes the receiver intent. Revoke and final admission serialize on the same live receiver SQLite transaction. Human native input advances sequence independently of journal availability. Boot changes invalidate outstanding grants. The final hook requires exact generation/binding/body, unused intent, idle native state and no pending permissions.

Operator takeover first revokes Mini capability and records `revoking`, then sends remote revocation. Only a matching durable receiver acknowledgement produces `complete:true`. While unresolved, new delegation and automation refuse; list/observe expose phase/error. Existing controller watchdog retries only revocation, never instructions. Revoke works with the provider down. If final admission won the transaction race, already admitted work may continue after acknowledgement; `interruptionConfirmed:false` and admitted IDs state this explicitly. Root must interrupt/reconcile that work through the owned native human path as needed. This is not distributed instantaneous cancellation.

Trust boundary: operator/SSH/receiver/daemon run as the existing trusted OS owner. Private mode-0600 files and pinned hosts do not defend against an already compromised same-UID administrator. Existing Book Codex sandbox/network/provider policies and memory proxy are reused; no receiver secret or controller capability is injected into worker tools. HMAC is scoped transport authentication, not a substitute for host administration security.

## Source map and tests

- `../control/host-native.mjs`, controller/server/RPC: sole-controller routing, transition recovery and acknowledgement.
- `receiver.mjs`, `journal.mjs`, `protocol.mjs`, `transport.mjs`, `receiver-cli.mjs`: subordinate admission and exact durable receipt routing.
- `receiver-guard.mjs`, `native.mjs`, `stage.mjs`: existing Book runtime/API adapter and staged native fencing.
- `../../orca-conversation/{client,hosts}.mjs`, `SKILL.md`: ordinary operator route and exact discovery overlay.
- `book-control.test.mjs`: real SQLite, real shared receipt/result adapters, mocked provider only; both revocation races, two real SIGKILL boundaries, response loss, reopen, human takeover, shared allowance, authentication and foreign/grant rejection.
- `stage.test.mjs`: stopped-install preparation, preserved before bytes, pinned bundle, drift refusal. Actual Book module anchors were separately applied locally and all four resulting modules passed `node --check`.

Run locally (no native models or Book connection):

```sh
umask 022
TMPDIR=/private/tmp /opt/homebrew/opt/node@24/bin/node --test --test-concurrency=2 --test-timeout=60000 src/control/*.test.mjs orca-conversation/*.test.mjs src/book/*.test.mjs
```

The additional legacy `orca-command/src/*.test.mjs` sweep has five pre-existing failures also reproduced on the exact e46e37a baseline (old fixture observations lack the required native fence, and the cold-registration fixture cannot resolve the uncached `openclaw` package). Those are retained as baseline failures, not counted as passing.

The worked examples below use placeholders rather than real values, so this file
names no host, login or secret location. Substitute your own:

| Placeholder                    | What it is                                                       |
| ------------------------------ | ---------------------------------------------------------------- |
| `BOOK_SSH_TARGET`              | the `user@host` the Mini controller reaches the Book receiver on |
| `MINI_TRANSPORT_KEYFILE`       | path on Mini to the private transport key file                   |
| `BOOK_WORK_ROOT`               | the Book-side owned-work directory for this control bundle       |
| `BOOK_PASEO_INSTALL`           | the Book-side Paseo installation                                 |
| `BOOK_NODE`                    | the Book's node binary                                           |
| `MINI_CONVERSATION_CLIENT`     | path on Mini to the conversation client entry                    |
| `CONTROLLER_UUID`, `TASK_UUID` | the controller identity and the task being used                  |

The transport verifies the profile against its own expected target before
connecting, so a wrong substitution refuses rather than reaching an unintended
host.

Read-only Book source provenance, 2026-09-14, under `BOOK_PASEO_INSTALL/node_modules/@getpaseo/server/dist/server/server/`:

| Module                     | SHA-256 before |
| -------------------------- | -------------- |
| session.js                 | <SHA256>       |
| agent/lifecycle-command.js | <SHA256>       |
| agent/agent-manager.js     | <SHA256>       |
| agent/agent-prompt.js      | <SHA256>       |

## Root installation only — not executed by this implementation session

Prerequisites: independent review/ADW disposition (including the actual over-400-line blocker), reviewed source transfer, Node 24, existing SSH known-host identity, private transport key, existing owned runtime pins, current journal backups through SQLite backup, recorded saved session IDs/modes/grants and provider/service identities. Preserve all existing Mini rows, Book three saved sessions, parked compatibility/recovery owners, `/path/to/volume/openclaw/projects/orca-macbook-20260912`, provider settings, Gateway and Radius holds. No journal snapshot is used as runtime authority or restored for rollback.

1. Root copies this exact reviewed source to a NEW Book directory, e.g. `BOOK_WORK_ROOT/source`. Keep stage outside the existing Paseo installation. Create private state/tasks directories and generate ONE 32-byte base64url key with no newline; securely provision the same key into a separate private Mini transport directory. Generate one stable controller UUID and retain it on both sides. Do not rotate it on restart or clone receiver state to another host.

   Book receiver input profile (absolute paths, mode 0600; replace `CONTROLLER_UUID`):

```json
{
  "controller": "CONTROLLER_UUID",
  "runtimeSource": "BOOK_PASEO_INSTALL/source",
  "journal": "BOOK_WORK_ROOT/state/receiver.sqlite",
  "tasks": "BOOK_WORK_ROOT/tasks",
  "keyFile": "BOOK_WORK_ROOT/state/transport.secret"
}
```

2. On Book, root stages from the reviewed copy. Staging reads/verifies the existing dependency tree and produces before/after native bytes, immutable receiver bundle, guard release digest, runtime before/after profiles and manifest. It does not edit the provider or run a model:

```sh
BOOK_NODE BOOK_WORK_ROOT/source/src/book/stage.mjs BOOK_WORK_ROOT/receiver-input.json BOOK_WORK_ROOT/staged
```

3. Review the staged manifest against the above actual module hashes and full existing runtime tree. Root establishes owned maintenance: all affected native work idle/human, stop ONLY the owned Book provider/supervisor, verify no listener/PID. Apply refuses a live listener/supervisor, unknown tree, changed staged/current bytes. Root then restarts through the existing owned runtime, verifies its existing pins and the NEW `receiverRelease`/boot in native observations. Apply changes only four native modules plus the existing runtime's `installedTree`; preserves other provider config and sessions:

```sh
BOOK_NODE BOOK_WORK_ROOT/source/src/book/stage.mjs apply BOOK_WORK_ROOT/staged after
```

4. Root integrates this commit with the reviewed/current Mini source (including the installed input-sequence controller), publishes its ordinary immutable controller/conversation bundles through the existing deployment owner, and pins them in the existing owned launcher. Include all `src/book` production modules and `src/control/host-native.mjs` in the controller bundle. The conversation bundle must include the updated client, hosts and skill; no Gateway edit. Add only `ORCA_BOOK_TRANSPORT_PROFILE` to the owned controller environment, pointing to a private Mini profile:

```json
{
  "controller": "CONTROLLER_UUID",
  "host": "macbook",
  "sshTarget": "BOOK_SSH_TARGET",
  "keyFile": "MINI_TRANSPORT_KEYFILE",
  "command": [
    "BOOK_NODE",
    "BOOK_WORK_ROOT/staged/bundle/src/book/receiver-cli.mjs",
    "BOOK_WORK_ROOT/staged/receiver-profile.json"
  ]
}
```

Mini startup creates only `host_routes` in its CURRENT journal; Book receiver creates its subordinate tables on first request. Existing tables/rows are untouched. Verify Mini can still observe retained local human sessions and hosts keeps the old Book three observation-only. Missing transport configuration fails remote operations without local fallback.

5. Use an authorized isolated Paperclip canary task with available instruction allowance and no concurrent assignments. This executable path creates exactly one NEW Book session, deduplicates creation, delegates, sends one artifact instruction, waits/reads the exact result, obtains acknowledged takeover, and verifies stale send refusal with no second charge. No live canary was run here:

```sh
ORCA_CONVERSATION_CLIENT=MINI_CONVERSATION_CLIENT /opt/homebrew/opt/node@24/bin/node src/book/acceptance.mjs --live TASK_UUID
```

Root independently reads `acceptance.txt` over read-only Book SSH at the returned exact cwd and compares the returned marker. Confirm saved-session/ownership inventory, same central/native binding after Mini restart, and no duplicate canary on receipt inspection. Test an owned native-human-entry sequence change and stale refusal on this canary only. For outage validation, use an isolated transport failure at the controller transport layer: takeover must show `revoking/complete:false`, refuse automation, then reconcile to acknowledged human on restoration. Do not damage production SSH/keys or alter unrelated sessions to simulate an outage.

## Rollback and handoff

Revoke every NEW Book grant through Mini and require receiver acknowledgement; interrupt/reconcile admitted work before stopping. Root may disable Book transport only after that. Keep host routes, both current journals, receipts, task charges and saved sessions intact. Stopped Book rollback uses the SAME stage command with `apply ... before`, restoring exact prepatch modules/runtime fingerprint, never journals. If any apply was interrupted, a mixed dependency tree is an explicit reconciliation blocker: compare manifest before/after bytes and restore a complete known side under stopped ownership before startup; do not bypass tree validation or replay requests. Do not roll Mini back to a controller that loses current allowance or human-sequence enforcement. Deferred Claude/independent review and live deployment acceptance remain root's responsibility; this source handoff is not release approval.
