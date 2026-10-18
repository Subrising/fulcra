# Approve before close

A worker session closes only after its result is checked and approved.
A restart or crash does not approve work.

## States

`RUNNING` → `AWAITING_APPROVAL` → `APPROVED` → `CLOSING` → `CLOSED`.
`CANCELLED` is the other end state. It records a stop, never a finish.

A failed check keeps the worker in `RUNNING`.
A rejection returns the same worker to `RUNNING` with a new turn round.

## Close rule

The host closes a session only when all three are true:

1. The goal has a passing check record for the current result.
2. The approval names the same result (commit SHA or artifact hash) and the same evidence digest.
3. The approver is allowed for the approval class.

| Class       | Approver                          |
| ----------- | --------------------------------- |
| `routine`   | The passing check record.         |
| `milestone` | The assigning lead, or the owner. |
| `creative`  | The owner only.                   |

A worker cannot approve or cancel its own work.
A change to the result after approval cancels the approval.
The host reads the live result again at close time.

## Routes that refuse

The same check runs for the app archive, CLI archive, MCP `archive_agent`, bulk archive, parent archive (cascade), workspace teardown preflight and snapshot archive.
The session close and delete routes (`kill_agent`, app delete) also refuse.
Runtime shutdown, restart and provider retirement do not use the check. They leave the assignment open.

Cancel the assignment with `work_cancel` to stop work. It records `CANCELLED`, and the worker can then be archived.

## Turns

The host counts every started turn, including turns the provider starts itself.
A turn past the round limit is refused or cancelled.
While a result waits for approval, no model turn starts.
The lead raises the limit or rejects with findings.

## Loop guard

A Stop hook or goal can send a worker the same prompt again and again while it waits for a job.
The host counts consecutive finished turns that answered such a prompt with no tool action.
Three in a row set the worker to `WAITING` with the job id it declared (`work_wait`), or `unknown`.
A repeat with a tool action, or an ordinary turn, resets the count.
While `WAITING`, no model turn starts. The host cancels any turn the provider starts itself.
`work_job_done` is the job's completion event. It resumes the worker and sends it one turn.
The number of stopped loops is stored in the approval record (`loopsStopped`).

## MCP tools

`work_assign` opens an assignment. `work_submit` sends the result and check evidence.
`work_raise_limit` lets the assigning lead raise a worker's turn limit.
`work_wait` names the job a worker waits for. `work_job_done` reports that the job finished.
`work_review` approves or rejects. `work_cancel` cancels.
Rejection sends the findings to the same worker with a new finish notice for the lead.
If the send fails, the findings stay in the record marked not delivered. Repeating the rejection resends them once.
The owner reviews over the app connection with `agent.work.owner_review.request` (client method `reviewWorkAsOwner`).

## Caller identity

An agent's MCP request names its id in the URL. That id is only a claim.
Each agent gets its own token, derived from the daemon token and its id. The work tools act only on a request that carries the token for its own id.
A request with the daemon-wide token, a password, or another agent's token is refused by the work tools.

### Where the token travels, and the limit

The token never appears in a process's arguments.
- Claude: the SDK passes the MCP config as inline JSON in the command line. The daemon moves that JSON to a file only the owner can read (mode 0600, in a directory with mode 0700) and passes the path. The file is removed when the process exits.
- Codex and ACP agents get the config over their own RPC channel. OpenCode gets it through its API. Pi writes it to a 0600 file and removes it on close. OMP reads it inside the daemon.

**Limit.** On a host where all agents run as one OS user, a process of that user can still read the file and the process environment. The process list is closed; this is not a full separation between agents. The full fix is a per-agent credential (open decision F4, FU-161).

## Owner override

The owner can cancel an assignment, raise a turn limit, or reset a corrupt or deleted store (`agent.work.owner_override.request`, client method `overrideWorkAsOwner`).
Each override is written to the override log in the same write as the change.

## Storage

`$PASEO_HOME/work-acceptance/assignments.json`. The daemon writes it before any effect.
A corrupt file, or a file deleted after it was written, makes every close refuse. The daemon still starts. Only the owner reset reopens it. The old file is kept as `assignments.json.corrupt-<time>`.
After a restart, a `CLOSING` assignment finishes when its worker is archived.

## Not covered

- A session with no assignment keeps the old behaviour. Open an assignment before work starts.
- The app has no cancel button yet. A lead cancels with `work_cancel`. The owner uses the override request.
- A routine result is approved when it has at least one check that exited 0 and non-empty evidence. The host does not run the check itself.
- If the live commit cannot be read at close time, the approval is kept (the reviewer's minor finding m1, not fixed in this round).
- Provider-internal `/goal` checks inside one provider turn are not counted until the provider reports a new turn.
- The guard sees a Stop-hook prompt by its text, from the prompt the host sent or the provider's user message. Whether the real Claude provider records hook feedback as a user message is not verified.
- Automatic next-item dispatch stays off.
