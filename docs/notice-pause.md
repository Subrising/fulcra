# Pause completion notices

A provider pause stops completion notices from starting another turn.
It does not cancel the PC job or change its result receipt.

The daemon reads `pause.json` beside its agent storage directory, normally `$PASEO_HOME/pause.json`.

```json
{
  "pausedProviders": ["claude"],
  "exceptSessions": ["00000000-0000-0000-0000-000000000001"]
}
```

Exceptions use complete session IDs. An exception also includes its children and later descendants.
The guard reads each parent through `inspect`; list rows do not include parent labels.
The daemon reads live labels or its initialized storage cache at admission and final handoff.
Each check caches parent reads. A failed read, missing ancestor, or parent cycle keeps the notice paused.
A Claude pause leaves Codex delivery active.
Missing policy files mean no pause. Invalid policy files stop delivery.

Plain sends enter the existing durable message queue during a pause.
The daemon checks the pause again at provider handoff.
It watches policy changes and drains eligible notices after resume.
It retains sender checks, receiver identity, archive checks, and message receipts.

Notices combine within each sender. Owner input and agent input retain their original sources.
Paused parent sends keep their finish notice request without arming it.
Resume arms the combined delivery and preserves an explicit finish notice opt-out.
A pause at final handoff stops provider input and clears new arming for that delivery.
Plugin provenance and native queued capabilities remain on their existing admission paths.
A paused send cannot convert those capabilities into ordinary owner input.

## Host guards

`scripts/notice-pause.py` supports hosts that still run an earlier daemon.
It wraps an existing CLI without changing the app bundle.
The guard uses `~/.config/fulcra/pause.json` and stores one file per endpoint and receiver.
Each file retains separate sender batches and their native delivery receipts.

```sh
python3 scripts/notice-pause.py --cli /path/to/native-cli send SESSION --no-wait --prompt-file notice.txt
python3 scripts/notice-pause.py --pause
python3 scripts/notice-pause.py --resume
```

`--pause` adds Claude to the paused providers. `--resume` removes only Claude.
Other provider pauses stay active.
Set `FULCRA_NOTICE_CONFIG` to select an isolated policy directory for a test.

Optional host settings are:

| Setting                | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `deliveryCli`          | Use the current stable CLI when an old build has been retired. |
| `defaultHome`          | Select the existing native daemon home.                        |
| `daemonPauseFiles`     | Update the listed daemon policy files with the host policy.    |
| `roles.main-assistant` | Bind that role alias to a complete session ID.                 |
| `daemonWatch`          | Let the installed native watcher own resume delivery.          |

On Macs, a native `WatchPaths` job can drain notices outside a model process.
On Windows, `--resume` drains the saved batches directly.
Preserve the original sender environment for each batch.

Use `--require-delivery` before `--cli` for a required restart warning.
A paused target causes a refusal. The warning is not stored for later delivery.
The host transaction must stop before its mutation boundary.
Completion notices use the default durable hold.

The host guard does not replace the daemon pause gate.
An older installed daemon can still hold a descendant that the guard permits.
An older native CLI can return `status: sent` with `Provider paused. Notice saved. No turn was started.`
The current CLI returns `status: held` for that receipt and does not wait for completion.
The daemon also sends an optional `deliveryState: held` field.
The receipt confirms a saved notice, not provider input.
A Python hold has `status: held` and a record in `paused-notices`.
A daemon hold has a record with `pauseNotice: true` in `held-messages.json`.
Check the installed daemon version and both stores when a descendant stays paused.
Keep the current direct exceptions until the daemon inheritance fix ships.

## Configured SSH sends

Use `sshRoutes` in the host guard's policy file for automatic cross-host sends.
Each key must be a complete session UUID. Short or option-like keys are refused. Prefixes must select one configured ID.
The local daemon gets the first send. Only `AGENT_NOT_FOUND` permits an SSH attempt.
Display text in `noticeRoutes` grants no routing authority.
Missing routes, transport failures, ambiguous IDs, and reporting refusals never select another host.

These examples describe separate policies. Replace the IDs, SSH aliases, paths, and homes with verified values.
Do not copy another host's daemon password.

MacBook to Mini:

```json
{
  "sshRoutes": {
    "11111111-1111-4111-8111-111111111111": {
      "host": "Mac mini",
      "sshTarget": "mini",
      "cli": "/opt/fulcra/bin/fulcra",
      "home": "/srv/fulcra/mini"
    }
  }
}
```

Mini to MacBook:

```json
{
  "sshRoutes": {
    "22222222-2222-4222-8222-222222222222": {
      "host": "MacBook Pro",
      "sshTarget": "macbook-pro",
      "cli": "/opt/fulcra/bin/fulcra",
      "home": "/srv/fulcra/book"
    }
  }
}
```

Both hosts need the current CLI and an existing trusted SSH key.
Both daemons must support `agentSendReportingLines`. The source must also support the `AGENT_NOT_FOUND` response code.
Use the host launcher named `fulcra` as `cli` so the destination applies its pause policy and local credentials.
Other executable names cause a visible warning because they can skip the Python pause guard.
The source sends the prompt on SSH stdin and stamps the original chat and server ID with `--from`.
The source checks the stamped sender's own line before SSH starts.
A selected `--host` cannot change a local sender's host identity.
When the target is the sender's own lead on the destination host, the source adds `--outbound-parent <lead id>@<server id>`. The destination accepts the send only when that value names the target on this host. The CLI drops a typed `--outbound-parent` before an SSH relay; only the source daemon's check sets it.
A lead on another computer has no other route: the host-link `prompt` operation goes only from a lead to its own remote worker, and a host-link `notice` goes only to the main assistant.
Without a matching outbound line, the destination can accept only its own child or direct-link relation.
The destination checks that relation before a Python hold and again before daemon delivery.
Role and qualified-host restrictions stay with held notices until delivery.
The older host-link path already requires a retained child grant and checks that child relation again at handoff.
SSH sends return the destination admission receipt. They do not wait for task completion.
An SSH disconnect can hide an accepted send. Retain the draft and inspect before any retry.
The relay never follows another route from the destination.
Required restart warnings need an explicit endpoint; automatic SSH routing cannot defer them.

A daemon that listens only on loopback refuses `--host <tailscale address>:6767` with `ECONNREFUSED`. Use an SSH route instead.
An SSH key restricted by a forced command (such as the Windows PC's `pc-gate` key on the Mini) refuses the relay script. That host keeps its own gated command, such as `notify`, until the gate allows the relay.

When a worker ends a turn with a `DONE`, `BLOCKED` or `DECISION` line, or a question, and no finish notice reaches its lead, report-up acts once. It does nothing when the worker already sent to its lead during that turn, or when the chat has its own workers.
A lead on this computer gets the message even with finished-turn notices off. For a lead on another computer, the worker gets one notice to resend through a working route.
Turning off every report-up notice also turns this off.

The guard reserves an attempt before calling the native CLI.
An uncertain attempt stays retained and is not replayed automatically.
Ordinary CLI output stays live. Windows children use hidden startup settings.

Install guards with backups and atomic file replacement.
Cover direct CLI paths in callbacks, including candidate app paths used by release transactions.
Do not restart an installer, render, queue runner, or daemon to replace a notice observer.
Replace a waiting observer only after checking its identity and its native exit event.
Never replay an `INTENT`, `SENT`, or uncertain callback receipt.

Run [the verification skill](../.agents/skills/verify-notice-pause/SKILL.md) before delivery.
