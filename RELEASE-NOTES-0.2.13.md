# Fulcra 0.2.13

This release gives the source code only. It does not include an app download. To use Fulcra, build and package your own app. The README section "Build and package your own Fulcra" gives the steps. On Windows, use the Windows guide (docs/windows.md).

Fulcra 0.2.13 is based on Paseo v0.11.0-beta.5.

## New in 0.2.13

### Windows

- Command Centre runs on Windows (x64). It was tested on one Windows 11 PC. Turn it on in Settings → Advanced → Background service.
- The Command Centre secret and the account tokens are encrypted with Windows data protection (DPAPI, this Windows user only). There is no plain-text fallback. DPAPI protects them from other users, not from other programs that run as you.
- The controller uses a named pipe with a random name, locked to this Windows user. File ownership checks use Windows access rules and fail closed.
- When the app window crashes, the crash is logged and the window reloads, at most 3 times a minute. Child process crashes are logged too.
- `scripts/windows-update` builds a release into a new folder, swaps it in, checks its health and rolls back on failure.
- docs/windows.md says what was tested on Windows and what is not available.

### Messages between chats

- A held message is delivered in its sender's own trust context: a message from a chat counts as agent input, and a message from you counts as yours. Before, a held message from a chat could count as your input.
- A held prompt from the MCP `send_agent_prompt` tool now re-checks the reporting line at delivery and tells the sending chat when it is refused or fails, as CLI sends already did.
- When a held message from you fails, you see an error.
- A chat can hold at most 50 waiting messages. One more is refused with a clear message.
- Report-up: a canceled turn no longer decides whether the next turn sends a notice.

### Models

- A worker that a chat starts without a model gets Sonnet 5.5. Chats that you start keep Opus 5.5. A model that is given explicitly always wins.

### Command Centre

- When the controller fails its quick restarts, Fulcra keeps trying again with a growing wait, instead of stopping.
- The Leads page shows the main assistant's chat from the chat list when it is not part of the fleet, and says why a chat could not be observed.

### iPhone

- Command Centre pages open on the iPhone. Before, every page failed ("Element type is invalid"), because the phone's JavaScript engine (Hermes) turned class expressions in plugin pages into undefined. The computer now compiles plugin pages for the phone without class syntax. The phone app itself does not change.
- Plugin commands such as `/account` work on the iPhone. The plugin list read failed on iOS on every try, so plugins from your computers never loaded there. A failed plugin list read is now logged.

### Command line

- `fulcra archive` finds a chat by its ID, also when the chat is not on the first page of the archived list.
