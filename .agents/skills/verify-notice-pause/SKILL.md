---
name: verify-notice-pause
description: Verify paused completion notices, sender grouping, and safe resume in Fulcra. Use for changes to notice admission or host guards.
---

# Verify notice pause

Read [the notice policy](../../../docs/notice-pause.md).

Use isolated daemon homes and fake provider clients for resume tests.
Keep real provider pauses active unless the owner authorizes resume.
A test must not start a real Claude turn.

Run the changed trust suite through the project slot wrapper:

```sh
npm exec --workspace=@getpaseo/server -- vitest run src/server/held-sends.trust.test.ts --maxWorkers=1
npm exec --workspace=@getpaseo/server -- vitest run src/server/daemon-e2e/reporting-lines-role.e2e.test.ts -t 'paused PC completion' --maxWorkers=1
python3 -m unittest discover -s scripts -p test_notice_pause.py
npm run typecheck --workspace=@getpaseo/server
```

Require these results:

- Paused Claude notices stay durable without provider input.
- Codex notices still start through the socket API.
- Resume combines notices within each sender.
- Queue restart retains paused notices.
- Final handoff stops a pause race.
- A delivered message ID does not enter the queue again.
- Plugin and native capabilities keep their existing safeguards.

For an authorized host check, record receiver status, update time, and usage before the notice.
Require a `held` receipt and a stored notice.
Require unchanged receiver fields after the notice.
Use one two-byte marker job with GPU 0 and a small RAM claim for PC queue proof.
Retain its job ID, exit code, marker, and queue receipt.
Check the queue before submission. Do not replay an uncertain submission.

Check Windows batch transport on the real host.
Require working CLI output and hidden process creation.
Use the native parser for changed PowerShell callbacks.
Keep backups outside the app bundle.
