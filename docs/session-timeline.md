# Session timeline

The daemon keeps a durable timeline for every agent: each prompt, reply, reasoning step and tool call,
in order. On top of that journal it keeps a turn index and a file index, so a client can step through
a session turn by turn or ask for every change to one file. Delivery and paging are covered in
[timeline sync](timeline-sync.md); this doc covers what is stored, how long it is kept, and how to
remove it.

## What is recorded

The journal lives in `$PASEO_HOME/native-timeline-journal/`, one set of files per agent, named by the
SHA-256 of the agent id. Rows carry a sequence number, a timestamp, the timeline item and, when the
provider gave one, a turn id. Claude and Codex go through the same path, so both produce the same
rows and the same index.

The turn index lists, per turn, its first and last sequence number, start and end time, how many
distinct tool calls ran, and which files they touched. Rows without a provider turn id (replayed
provider history, out-of-band prompts) are grouped into implicit turns: an unlabelled prompt opens
one, named `seq-<n>` after its first row, and later unlabelled rows join the turn before them.

The file index lists, per file, every read, write, edit and patch with its sequence number and turn.
Paths are stored relative to the agent's working directory. A path outside it is counted as
external and its path is not stored. Rooted paths are read in the flavour of the working directory,
so a Windows drive, UNC or backslash-rooted path seen on a macOS or Linux host is external rather
than mistaken for a relative one. A Codex patch records every file it touched: a multi-file edit
carries a `files` list with `filePath` still the first file for older clients, and a patch with no
previewable diff keeps its `files` on the `unknown` detail it renders as. One changed file indexes
as an edit, several as a patch.

The index is kept in memory and written to `native-timeline-journal/index/<hash>.json` shortly after
each write. That file is a cache: the daemon checks it against the journal's segment sizes and the
working directory, and rebuilds from the journal whenever they differ, so deleting it loses
nothing. The working directory itself comes from the agent record, or from `retained.json` once the
agent is deleted, never from the cache.

## Segments

A journal file that would grow past 256 MiB rolls over to the next segment: `<hash>.jsonl`, then
`<hash>.1.jsonl`, `<hash>.2.jsonl` and so on. Every segment starts with the same header, sequence
numbers keep increasing across segments, and reads span all of them. A new segment is written and
synced under a temporary name and then renamed into place, so a crash during rollover leaves either
no new segment or a complete one; earlier history is never blocked by a half-written file.

### Downgrading

Before its first rollover, a journal's header is changed from version 1 to version 2. A daemon from
before segments only accepts version 1, so it refuses a rolled journal: that agent shows a timeline
error on the older daemon instead of the daemon appending to the first segment and corrupting it.
Journals that never rolled over keep version 1 and work on either version.

Downgrading after a journal has rolled over is not supported. The rolled agents' history is safe
but unreadable on the older daemon. To roll back:

1. Stop the daemon and copy `$PASEO_HOME/native-timeline-journal/` somewhere safe.
2. Install the older version. Agents whose journals never rolled over work as before.
3. To see rolled history again, reinstall this version or later; the journal is read in full.

Do not edit the header back to version 1 by hand. The older daemon would read only the first
segment and could append sequence numbers the later segments already use.

One path still reaches a rolled journal on an older daemon: reloading an agent from provider history
replaces its journal. That deletes only the first file and starts a new version-1 journal, leaving the
later segments behind. After you upgrade again, the agent reads the journal the older daemon wrote. The
leftover segments belong to the history that was replaced, so they are renamed to
`<hash>.<n>.jsonl.orphaned-<time>` and kept, never read and never deleted. Remove them by hand once you no
longer need them.

Reads still load an agent's whole journal into memory the first time it is opened. Rotation removes
the hard stop at 256 MiB; it does not make very large sessions cheap to open.

## Retention

Archiving an agent leaves its journal where it is, so unarchiving restores the full history.

Deleting an agent moves its journal and index to `native-timeline-journal/retained/<hash>/`, with a
`retained.json` that records where the agent ran and which provider it used. Turn and file queries,
and ordinary timeline fetches, still answer for the deleted agent and report `retained: true`.
Deleting a second agent with the same id keeps both copies; queries read the newest, and the
older copy is renamed to `<hash>.superseded-*`, never removed.

The move is one recoverable step. The daemon first writes `retained/<hash>.intent.json`, moves the
segments into `retained/<hash>.staging/`, and publishes them with a single directory rename. If the
daemon stops part way, the next start (or the next read of that agent) finishes the move, so no
history is ever split between the live and retained areas. The agent record is removed only after
the history is safely retained; if retention fails, the delete fails with "The agent was not
deleted because its history could not be saved" and the agent stays in place to try again.

Reloading an agent from provider history and rewinding still replace the journal outright. The
provider history is the source of truth in those cases.

To make delete remove history instead, set this in `$PASEO_HOME/config.json` and restart the
daemon:

```json
{ "agents": { "history": { "retention": "purge" } } }
```

The default is `"keep"`. An older daemon rejects a `config.json` that contains `agents.history`,
so remove the setting before downgrading.

## Purging history

Purging is permanent. Use one of:

- **On delete:** send `delete_agent_request` with `purgeHistory: true`, or call
  `client.deleteAgent(agentId, { purgeHistory: true })`.
- **After delete:** send `agent.timeline.purge.request` with the agent id, or call
  `client.purgeAgentTimeline(agentId)`. The daemon refuses while the agent still exists; delete it
  first.
- **By hand, with the daemon stopped:** remove `native-timeline-journal/retained/<hash>/` and any
  `<hash>.superseded-*` directories next to it. Leave `<hash>.intent.json` and `<hash>.staging/`
  alone: they mean a retention is still being finished, and the next start completes it.

## Protocol

Clients gate on `server_info.features.agentTimelineTurnIndex`. An older daemon ignores the new
optional request fields and does not know the new requests. `DaemonClient` checks the flag before
sending any of the requests below, including a fetch with `turnId`, and fails with "This needs a
newer Fulcra host." Without the check, an older daemon would drop `turnId` and return the whole
timeline.

| Request                                   | Fields                                   | Response payload                                                                                                  |
| ----------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `agent.timeline.list_turns.request`       | `agentId`, `cursor?`, `limit?` (max 500) | `epoch`, `retained`, `turns[]`, `totalTurns`, `nextCursor`                                                        |
| `agent.timeline.get_file_history.request` | `agentId`, `path`                        | `epoch`, `retained`, `path` (relative, or `null` for external), `touches[]` of `{ seq, turnId, kind, timestamp }` |
| `agent.timeline.purge.request`            | `agentId`                                | `purged`                                                                                                          |
| `fetch_agent_timeline_request` (existing) | adds `turnId?`                           | the usual page, limited to that turn; cursors and `limit` page within it; adds `retained?` for a deleted agent    |
| `delete_agent_request` (existing)         | adds `purgeHistory?`                     | unchanged                                                                                                         |

A turn in `turns[]` is `{ turnId, implicit, seqStart, seqEnd, startedAt, endedAt, toolCount, files, externalFileCount }`.
File history accepts a relative path or an absolute path inside the agent's working directory.

## Relevant code

- Index builder and path rules: `packages/server/src/server/agent/timeline-turn-index.ts`
- Journal, segments, sidecar and retention: `packages/server/src/server/agent/file-agent-timeline-store.ts`
- Delete and purge decisions: `AgentManager.removeDeletedAgentState` in `packages/server/src/server/agent/agent-manager.ts`
- Codex multi-file patches: `packages/server/src/server/agent/providers/codex/tool-call-mapper.ts`
