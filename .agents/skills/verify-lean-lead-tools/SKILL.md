---
name: verify-lean-lead-tools
description: Check lead catalogs, group selection, quiet refresh, and lifecycle reports with scratch daemons.
---

Use a scratch HOME and ORCA_HOME. Keep the live daemon and live configuration unchanged.
Use the project slot wrapper for heavy commands.

1. Build the protocol and CLI dependencies with the project commands.
2. Run the policy, runtime MCP, MCP server, agent MCP, native intercom, and MCP parity test files.
3. Run `agent-manager.test.ts` with `-t 'lead preset|quiet MCP|MCP label filtering'`.
4. Run the server type check and lint the changed files.
5. Confirm that `lead` exposes the 12 daily tools when a native report origin exists.
6. Confirm that absent tools fail through both HTTP MCP and the native catalog.
7. Confirm that optional groups appear after quiet resume and disappear after removal.
8. Confirm that workers cannot set reserved selection labels through any tested entry point.
9. Confirm that permission, finish, error, queue, restart, inbox, acknowledgement, and archive tests pass.

For a real provider capture, use `packages/server/scripts/measure-lean-lead-tools.ts`.
Supply the same task JSON, model, relay, and provider home for both `on` and `lead`.
The task JSON contains `scratch`, `model`, and `prompts`.
Set `LEAN_MEASURE_RELAY` to the local capture relay.
Set `LEAN_MEASURE_PROVIDER_HOME` to the authorized provider home.
Supply an authorized credential in `LEAN_MEASURE_CREDENTIAL` only when native login is unavailable.
Keep credentials in memory. Do not write credentials or request headers to reports.
Keep both daemon state and generated skills inside the scratch HOME.

Compare provider tool names, schema bytes, first input, cache writes, cache reads, and output usage.
Use the provider token-count endpoint with the captured schemas to measure definition tokens separately.
Use identical messages and unchanged native tools for both token-count requests.
Report byte-based token estimates separately from measured provider counts.
