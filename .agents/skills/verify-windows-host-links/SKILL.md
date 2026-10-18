---
name: verify-windows-host-links
description: Check Windows durable host-link receipts without changing a live daemon or its grants.
---

# Windows host-link receipts

Read `docs/host-links.md` before this check.
Use scratch files. Do not install an app, restart a daemon, or apply live grants.

## Done rule

The fixed host-link, commit-failure, and provisioning tests pass.
The production Windows commit passes on the real PC with an owner-only ACL.
The existing POSIX file-flush, rename, and directory-flush tests pass.
Typecheck, lint, formatting, and hooks pass for the candidate.
Live worker creation and finish delivery require a separate check after release.

## Local checks

Check current host memory with `pick-host` before heavy work.
Keep the shared check lock and the authorized disk reserve.

```sh
npm exec --workspace=@getpaseo/server -- vitest run src/server/host-links.test.ts src/server/windows-private-file.test.ts src/server/host-link-provision.test.ts --bail=1 --maxWorkers=1
npm run typecheck
npm run lint
npm run format:check
```

If failing-first evidence is missing, retain the candidate files privately.
Restore only the original `host-links.ts` and `private-files.ts` for one admission test.
Use `-t 'Windows commits'`. Require the original Windows refusal, then restore the candidate files.

## Real Windows method check

Read the host access instructions and use the existing PC queue.
Keep the production helper source and the proof script bound to the candidate SHA.
Build the helper with the installed TypeScript compiler. It imports only Node built-ins.
The proof accepts its module path as the first argument.
Its second argument names an existing scratch directory.

```sh
node scripts/verify-windows-host-link-durability.mjs HELPER_MODULE SCRATCH_DIRECTORY
```

Copy the helper and proof script through SCP to the PC scratch directory.
Run that command inside a copied PowerShell file with `-NoProfile -ExecutionPolicy Bypass -File` and `< NUL`.
Use the queue's resource admission and retained receipt. Do not print account names or credentials.
A zero-GPU proof needs no provider account or daemon connection.
Do not terminate another queue process to get admission.

Require exit zero, `result: PASS`, all ten named checks, no missing outputs, and verified receipt hashes.
The checks cover creation, replacement, Unicode paths, binary input, ACLs, writer exit, failures, cleanup, and retained bytes.
Save input hashes, the queue receipt, result JSON, elapsed time, Node version, candidate SHA, and command exit.
PowerShell 5.1 redirection can encode the result file as UTF-16. Decode its BOM before reading JSON.

The writer-exit check does not simulate a power cut.
The persistence claim uses the documented `Flush(true)` and `MoveFileExW(WRITE_THROUGH)` contracts.
