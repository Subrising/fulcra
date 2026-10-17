# Finish notices for parent sends

Parent sends request one finish notice by default. This applies to CLI sends, native steering, and MCP prompts.
Several messages in one turn share one notice. Queued messages form one combined turn and produce one notice.
A notice marked `delivered` covers its earlier turn only.

Use `fulcra send <child> --prompt-file task.txt --no-wait` on the parent host.
Use `--steer` to join the current turn when the provider supports steering.
Use `--no-notify-on-finish` to opt out for that message.
MCP callers can set `notifyOnFinish: false`.
An opt-out does not cancel a notice requested by an earlier message.

For a remote worker, send through its parent host with `<full-child-id>@<server>` as the target.
The parent host must retain the worker's host-link creation receipt and its original grant.
The remote host returns the notice through that grant. A changed parent, session, profile, or grant causes refusal.
Remote sends return after admission. The finish notice carries the result.

A direct remote CLI relay with `--from` has no authenticated return route to its parent.
Such a relay must use the parent-host route, or explicitly opt out.
The daemon does not infer credentials from a host name or an SSH connection.

There is no separate live command to re-arm a current turn without sending a prompt.
Do not edit saved session records to create a notice.

## Verification

Run the scratch-daemon route tests:

```sh
npm exec --workspace=@getpaseo/server -- vitest run src/server/daemon-e2e/send-finish-notice.e2e.test.ts src/server/daemon-e2e/reporting-lines-role.e2e.test.ts
```

These tests use synthetic providers and isolated homes. They check real daemon transports and notice delivery.
They do not prove delivery through an operator's live cross-host configuration.
