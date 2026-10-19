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
The `fulcra.hold=done` label refuses later worker prompts.

## Configuration

Use private files with mode `0600` on POSIX systems.
Host-link operations require a durable journal before provider input or receipt acknowledgement.
On Windows, one retained PowerShell helper creates each journal file with an owner-only ACL.
It flushes the temporary file, renames it with `MoveFileExW`, then opens and flushes the destination.
`WRITE_THROUGH` alone does not guarantee a same-volume rename commit.
The helper retries access and sharing locks for one second.
Windows journals stop at 1 MiB before writing; POSIX journals retain the 8 MiB limit.
New spawns stop at 512 KiB on Windows and 4 MiB on POSIX, to reserve space for worker notices.
Cold compilation runs outside the daemon event loop. Helper waits use 50 ms plus 15 ms per MiB, capped at 250 ms.
Safe helper restarts wait one second, then double to 60 seconds. Ten healthy minutes reset the delay.
An uncertain commit prevents restart.
After a pending receipt times out, reconcile its original write, then use a new message id.
Readers check Windows ownership and reject ACLs that expose content or mutation rights to other users.
The temporary file stays in the destination directory. Cross-volume copies are disabled.
A missing PowerShell executable, constrained language policy, flush failure, or rename failure refuses the operation.
No native Node addon or live host installation is required.
POSIX systems retain file flush, rename, and parent directory flush.
See Microsoft's [move contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
and [file flush contract](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.flush).
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

Chat `operations` permits `spawn`, `notice`, or both.
Incoming link `operations` also permits `limits` for account limit observations.
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

## Provision a Mac-to-PC link

Run `node --import tsx scripts/provision-host-link.ts prepare PLAN OUTPUT` on the source Mac.
Use a private plan file with these fields:

```json
{
  "sourceServerId": "mini-server-id",
  "targetServerId": "pc-server-id",
  "leadId": "lead-agent-id",
  "linkId": "main-pc",
  "url": "https://pc.example.test",
  "expiresAt": 2000000000000,
  "workspace": "job",
  "directory": "D:\\jobs",
  "profile": "haiku",
  "worker": {
    "provider": "claude",
    "model": "claude-haiku-5-5",
    "modeId": "bypassPermissions",
    "parents": ["claude:bypassPermissions"]
  },
  "maxWorkers": 1
}
```

Replace host IDs, expiry, model, source mode, and workspace with the owner's selected values.
The command creates a new directory with mode `0700` and two fragments with mode `0600`.
Each new identity gets a credential from 32 random bytes. Credentials never appear in command arguments or output.

After release, apply `source.json` on the Mini and `target.json` on the PC.
Run `node --import tsx scripts/provision-host-link.ts apply HOME`, with the fragment on stdin.
Use the release source checkout on each host. Pipe the target fragment through authenticated SSH stdin.
Do not copy it into a public Windows temporary file.
The Windows writer creates the destination file with a protected, owner-only ACL before writing its contents.
The source writer uses mode `0600`.
Existing chat credentials and workload routes stay in place. Existing link IDs cause refusal.
If either apply fails, retain both fragments. Inspect both files before retrying; a timeout can follow a completed rename.
The two-host update is not a distributed transaction. A half-applied link cannot authenticate at the other host.

Repeat preparation with another link ID and target server ID for another PC.
These commands do not restart daemons or test live provider access.
The lead must perform the create, finish-notice, and archive acceptance check after both hosts have the release.

## Use from a lead

Prepare a private JSON request with one retained UUID:

```json
{
  "kind": "spawn",
  "issuedAt": 1792065600000,
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
  --issued-at 1792065600000 --message-id 22222222-2222-4222-8222-222222222222 --prompt-file follow-up.txt
```

The CLI stores the worker credential in the private receipt file. It does not print that credential.
The receiver commits the private receipt with the platform durability method before provider creation.
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
For a remote host, supply `hostLink` with `messageId`, `issuedAt`, `workload`, `workspace`, and `profile`.
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
Changed authority, archived callers, and changed provider sessions refuse delivery. Notices never restore an archived lead.
Credential rotation and expiry renewal preserve return notices while the grants remain active.

Healthy subscriptions check for retained events every ten seconds. Network failures use eight persisted attempts with delays capped at sixty seconds.
The home daemon reads at most four workers concurrently. It checks completed workers until archive permits cleanup.
It has no timer when no eligible work remains.
After retry exhaustion, repeat the same native creation request with its original UUID to renew the retry budget.
This reuses the worker and notice receipts. It never starts a replacement worker or replays a delivered notice.

Each worker keeps up to 127 permission checkpoints and one terminal notice within the existing journal storage limits.
Do not delete receipt files to clear capacity or retry a request.
The private source outbox retains notice text and delivery state for owner inspection until cleanup.
Cleanup requires an archived worker, no pending prompts, and source acknowledgement of every terminal notice.
Resolved permission notices can also be removed. Finished workers keep their control grants until archive.
Both hosts must support the `acknowledge` operation for automatic cleanup.
The receiver first commits compact replay records in `host-links-inbox.json.replay`, then removes active entries.
The source uses `host-links-outbox.json.replay`. A duplicate UUID returns its old outcome; a changed request fails.
Each replay file has a 1 MiB cap. New spawns reserve replay space for active work and stop before capacity is full.
Replay records expire after 30 days, including records for configured credentials.
The source sets a missing spawn `issuedAt` at first dispatch and retains it with the request UUID.
Retries reuse that time from the active outbox or replay record. A different caller timestamp fails.
Prompt requests must retain their original `issuedAt` in Unix milliseconds with their UUID.
Both hosts refuse requests aged 30 days minus five minutes, and timestamps more than five minutes in the future.
Keep host clocks synchronized. Never refresh a retry's timestamp. Reconcile an expired request before using a new UUID.
Update both host daemons and remote clients. Local messages keep their existing protocol shape.
Legacy active worker receipts remain readable. Timestamp-free pending requests require reconciliation and cannot replay automatically.
A notice save capacity or write failure produces a fixed warning through the normal source lead delivery path.
Start events and temporary Windows reconciliation fences do not set this warning.
Events blocked by a Windows receipt wait for its completion, then retry only journal persistence.
The daemon checks the original write result. It reports a confirmed write failure without replaying provider input.
Real result text remains available. Only a successful terminal notice save or source acknowledgement clears its warning.
The source stops its notice watch after delivering a storage warning. It does not poll that warning indefinitely.
A separate private `host-links-notice-failures.json` file keeps warnings across restart when storage permits.
Notices from a cleaned-up worker set a repair marker and a runtime log warning.
The source can read this warning through the retired worker receipt.
Do not restore retired workers; create a new worker instead.
After storage repair and worker reconciliation, stop the worker host daemon when idle.
Keep it stopped while you clear only that worker's marker:
`fulcra host-link clear-notice-failure --home <worker-home> --worker <worker-uuid>`.
Restart the repaired daemon. This also clears any in-memory fallback warning.
Repeat the original, unexpired creation request on the source to resume its notice watch.
Run `fulcra host-link status --home <source-home>` to count uncertain notices, exhausted deliveries, and exhausted watches.
An exhausted watch means the home daemon stopped checking that worker for notices.
A failed or interrupted provider handoff has state `uncertain`. It requires reconciliation; the daemon never replays it automatically.
This preserves the native input safety rule when provider acceptance cannot be proved after a crash.

## Shared account limits

Set `shareLimits: true` on each outgoing link that must share account limits.
Add `limits` to its matching incoming link's `operations`.
These grants are independent of chat grants, worker profiles, and reporting routes.
Existing link configurations keep their previous authority.

The daemon shares session (5-hour) and weekly limits from the local pool and quota readings.
The payload contains an account UUID, limit kind, observation time, and reset time.
The receiver derives the source host from the authenticated link.
It ignores unknown account UUIDs and expired observations.
Account UUIDs must match across the pools; display names do not establish identity.
No account credential, account name, or provider home crosses the link.

Remote observations stay separate from local pool records and survive daemon restarts.
A newer local observation, including a local clear or usage reading, takes precedence.
Equal observation times favor the local host.
Remote holds expire at their reset and never trigger an account switch or replay a turn.
The account CLI and pooled usage details identify the limit source.

The daemon sends retained local limits at startup and sends changes from pool file events.
It retries failed links once per minute without changing the local account state.
Each pass has a 15-second network deadline per link.
It never forwards a remote observation.
A receiver accepts at most eight days until reset and one minute of clock skew.
Keep paired host clocks synchronized.
Limit sharing uses the same durable private-file commit.

## Verification boundary

Run focused tests through the existing test scripts and queue.
Use the [Windows verification skill](../.agents/skills/verify-windows-host-links/SKILL.md) for the real-PC durability check.
The source tests use real HTTP, private files, durable receipts, and isolated agent runtimes with test providers.
They cover admission, initial input, credential refusal, permission restrictions, retries, response loss, and role moves during held delivery.
Return-notice cases cover finish, error, permission, restart, link recovery, duplicate suppression, and the real runtime-to-provider handoff.

Account limit tests cover sharing, reset expiry, local precedence, source details, and offline retry over HTTP.
They do not prove installed Mac-to-Mac or Mac-to-PC provider execution.
The merge owner must obtain the required fresh security review before integration.
Do not install or restart live daemons to run this batch's tests.
