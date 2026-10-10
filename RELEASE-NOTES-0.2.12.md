# Fulcra 0.2.12

This release gives the source code only. It does not include an app download. To use Fulcra, build and package your own app. The README section "Build and package your own Fulcra" gives the steps.

Fulcra 0.2.12 is based on Paseo v0.11.0-beta.5.

## New in 0.2.12

### Messages between chats

- Report-up: when a chat with a lead (its reporting line, else its parent) ends a turn, its lead gets one short notice with the start of the chat's last message (up to 600 characters). This happens once per turn. There is no notice for a turn that a notice started, for a chat without a lead, when the lead is you, when the lead is on another computer, or when the reporting line refuses. To turn it off, set `daemon.reportUpOnTurnEnd` to `false`.
- A message from another chat no longer stops or enters the turn of a busy chat. It waits in a queue for that chat and is delivered, in order, when the turn ends. Report-up notices, undelivered-message notices and finish notices wait in the same way.
- A message from you to a busy chat steers into its running turn. When the turn cannot take a steer, the message waits instead of replacing the turn. An explicit interrupt still interrupts.
- The queue is kept in memory only, so a daemon restart drops the messages that still wait in it.
- The reporting line is checked again when a waiting message is delivered. When the send is refused there, or the delivery fails, the sending chat gets one notice with the reason.

### Reporting lines

- When a send is refused because the target does not report to the sender and no chat holds the main assistant role, the refusal names the target and says how to fix it.
- A lead without a reporting line, and a chat with no line but with chats under it, now show "No reporting line recorded" instead of nothing.

### Safety

- On macOS and Linux, `paseo daemon stop` for a local daemon now also checks the session marker before it stops the daemon. Before, a process that left the daemon's process tree (for example with `nohup`) but kept the marker could stop its own daemon.
- After a restart, a controller lock whose pid now belongs to a newer, unrelated process is cleared. When the start time of that process cannot be read, the lock is kept (fail closed).

### For contributors

- CI runs the controller lock tests and the config tests.
- `npm install` no longer runs `lefthook install --force` when `core.hooksPath` is set, so it does not replace hooks that you manage yourself.
- Changes reach `main` through one pull request per release. `main` accepts a push only when the `ci-passed` check passed on that exact commit.
