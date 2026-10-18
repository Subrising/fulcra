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

## MCP tools

`work_assign` opens an assignment. `work_submit` sends the result and check evidence.
`work_review` approves or rejects. `work_cancel` cancels.
Rejection sends the findings to the same worker with a new finish notice for the lead.

## Storage

`$PASEO_HOME/work-acceptance/assignments.json`. The daemon writes it before any effect.
A corrupt file stops the daemon from starting. It does not forget open work.
After a restart, a `CLOSING` assignment finishes when its worker is archived.

## Not covered

- A session with no assignment keeps the old behaviour. Open an assignment before work starts.
- The app has no cancel button yet. A lead cancels with `work_cancel`.
- Provider-internal `/goal` checks inside one provider turn are not counted until the provider reports a new turn.
- Automatic next-item dispatch stays off.
