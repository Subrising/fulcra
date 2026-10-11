# Fulcra 0.2.16

This release gives the source code only. It does not include an app download. To use Fulcra, build and package your own app. The README section "Build and package your own Fulcra" gives the steps. On Windows, use the Windows guide (docs/windows.md).

Fulcra 0.2.16 is based on Paseo v0.11.0-beta.5.

## New in 0.2.16

### Sidebar

- The whole sidebar scrolls as one area: the main assistant, New chat, plugin rows such as Leads, Pinned and the sessions. Before, the top rows stayed fixed and could push the list off a phone screen.
- Lead rows take one line. The Leads arrow folds the block, and the sidebar remembers the choice.
- On a touch screen (phone, tablet, or no fine pointer), sidebar rows, footer buttons, help and close are at least 48 px tall. A mouse keeps the compact rows.
- Setup rows no longer draw on top of each other while a computer reconnects. On a phone, the close button has its own row and no longer covers New chat.
- The plugin home page has the sidebar menu button.

### Sidebar leads

- A lead on another computer that has no seat in this computer's Command Centre now takes new work from the + button. The work is sent on that lead's computer, then its chat opens. A tap on the row opens the chat.
