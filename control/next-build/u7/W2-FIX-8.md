# W2 candidate-8 fixes

Codex A→B→A resumes the same native thread. The missing product behavior was the
per-session Codex usage path: only Claude supplied account usage. The product
companion reads the running Codex session's native quota, with the account label
captured separately at create/resume. Runtime replacement fences attribution;
read failure returns labelled unavailable usage, never the Mac account's figures.
No credential file is read and no permission defaults change.

Claude's pending request reached the daemon, but the wire attention flag only
reflected unread finished/error attention. The companion projects pending
permissions ahead of that flag, without persisting a stale permission badge.
The existing Sessions/Today model already prioritizes pending permissions.

## Gates for gates-9

Run under the team heavy-lock with a staged Fulcra.app and scratch ports:

```
node control/next-build/u7/gate-switch-continuity-codex.mjs <Fulcra.app> <fresh-label> <port>
node control/next-build/u7/gate-pending-permission.mjs <Fulcra.app> <fresh-label> <port>
```

The first is W2's Codex half of W1's `switch-continuity` gate. It calls the same
packaged RPC as the picker (account ID) and `/account` (name), using one chat.
It checks marker recall from the actual shared transcript, native thread identity,
canonical timeline sequence ranges/content/epoch, no extra chat, and the account
and usage label with native quota attribution. It does not claim visual clicking.
The Codex stub lives beside the gate; all auth files and homes are scratch-only.

The second is focused N for both Claude and Codex: pending credential permission sets attention=true
and reason=permission; denial clears permission attention. Other unread attention
may remain. It uses the existing gate-modes Claude stub, never a real CLI/Keychain.

Set `U8_PROBE_CLIENT` to the candidate's client bundle (candidate-8 or newer);
this input is required. Older clients discard the
usage request's agentId, so the Codex gate refuses them. `U8_GATE_OUT` selects the
evidence root, default /private/tmp/fulcra-u8-gates. Each gate prints PASS/FAIL and
writes result.json plus scratch daemon logs, then removes only its own scratch home.

Verification results and resource-admission limits are recorded in U7/FIX-8-STATUS.md
and the W2 task's evidence/u8-\* files. R1 and the packager retain candidate-9 gates.
