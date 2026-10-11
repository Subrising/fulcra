# Fulcra 0.2.14

This release gives the source code only. It does not include an app download. To use Fulcra, build and package your own app. The README section "Build and package your own Fulcra" gives the steps. On Windows, use the Windows guide (docs/windows.md).

Fulcra 0.2.14 is based on Paseo v0.11.0-beta.5.

## New in 0.2.14

### Sidebar leads

- The Leads section refreshes every 30 seconds.
- A lead that holds a seat stays in the list when its project data cannot be read.
- A chat that reports to the main assistant without a seat is listed as a lead.
- When another computer is offline, untrusted or does not answer, the sidebar shows that computer's last known leads, greyed.

### One status line for a chat

- The sidebar and the Leads page show a chat's status from the chat list in the same words: Working, Idle, Starting or Needs attention, each marked "last known". A closed chat shows "Saved". Otherwise the line says "Status unknown".
- The Leads page now shows the last known status for a seat chat that the app has not opened, instead of "Status unavailable".

### Command Centre

- A Command Centre create that you start keeps Opus 5.5. Only a create that names a parent chat gets the worker default (Sonnet 5.5). An explicit model always wins.
- A message that carries a trusted plugin's identity is refused while the target chat is busy, with a plain reason. Before, it waited and was then delivered as if it came from you.
- When the 50-message limit refuses a held message, its pending receipt is cleared, so the same message ID can be sent again.

### Command line

- `fulcra archive` shows the daemon's own error. It uses the archived list only when the daemon says the chat is not found, and it refuses an ID that matches more than one chat.
