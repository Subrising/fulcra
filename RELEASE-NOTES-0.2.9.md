# Fulcra 0.2.9

This release gives the source code only. It does not include an app download. To use Fulcra, build and package your own app. The README section "Build and package your own Fulcra" gives the steps.

Fulcra 0.2.9 is based on Paseo v0.11.0-beta.5.

## Not working yet

- **Auto-resume after a daemon restart does not work in 0.2.9.** The setting and the code are present, but on a real restart no session is queued. The log says `Auto-resume skipped` with the reason "owned by a trusted plugin", and that reason is wrong. Nothing is sent, so this is safe. A fix is planned for 0.2.10.

## New in 0.2.9

### Auto-resume

- Auto-resume after a usage limit now also runs on a computer with Command Centre, for chats that Command Centre does not manage. Chats that Command Centre manages (delegated, or taken over by you) are not auto-resumed. In 0.2.8 no chat on such a computer was auto-resumed.

### Voice

- Phone dictation goes back to host transcription. The phone records the audio and sends it to your computer, which transcribes it. The on-device speech path from 0.2.5 is removed.

### Command Centre

- After a computer restart, Command Centre starts again by itself. A lock file left from before the restart no longer stops the controller. A lock from since the restart is kept.
- When the Leads sidebar cannot load, it says why, for example "Command Centre is not answering on <computer>", with a Retry button. The daemon log names the failed call and its reason.
- Command Centre on a paired device: the app names the real reason and the switch ("Allow Command Centre" in Settings, this Mac, Pair a device). It no longer suggests the host password. While a pairing code shows, the device list refreshes every 5 seconds. A new device shows "Just paired", with Command Centre off and the switch beside it. Other languages show the English text until they are translated.
- The Team map hides archived chats and the chats of archived projects. History still lists and opens them.
- When the main assistant seat moves, the old holder no longer keeps "reports to you".
- A refused project board change shows the board's own error text.

### Accounts

- A new session does not start on an account that has used 90% or more of its weekly limit while another account is below 90%. When every account is at 90% or more, the account with the most left is used. A session that already has an account keeps it. Fulcra does not move a running session to another account.

### Reliability

- The daemon works with 16 file and network threads instead of 4. On 9 Oct slow disk work filled the 4 threads, and requests then waited for minutes. A value that you set in `UV_THREADPOOL_SIZE` stays as you set it.
- Relay connections find their server even when those threads are busy. After 3 failed handshakes in a row the log says "Relay control: 3 handshake timeouts in a row", and it logs a line when the relay recovers.
- `paseo daemon status` waits up to 5 seconds to connect. On a slow computer a wrong password showed as "unreachable"; it now shows as a wrong password.

### iPhone

- The phone menu button is at least 48 by 48 points.

### For contributors

- The full typecheck runs before a push, not before each commit. Format and lint still run before each commit. CI is not changed.
- CI has one summary check, `ci-passed`, which fails when any CI job fails.
