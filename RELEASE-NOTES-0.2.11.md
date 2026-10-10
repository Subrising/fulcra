# Fulcra 0.2.11

This release gives the source code only. It does not include an app download. To use Fulcra, build and package your own app. The README section "Build and package your own Fulcra" gives the steps.

Fulcra 0.2.11 is based on Paseo v0.11.0-beta.5.

## New in 0.2.11

### Auto-resume after a restart works for Claude sessions on a pool account

- A Claude session on a pool account that a daemon restart or crash cut off is now queued and resumed once, after the restart. In 0.2.9 and 0.2.10 no session was queued.
- Command Centre keeps its rule: a session that it manages (delegated, or taken over by you) is not resumed. This check runs when the resume is due.
- Known limits: other sessions are not resumed after a restart. A Claude session that is not on a pool account is not queued. A Codex session is refused when the resume is due. Both fail closed and send nothing.

### Leads sidebar

- The Leads section lists the main assistant first, then the project leads.
- Each row shows the chat's own name. The second line gives the role, the project, the status and the computer, for example "Lead · Fulcra · Idle · Mac mini".
- Leads on other connected computers are listed, read-only, with the computer's name. A computer that does not answer adds no rows.
- The main assistant of this computer is no longer pinned automatically, because Leads lists it. Pins that you made yourself do not change.

### Team setup

- Team setup works on a computer that uses a local task list. Before, it refused to add a chat ("This task cannot take team members: Local task unavailable"). The list is repaired at the next Team setup step, with no manual edit.

### Safety

- `paseo daemon stop` and `paseo daemon restart` refuse when they run inside a session of that same daemon, so a chat cannot stop the daemon that it runs on by accident. `--override-session-guard` skips the check for an operator outside every session.
- The controller lock is not cleared after a restart when the process that holds it is still alive.

### Voice

- Phone dictation stays on host transcription. A test now fails if this changes.

### For contributors

- CI runs the Command Centre grant test for paired devices.
- The `ci-passed` check also fails when the change-detection job does not succeed.
- Each release is checked on the signed app before it is published: the controller must connect and answer, and a session cut off by a daemon restart must be queued.
