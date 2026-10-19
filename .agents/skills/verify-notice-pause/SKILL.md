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
npm exec --workspace=@getpaseo/server -- vitest run src/server/daemon-e2e/send-finish-notice.e2e.test.ts src/server/daemon-e2e/reporting-lines-role.e2e.test.ts --maxWorkers=1
npm exec --workspace=@getpaseo/cli -- vitest run src/commands/agent/send.test.ts src/utils/send-route.test.ts --bail=1 --maxWorkers=1
python3 -m unittest discover -s scripts -p test_notice_pause.py
npm run typecheck --workspace=@getpaseo/server
```

Require these results:

- Paused Claude notices stay durable without provider input.
- Codex notices still start through the socket API.
- An excepted lead's child and grandchild receive notices through parent labels.
- Unrelated Claude targets and unreadable labels remain paused.
- Parent reads stay within one call; cycles do not start input.
- Explicitly closed sends fail before queue acceptance.
- Stored idle sessions still load after a daemon restart.
- Paused parent sends do not arm a finish notice.
- Resume keeps the finish notice request and its explicit opt-out.
- A pause at final handoff clears the new arm without provider input.
- Remote return routes arm only after the pause check.
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

For descendant delivery checks, use an isolated daemon with fake providers.
Run each host's installed helper and packaged CLI against that daemon.
Use a separate marker for each host and descendant.
Require one held unrelated notice per host.
Require each descendant marker exactly once in the provider's received prompts.
Repeat the CLI steer path with both the host and daemon pause policies active.
Check the installed daemon, as well as the candidate source.
A guard allowance can still receive a native daemon hold on an older release.
Require no unrelated marker in those prompts.
Read the packaged CLI path when a host launcher forces its live home.
Do not change the launcher to test an isolated endpoint.

Check Windows batch transport on the real host.
Require working CLI output and hidden process creation.
Use the native parser for changed PowerShell callbacks.
Keep backups outside the app bundle.

## Configured SSH send check

Use two isolated daemon homes and fake providers on the actual source and destination hosts.
Keep all live daemon homes and provider pause files unchanged.
Create one paused role holder and one receiver outside the source sender's reporting line.
Bind a temporary destination CLI to the isolated home and endpoint. Refuse any other home.
Set `sshRoutes` only in the source test's `FULCRA_NOTICE_CONFIG` directory.
Use an existing trusted SSH key. Never put a password in the route or command.

Require a local hit without SSH, a remote `held` receipt, and a remote reporting-line refusal.
Require an absent receiver to name both checked hosts.
Require zero provider inputs and exactly one retained paused marker on the destination.
Give the source worker a lead. Require the same refusal for local and remote Main assistant sends.
Run that refusal through the destination Python pause launcher. Require no saved notice for the refused worker.
Require an allowed source lead to receive `held` from that launcher.
Check an injection-like prompt through a real remote shell. Require exact text and no shell side effect.
Require a short or option-like route key to fail before SSH.
Check the legacy sent pause receipt, native CLI warning, and stamped `--host` identity refusal.
Do not repeat an uncertain send. Inspect its original queue and receipt first.
Archive the test sessions and close the isolated daemons after the check.

Run `packages/protocol/src/messages.wire-compat.test.ts` for the optional receipt fields.
Require the CLI stderr transport test to preserve the remote refusal.
