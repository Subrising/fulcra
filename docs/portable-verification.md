# Portable setup acceptance

The portable increment adds an opt-in `ORCA_HOME` contract. Legacy deployments retain
their existing behavior without it. The acceptance target is a new local machine
installation with the full controller/workspace/conversation/memory composition.
Remote enrollment, mobile packaging, provider account login and model execution are
outside the verified increment.

## Reproduce focused checks

Build the native checkout with `npm ci`, `npm run build:server` and
`npm run build:daemon-web-ui`. Use matching clean component checkouts:

```sh
node --test scripts/orca/bootstrap.test.mjs
node scripts/orca/integration-test.mjs RUNTIME_CHECKOUT CONVERSATION_CHECKOUT WORKSPACE_CHECKOUT
node scripts/orca/smoke-test.mjs RUNTIME_CHECKOUT CONVERSATION_CHECKOUT WORKSPACE_CHECKOUT
```

The integration test uses a fresh private home, the real controller/RPC/SQLite and
workspace backend, and a fake native provider. It creates exactly one saved
coordinator, deduplicates its creation, promotes it to a supervisor and revisits it
through a new conversation client. It checks task ancestry revocation, the workspace
catalog/management/board, current/history memory MCP, outside-root denial and refusal
to overwrite user data. It sends zero model instructions.

The macOS startup smoke reuses the completed build from the same native checkout:
compiled `dist` trees are copied and dependencies linked into a separate temporary
home. This avoids rebuilding unchanged dependencies while exercising the new
composition boundary. It stages the real admission hooks and starts the actual
supervisor, daemon, plugin and locked controller. With a fake OS home and fake
provider credentials, it verifies authenticated plugin catalog/management RPCs,
the bundled browser HTML, conversation list and host observation. It then terminates
only its own launcher and retains a JSON receipt and logs in its printed temporary
path. It requires the test port 54871 to be free. No provider turn is executed.

## Observed results

- Native dependency installation, server build, browser export, repository typecheck,
  focused script lint and formatting passed.
- Bootstrap refusal/configuration test passed. Fresh-home integration and real
  startup smoke passed; zero model turns.
- Runtime memory/home/controller/native-hook tests: 44 passed. Staging path and
  authority-journal preservation test: 1 passed.
- Conversation client/host tests: 46 passed.
- Workspace backend source bundled and ran in the integration and installed plugin.
  The subsequent combined candidate corrected the navigation adapter type boundary;
  workspace typecheck and all16 focused task/catalog/navigation cases passed.
- An expanded run also hit four existing command-workspace fixture failures: those
  fixtures omit the native fence identity required by the controller. The maintained
  conversation client fixtures and fresh integrated path passed. These old fixtures
  need repair by the owning integration lane before a broad suite can be green.
- `npm ci` reported 50 dependency audit findings (4 low, 15 moderate, 31 high) in the
  accepted native dependency graph. This task did not change dependencies or apply
  automated audit fixes. Release integration must triage the actual distribution.

Independent review and final ADW release approval remain with the integration owner;
this task did not create reviewer sessions or claim independent acceptance. Linux,
real provider login/turns, remote enrollment and installed mobile clients remain
unverified. The component commits must be made available in the private repository
before the default pinned installer can download them.
