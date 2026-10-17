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

Exceptions use complete session IDs. A Claude pause leaves Codex delivery active.
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

The guard reserves an attempt before calling the native CLI.
An uncertain attempt stays retained and is not replayed automatically.
Ordinary CLI output stays live. Windows children use hidden startup settings.

Install guards with backups and atomic file replacement.
Cover direct CLI paths in callbacks, including candidate app paths used by release transactions.
Do not restart an installer, render, queue runner, or daemon to replace a notice observer.
Replace a waiting observer only after checking its identity and its native exit event.
Never replay an `INTENT`, `SENT`, or uncertain callback receipt.

Run [the verification skill](../.agents/skills/verify-notice-pause/SKILL.md) before delivery.
