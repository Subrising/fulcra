# Finish notices for parent sends

Parent sends request one finish notice by default. This applies to CLI sends, native steering, and MCP prompts.
Several messages in one turn share one notice. Queued messages form one combined turn and produce one notice.
A notice marked `delivered` covers its earlier turn only.
A child that delivered a message to its parent after the notice was armed gets no finish notice for that turn.
A finish notice carries the whole final message. Only output over 20,000 characters is cut, with a pointer to `fulcra logs`.
An idle worker can start another task while its earlier result waits for its busy parent.
Each result keeps its own saved notice and message text until delivery.
The native report inbox requires separate enrollment. Ordinary parent sends do not require that inbox.
When cost is available, each finish notice includes cumulative session spend, including earlier turns.

After a restart, queued delivery starts when saved open sessions are available.
An uncertain held batch is checked against the receiver's timeline and retained handoff receipt.
A present message is marked delivered. Proven absent input retries once per provider instance after the old run ends.
Claude and Codex retain the queue's input ID in native history, before the daemon journal commit.
Unreadable native history, unsupported providers, and older records without receipt support remain uncertain. The sender is told.
Absence also requires proof that the previous writer stopped. A crash that loses that proof keeps the input uncertain.
Reload within the same daemon retains the close proof. Uncertainty notices are saved and sent once.
Reload closes a pending provider start before queue recovery can retry it.
An idle, unpaused receiver can start its queued turn while other sessions recover their providers.
The parent notice is armed before the receiver starts.
A refused notice to an idle parent retries after 2 s, doubling to 60 s, for 8 attempts.
A busy parent gets it when it becomes idle. The saved notice is the retry record, so a restart keeps it.
An `unknown` outcome is checked against the parent's session. If the parent has no copy, the notice goes again with the same message ID.
Paused input stays held. Its finish notice stays unarmed until resume. See [provider pauses](notice-pause.md).

A finished child turn wakes its parent only when the final message has DONE, BLOCKED, DECISION, QUESTION or RISK at the start of a line.
Any other end of turn is held: the notice stays armed and no parent turn starts. An error, a permission request or a usage limit always wakes the parent.
A delivery notice (queued, delivered, accepted) never starts a parent turn.
The rule is in `packages/server/src/server/finish-notice-filter.ts`.

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

App sends have a 15 second reply limit. A timeout reports that delivery is unknown.
Retain the message ID and check the chat before sending again. A delayed queue commit can still finish.
The same text from the same chat is queued once while the first copy waits, and for 10 minutes after it is delivered.
An agent `--no-wait` send gets one message ID for the same sender, receiver, text and images within 10 minutes. Running the same command again after "Delivery is unknown" reuses that ID, and the receipt drops the copy.
Queue files sync before admission. Removing that sync can lose an acknowledged message after a crash.

## Verification

Run the scratch-daemon route tests:

```sh
npm exec --workspace=@getpaseo/server -- vitest run src/server/daemon-e2e/reloaded-cli-send.e2e.test.ts src/server/daemon-e2e/send-finish-notice.e2e.test.ts src/server/daemon-e2e/reporting-lines-role.e2e.test.ts
```

These tests use synthetic providers and isolated homes. They check real daemon transports and notice delivery.
They do not prove delivery through an operator's live cross-host configuration.
