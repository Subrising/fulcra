# Host-link notices and worker creation

Status: source implementation. Live Mac-to-Mac and Mac-to-PC acceptance remains open.

FU-105 — Cross-host worker notices: Fulcra sends `role:main-assistant` notices to its configured host when no local chat holds that role.
FU-76 — Cross-host spawn creates a worker through a directed link and a destination-owned profile.
FU-170 — Native creation returns retained finish, error, and permission notices to the calling lead.

The approved review separates reporting lines from creation ancestry (`PASEO-VS-FULCRA-2026-10-12.md:38`).
Its delivery and suppression constraints appear at lines 350 and 369–372.
The retired Book receiver stays retired. These endpoints do not use SSH receivers or daemon passwords.

## Authority

The owner provisions `host-links.json` in each daemon's private home.
Both daemons must have daemon authentication enabled.
A directed link has one random `hlink1.` credential, a fixed destination identity, and explicit operations.
Use HTTPS for remote transport. Literal loopback HTTP supports isolated tests.
Redirects, URL credentials, query strings, and alternate endpoint paths are refused.

Each source lead has a separate `hchat1.` credential.
The source derives the lead identity and permission mode from that credential and its saved chat.
Caller fields cannot claim another lead, select an account, add environment variables, or grant a role.
Role labels alone grant no link authority.
The destination permits named leads, workload classes, workspace identifiers, and worker profiles.

A spawn grant permits provider work under the destination daemon's OS account.
Workspace identifiers select working directories. They do not create filesystem sandboxes.
Provider permission modes control the worker's tool access.
Chat tokens do not isolate arbitrary code that runs under the daemon owner's account.
A compromised source host can claim the identities and source modes its link permits.
This boundary does not protect against a compromised owner or destination daemon.

The source lead receives a separate worker `hworker1.` credential.
It permits prompts and inspection for that worker only.
It cannot create workers, select another chat, change modes, or control the daemon.
Link, chat, and worker credentials are refused by general HTTP, WebSocket, and MCP authentication.
The daemon keeps link credentials out of worker configuration and prompts.

Grant changes, revocation, and expiry block later admissions and old worker credentials.
They do not prove that earlier provider work stopped.
The provider creation fence checks the prepared model, mode, provider, directory, and current grant after plugin preparation.
Queued worker prompts recheck the grant, reporting line, and permission mode before provider input.

## Configuration

Use private files with mode `0600` on POSIX systems.
Host-link operations refuse Windows because Node cannot flush directory entries there.
They require a durable journal before provider input or receipt acknowledgement.
Generate each credential from 32 random bytes encoded with base64url, after its prefix.
Keep credentials out of shell arguments and terminal output.

`version` is `1`. `machine` is `mac` or `pc`.
The file contains `chats`, `outgoing`, `incoming`, and `routes`.
Every grant has an `expiresAt` Unix timestamp in milliseconds and a `revoked` boolean.
An empty operation list grants nothing.

| Section    | Owner-selected fields                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `chats`    | Local `agentId`, `token`, `operations`, and permitted `links`                                                               |
| `outgoing` | Link `id`, destination `serverId`, base `url`, `token`, destination `machine`, and automatic `reporters`                    |
| `incoming` | Link `id`, source `serverId`, `token`, named `leads`, `operations`, `workloads`, `workspaces`, `profiles`, and `maxWorkers` |
| `routes`   | Link IDs for `standard`, `heavy`, `gpu`, and `mainAssistant`                                                                |

`operations` permits `spawn`, `notice`, or both.
A notice-only incoming link needs empty `workloads`, `workspaces`, and `profiles`, plus `maxWorkers: 0`.
The outgoing and matching incoming entry use the same link credential.
Each local chat and link identity needs a different credential.

GPU and heavy workloads require the configured PC link at both ends.
A missing route or offline destination fails. It never substitutes a local worker.
The PC label is an owner-selected machine role; it is not hardware discovery.

An incoming `workspaces` map binds a short identifier to a canonical absolute directory.
The receiver refuses changed paths and directory symlinks.
A `profiles` map binds a short identifier to this shape:

```json
{
  "provider": "codex",
  "model": "MODEL_ID",
  "modeId": "auto-review",
  "parents": ["codex:auto-review"]
}
```

Remote creation supports the known Claude and Codex permission modes.
Unknown modes refuse creation.
A restricted lead must use the same provider and permission mode.
An automatic lead still needs an explicitly permitted source mode in `parents`.
Use the provider's canonical model ID; a plugin cannot replace it during creation.

`maxWorkers` counts retained creations, including pending requests.
The journals also cap retained requests at 1,000 entries and 8 MiB.
Keep receipts through reconciliation. Do not delete a pending receipt to retry creation.

## Use from a lead

Prepare a private JSON request with one retained UUID:

```json
{
  "kind": "spawn",
  "messageId": "11111111-1111-4111-8111-111111111111",
  "workload": "standard",
  "workspace": "job",
  "profile": "worker",
  "title": "Worker",
  "prompt": "Complete the assigned task and report the checks."
}
```

```sh
fulcra host-link request request.json --endpoint https://source.example.test \
  --credential-file chat.secret --receipt-file worker-receipt.json
fulcra host-link inspect --receipt-file worker-receipt.json
fulcra host-link prompt --receipt-file worker-receipt.json \
  --message-id 22222222-2222-4222-8222-222222222222 --prompt-file follow-up.txt
```

The CLI stores the worker credential in the private receipt file. It does not print that credential.
The receiver flushes the temporary receipt file, renames it, and flushes its parent directory before provider creation.
A flush failure stops the operation. Retained retries repeat the flush before acknowledgement.
An identical retry returns the retained receipt. A changed body or destination under that UUID fails.
`created` means the initial prompt reached the provider. It does not mean the task finished.
`pending` after a crash requires destination-owner reconciliation against the retained worker ID.
It does not start another worker.

An explicit upward notice uses `kind: "notice"`, `messageId`, and `text` through the same source command.
The source requires the chat's saved reporting line to be `role:main-assistant`.
The destination resolves that role, uses its held-send queue, and checks the holder again before input.
A queued notice follows a role move without entering the previous holder's running turn.
Missing or ambiguous holders refuse delivery.

Automatic report-up keeps its existing enablement and finish-notification ownership rules.
A turn that a notice started sends no further notice.
Lead success notices remain suppressed; failed lead turns can cross the link.
Retained remote children also count for success suppression.
A notice cannot claim role authority through its text.

## Native worker creation

Agent-scoped `create_agent` accepts an optional destination `serverId`.
Omit it, or select the local server ID, to keep local creation.
For a remote host, supply `hostLink` with `messageId`, `workload`, `workspace`, and `profile`.
Use one retained UUID for retries. Workspace and profile identifiers name destination grants, not source paths or accounts.
The provider, explicit model, and explicit mode must match the destination profile.
Local workspace placement, labels, features, and detached creation are refused for remote requests.

The source uses the bound caller's existing chat grant and one directed link to that server ID.
Unknown hosts, ambiguous links, missing grants, and inactive grants refuse creation.
The tool returns host, worker, request, and receipt state. It does not return credentials.
The private source outbox keeps the worker receipt for owner control through the host-link interface.
A pending or uncertain result requires receipt reconciliation before another creation.

Remote `notifyOnFinish` defaults to `true`. Set it to `false` to disable return notices.
The destination retains permission checkpoints and the first finish or error under the worker receipt.
Permission notices use the same grace period as local alerts. Resolved requests do not wake the lead.
Held permission notices recheck the remote request before provider input.
The home daemon reads these events with its retained worker credential through the same directed link.
No reverse link, callback URL, daemon password, or worker-visible link credential is required.
Notices name the original calling chat, rather than the current main assistant.

The home daemon commits a receipt before notification input. Stable event IDs suppress duplicate network replies and repeated worker events.
Queued notices survive restart. They wait for the lead's active turn and keep daemon input provenance.
Notice recovery starts after session revival. A running revived worker keeps its subscription.
Changed grants, archived callers, and changed provider sessions refuse delivery. Notices never restore an archived lead.

Healthy subscriptions check for retained events every ten seconds. Network failures use eight persisted attempts with delays capped at sixty seconds.
The home daemon reads at most four workers concurrently. It has no timer when no eligible work remains.
After retry exhaustion, repeat the same native creation request with its original UUID to renew the retry budget.
This reuses the worker and notice receipts. It never starts a replacement worker or replays a delivered notice.

Each worker keeps up to 127 permission checkpoints and one terminal notice within the existing journal storage limits.
Do not delete receipt files to clear capacity or retry a request.
The private source outbox retains notice text and delivery state for owner inspection.
A failed or interrupted provider handoff has state `uncertain`. It requires reconciliation; the daemon never replays it automatically.
This preserves the native input safety rule when provider acceptance cannot be proved after a crash.

## Verification boundary

Run focused tests through the existing test scripts and queue.
The source tests use real HTTP, private files, durable receipts, and isolated agent runtimes with test providers.
They cover admission, initial input, credential refusal, permission restrictions, retries, response loss, and role moves during held delivery.
Return-notice cases cover finish, error, permission, restart, link recovery, duplicate suppression, and the real runtime-to-provider handoff.
They do not prove installed Mac-to-Mac or Mac-to-PC provider execution.
The merge owner must obtain the required fresh security review before integration.
Do not install or restart live daemons to run this batch's tests.
