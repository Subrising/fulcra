# Lead tool selection

Set the session label `fulcra.mcp=lead` to select the daily catalog.
The host stores this label with the session. Resume keeps the selection.
Existing `fulcra.mcp=on` sessions retain the full catalog.
The global enable flag and all extra injection labels still apply.
An `on` injection requirement accepts both `on` and `lead`.
Other label requirements keep exact matching.

The daily catalog has these 12 tools:

- `create_agent`
- `send_agent_prompt`
- `list_agents`
- `get_agent_status`
- `get_agent_activity`
- `archive_agent`
- `update_agent`
- `cancel_agent`
- `list_pending_permissions`
- `respond_to_permission`
- `supervisor_inbox`
- `supervisor_acknowledge`

Native report tools still require a native report origin.
Voice tools keep their separate host policy.

## Optional groups

Set `fulcra.mcp.groups` to a comma-separated list on a lead session.
For example, `browser,terminals` adds both groups.
Set an empty string to remove the optional groups.

| Group        | Tools                                   |
| ------------ | --------------------------------------- |
| `browser`    | Browser controls                        |
| `terminals`  | Managed terminals                       |
| `schedules`  | Schedules and logs                      |
| `heartbeats` | Recurring prompts                       |
| `workspaces` | Workspace management                    |
| `scripts`    | Workspace scripts                       |
| `discovery`  | Providers, models, and profiles         |
| `artifacts`  | Native artifact output                  |
| `lifecycle`  | Runtime close and separate mode control |

Unknown groups are refused. Groups require the lead preset.
Provider `paseoTools.allowedTools` narrows the selection.
Provider `disabledTools` and `enabled` restrictions still apply.
Unknown allow-list names are refused. New tools do not enter the lead preset automatically.

## Authority and runtime changes

Tool selection grants no action authority.
Workers cannot select the lead preset or change group labels.
The user or an authenticated lead can change reserved labels.
All configured injection requirements must match the caller.
URL query values cannot select a policy.

A live selection change uses quiet native resume for supported Claude and Codex sessions.
It retains the session identity, history, and native report ownership.
Active turns, pending permissions, active provider children, and stale ownership refuse the change.
Other providers retain selection at launch and stored resume.
Close unsupported runtimes before changing their stored selection.
The external MCP refresh operation keeps its existing rules.

Creation, follow-up sends, permission responses, archive, and finish notices keep their existing handlers.
Use `notifyOnFinish:true` for each worker turn.
Use `background:true` for normal follow-up sends.
