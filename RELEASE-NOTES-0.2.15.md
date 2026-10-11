# Fulcra 0.2.15

This release gives the source code only. It does not include an app download. To use Fulcra, build and package your own app. The README section "Build and package your own Fulcra" gives the steps. On Windows, use the Windows guide (docs/windows.md).

Fulcra 0.2.15 is based on Paseo v0.11.0-beta.5.

## New in 0.2.15

### Command Centre

- A session that another computer books on this computer is a worker. It now uses the worker default model that this computer marks (Sonnet 5.5 for Claude). This closes the known gap in the 0.2.14 notes, where a booked session got Opus 5.5. If this computer marks no worker default, or its model list cannot be read, the booked session keeps its enrolled model. A model that the booking names still wins.
- When a message from a trusted plugin is refused because the chat is busy, its pending receipt is now cleared. The same message ID can then be sent again when the chat is idle. Before, the second send failed with "outcome unknown".

### Sidebar leads

- When a computer goes offline, its leads no longer show twice for one read. The sidebar shows only reads from the computers that are online now, plus the greyed remembered rows.
- A failed projects read no longer saves the placeholder name "project" as a remembered lead's project. The sidebar keeps the name it remembered before. If it remembered none, it saves nothing until a read works.

### Windows update script

- The protected chat check reads its names from `protected-chats.txt` in the install folder, not from the code. The file must exist; it may be empty. A chat whose name or folder contains a listed name is never stopped by an update.
- The update lists chats in every working folder (`paseo ls -g`). Before, the check before the stop and the health count after the start could miss chats in other folders.

### Tests

- Test data and two Command Centre placeholders use neutral project names.
