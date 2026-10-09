# Fulcra 0.2.8

This release gives the source code only. It does not include an app download. To use Fulcra, build and package your own app. The README section "Build and package your own Fulcra" gives the steps.

Fulcra 0.2.8 is based on Paseo v0.11.0-beta.5.

## New in 0.2.8

### Leads and reporting lines

- Each chat reports to one lead: a worker to its lead, a lead to the main assistant, and the main assistant to you.
- A chat sends to its lead, to its own chats and to one direct link. Fulcra refuses other sends and names the correct recipient. Your own sends are never refused.
- The main assistant is a role. A lead reports to "the main assistant", not to one chat. When you choose a new main assistant, the leads need no change.
- When the controller starts, and every minute after that, the chat that holds the main assistant seat gets the role. That chat reports to you, and no other chat has the role. Only the controller can give a chat the role.
- `paseo run` from a chat records that chat as the lead of the new chat.
- The Team map shows the reporting lines. It marks a chat that has no line.

### Sidebar

- The main assistant shows at the top of the sidebar on every device, with the computer it runs on: "Main assistant · <computer>". The MacBook app shows the main assistant that runs on the Mac mini.
- When that computer is offline, the row says "offline". Its chat says that the computer is offline.
- When two computers each have a main assistant, both show.
- Under each chat in All sessions, a small line names its lead, for example "Reports to Main assistant".

### Voice

- Phone dictation uses on-device speech-to-text by default. No audio goes to a computer, so the start and the end of what you say are kept. Host speech-to-text is still a choice in Settings.
- Voice mode waits about 4 seconds of silence before it ends your turn. You can change this pause.

### iPhone

- A long chat paragraph that the list reuses now keeps the full row width.

## After you install 0.2.8

Do these steps if your main assistant chat holds no main assistant seat yet. For example, it was set up only with a label, or another chat holds the old seat.

1. Open team setup.
2. Select your main assistant chat, then select **Make main assistant**. Fulcra seats it within a few seconds. The chat then reports to you, and it is no longer a child of the chat that created it.
3. Select **Remove** on the old main assistant record (for example "delivery"). Then there is exactly one main assistant.
4. Make sure that the sidebar shows "Main assistant · <computer>" for the correct chat.

If step 2 says "Local task unavailable", the controller cannot find its programme task. Then the main assistant stays as it was. Check the controller's task source before you try again.

## Known limits

- The reporting-line rules help chats cooperate. They are not a security control.
- Any chat can still change its own `fulcra.reports-to` or `fulcra.direct-link` label. It can remove its own line, or give itself a direct link to any chat. Only the main assistant role (`fulcra.seat`) is protected.
- Fulcra removes the role label from an old main assistant chat only when this controller set that label, or when the chat shows in the project list. A label that another build set, on a chat with no project record, can stay. Then Fulcra refuses sends to the main assistant, because two chats have the role. It does not guess. To fix this, archive the old chat. Fulcra does not route to archived chats.
- If the chat that holds the main assistant seat is archived or deleted, Fulcra writes the role again every minute and records each try. Choose a new main assistant to stop this.
- On-device dictation can repeat a few words in a rare case, when the recognizer changes the first word of a long partial result.

## Important

- **Codex Full Access runs commands without approval prompts. Fulcra cannot check credential access, destructive Git actions or publishing before they occur in this mode.**

## What we tested

- We installed the signed app on the Mac mini. The daemon is healthy. In the real app, "Make main assistant" seated the main assistant, removed its old parent, and left exactly one holder. The reporting-line rules refused and allowed sends as expected.
- We installed the signed app on the MacBook. The daemon is healthy, all sessions are listed, and a bundled plugin read works.
- We ran the main assistant migration on a copy of the Mac mini's real Command Centre data, with no provider available. It labelled exactly one chat, and it added nothing after a restart.
- The packaged app started a scratch daemon on the MacBook and opened a project. We did not run the Deploy check for this release, because Docker was not running.
- One fresh review of all 0.2.8 changes found blockers. We fixed them and checked each fix again until the review found no blockers.
- The type checks, the lint check and all automatic test jobs pass. The sidebar tests measure the layout at five screen sizes.
