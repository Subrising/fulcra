# Portable Command Centre configuration

The trusted host supplies `ORCA_HOME`, or supplies `PASEO_HOME` and uses its `command-centre` subdirectory. No other installation root or legacy machine default is consulted. Paths must be canonical, absolute and owned by the current user; the state directory is mode 0700 and config/catalog files are mode 0600. First run atomically creates missing files without replacing existing data.

From the built controller package run `node dist/tools/init-config.mjs` with that environment. The host can instead import `firstRun` from `dist/src/config.mjs`. Edit the single `config.json` and restart the controller and plugin together after changing identity or routing settings.

| Setting | Type and default |
| --- | --- |
| `version` | Exactly `2` |
| `daemon.url` | WebSocket URL or `null`; default `null`. The trusted host must supply its endpoint; no fixed port. |
| `authority.companyId`, `authority.programmeId` | Fresh UUIDs generated on first run |
| `authority.issueApi` | HTTP(S) base URL or `null`; null uses the private local `tasks.json` catalog |
| `providers` | `claude: "claude"`, `codex: "codex"`; provider-qualified selections supported, existing provider policy still applies |
| `localHost` | `{name: "This Mac", serverId: null}`; host identity is explicitly configured/discovered by the host |
| `hosts` | Zero to 64 remote `{name, serverId, sshTarget?}` records; default `[]`. Names and non-null server IDs must be unique, including the local host. |
| `defaults` | Existing optional `thinkingOptionId`, `modes`, `ask`, `models` settings; default `{}`. Provider policy validation remains in `provider-mode.mjs`. |
| `artifacts` | UUID-keyed arrays of relative artifact paths; default `{}` |

Objects reject unknown fields. `all` and `unknown` are reserved host names. URL credentials and URL fragments are rejected. SSH targets are configuration metadata; the portable controller refuses remote execution because the legacy remote transport is outside v0.2.

Journal, operator secret, grants, process lock, socket, task working directories, receipts and memory all derive from this root. The controller does not need Python. A mode-0600 exclusive process lock prevents competing children; after a crash the supervisor must establish that the old child exited before recovering that lock or socket. Never recover these automatically merely because startup failed.

The controller's own `package.json` and lockfile declare the published client, MCP SDK, zod and bcryptjs. Its bundler includes reachable dependencies and rejects imports of excluded integrations. No host `node_modules` or pinned task bundle is loaded. Bcryptjs is declared for compatibility but is not needed by the current fail-closed auth seam.

`npm run verify:portable` scans tracked portable inputs. `node tools/no-machine-ties.mjs dist` scans every packaged output file without fixture exceptions. The source gate permits only test/support fixtures to be excluded from scanning; the portable scope explicitly lists retained legacy integrations. Bundle graph checks prevent importing them back into the runtime.

V3 now verifies the authenticated trusted-host catalog and uses per-invocation plugin `ctx.management`. See [controller-host-integration.md](controller-host-integration.md) for the pure parser, child dispatcher and V4 startup interfaces. V4 owns child supervision, trusted installation, endpoint/host-ID discovery, in-tree SDK packaging and rollback. No live migration is part of this change.
