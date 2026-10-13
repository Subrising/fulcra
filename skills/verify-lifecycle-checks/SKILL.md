---
name: verify-lifecycle-checks
description: Verify compact tool results and read-only lifecycle checks in an isolated checkout.
---

Use the checkout's dependencies. Use `TMPDIR=/private/tmp` on restricted macOS hosts.
Run heavy checks with `slot-run --pool fulcra --slots 1 --timeout 60 --`.

1. Run the changed CLI and compact-result test files with Vitest and `--bail=1`.
2. Run the MCP server test file.
3. Run the report-up and held-send test files with `--no-file-parallelism`.
4. Run `control/src/control/tool-surface.test.mjs` with `node --test`.
5. Run `control/src/control/role-mcp-transport.test.mjs` with `node --test`.
6. Run the `archive safety` test in `mcp-parity.e2e.test.ts`.
7. Run `npm run typecheck`.
8. Run the npm lint and format scripts for changed files.

The socket tests use private fixtures. They need permission to open local sockets.
They do not use the main daemon or submit model work.

Check the CLI on real Git data:

```sh
node --import tsx packages/cli/src/index.ts check identity --range BASE..HEAD
node --import tsx packages/cli/src/index.ts check worktree --cwd . --base HEAD
```

Identity must pass for the new commit range.
A changed worktree must fail its clean check and return exit code 1.
Missing arguments must produce one `FAIL` line and exit code 1.
Never remove a worktree or archive a session as part of this verification.
