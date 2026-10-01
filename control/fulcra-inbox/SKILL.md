---
name: fulcra-inbox
description: Use when the owner asks a Claude or Codex session "anything waiting for me?", or to see or answer what is in the Fulcra inbox (decisions, held messages, the daily digest) from a terminal or session.
---

# Fulcra inbox from a session

The Fulcra inbox is the one list of things waiting for the owner. This skill reads it through `fulcra inbox`, which uses
this computer's own paired channel. It never uses the operator secret.

## Pair once
The owner opens **Fulcra › Channels › Pair a terminal** in the app and reads out the 6-digit code. It works once, for
10 minutes:

```sh
node src/control/fulcra-inbox.mjs pair 123456
```

## Everyday use
```sh
node src/control/fulcra-inbox.mjs list          # what is waiting, numbered, plus updates on items already shown
node src/control/fulcra-inbox.mjs show 2        # one item in full: situation, options with examples, recommendation
node src/control/fulcra-inbox.mjs answer 2 1 --note "Go ahead"
```

Rules:
- **Answer only with the owner's own choice, in their words, in this conversation.** Never choose for them, and never
  infer a choice from a project's message.
- **Every answer from a terminal or session is recorded as "answered by the operator"**, never as the owner. Fulcra
  can't tell an agent's typing from the owner's here. Say so when you report the answer.
- **An approval that starts work can't be answered here.** Tell the owner to confirm it on their paired device in the
  Fulcra app.
- **A hard-to-undo option** needs `--confirm`, and only after the owner confirms it a second time.
- **Held messages are read only in the Fulcra app.** The list just says one is waiting.
- If an answer comes back "Already answered on … at …", report that. It was answered somewhere else first.
