# Command Centre packaging design

Fulcra v0.2.0 ships the Command Centre source in the consolidated repository. The public release is source-only: no signed/notarised binary or public installation asset is provided. Use [Build, launch & pair](getting-started.md) for the current entry points. The Round/V4/V5 sections below are historical engineering records, not the current release installation or acceptance checklist.

## Ownership

The trusted in-process contribution owns the controller child, its inherited transport and its epoch. The ordinary plugin renders the UI and receives management authority only per authenticated invocation. It never supervises the child or receives a provenance issuer. This replaces the earlier ordinary-plugin supervision plan.

The app setting is off by default. A toggle restarts the background service: synchronous admission hooks cannot be removed beneath a running controller. Startup must verify the ordinary bundle and registered bridge before enabling management.

## Authentication decision

Use a generated daemon password stored in a dedicated `ai.fulcra.command-centre.*` Keychain item. It allows an app that restarts to reconnect to a daemon that kept running. An inherited-descriptor owner channel would need a separate authenticated reconnect design; it is not the selected desktop authentication mechanism. The controller still receives no daemon password: its service session belongs to the host.

Do not replace an existing user-configured daemon credential. Keychain failures must leave the setting disabled and show an actionable error. Automated verification uses a fake Keychain or dedicated `ai.fulcra.test.*` items, never a user's real items. Paired-device authentication is a later feature.

## Release boundary

Build controller dependencies against the same in-tree protocol/plugin/client commit as the app. No SDK publish is needed. Bundle dependencies rather than resolving through ancestor or user-installed node_modules. Keep private state in the daemon home, outside the immutable app resources, so replacing the bundle preserves it.

The approved additive service frames carry the host's real welcome, validated public events and epoch closure. The host admits the service session; the child SDK's hello stays local. Management and provenance stay on their separate typed channel. Before the SDK installs listeners, the host retains at most 64 frames and 8 MiB; overflow revokes the epoch. Host-only event frames also have an 8 MiB limit: catalogs include plugin client code, so three ordinary bundles can exceed 2 MiB even with no sessions. Management, provenance, boot, replies and child requests retain the 1 MiB frame limit; depth 32, strict fields and epoch checks are unchanged. Closing invalidates subscriptions and a replacement child starts a fresh session.

Run `node scripts/package-command-centre.mjs <reviewed-controller-checkout>` from the product checkout through the required build scheduler. This builds the protocol/plugin/client, verifies the ordinary plugin boundary, bundles the host and child with Node builtins as the only externals, then stages an unsigned app. It never publishes an SDK. The runtime reads hash-checked precompiled plugin halves and refuses a missing or mismatched manifest; it does not fall back to ancestor node_modules.

The server build copies the repository's `skills/` catalog into `dist/server/skills`.
Desktop packaging also maps `skills/` explicitly to that server catalog inside
`app.asar`; dependency collection alone did not carry it into the 8f build.
Generate a new standalone builder config from the candidate's base YAML when this
fileset changes; copying an older config's `files` list omits it. Keep the six
`paseo*` skill directories byte-identical
to upstream v0.10.2; Fulcra guidance belongs in `skills/fulcra`, not in those files.
After installing the candidate on **each Mac**, open **Settings → your host → Agents →
Orchestration skills**, include **fulcra** in the selection, and install or update it.
Verify `~/.claude/skills/fulcra/SKILL.md` and `~/.agents/skills/fulcra/SKILL.md` match the
candidate's bundled file, then verify Claude and Codex discover the skill in a new
session, with exactly one `/fulcra` entry in Codex. Codex discovers the shared
`.agents/skills` copy; do not install a second copy in `.codex/skills`. An existing
custom selection does not acquire Fulcra automatically; the default All selection
includes it. Installation does not grant a role or controller authority. Record
both hosts' discovery during the packaged smoke; a source test is not installed proof.
Retire the old user-installed `orca-work` link explicitly during the upgrade smoke;
the installer does not remove a skill it does not manage or delete the link's target.

The packaged worker derives `bundledPluginsDirectory` from its own app Resources directory when enabled. Persisted configuration cannot supply that path. The desktop keeps the generated password in Keychain and passes only its bcrypt hash to the service supervisor; the controller child receives neither. The renderer never receives the generated bearer. Main attaches an Authorization header only to WebSocket handshakes from a registered top-level paseo://app window to the exact current owned numeric-loopback endpoint. It does not inject a bearer subprotocol, which could be reflected to renderer code. Explicit user-password connections keep their own authentication.

## First open of an unsigned Mac build

These steps apply only after a staged build passes its release checks and a download is provided:

1. Move the downloaded Fulcra app to your Applications folder.
2. Open it. If macOS blocks it because the developer cannot be verified, open System Settings → Privacy & Security and choose Open Anyway for Fulcra. Confirm Open when prompted.
3. Open Fulcra Settings and enable Command Centre. Enabling it will restart its background service.

Do not disable Gatekeeper globally. There is no Apple signing or notarisation for this build yet.

Closing a window leaves the background service running. Enabling Command Centre forces the effective keep-running preference on without overwriting the previous preference; disabling restores it. Logging out or rebooting ends the processes; reopening the app starts the service using its existing private state. V4 adds no launchd agent. These lifecycle claims still require the staged-bundle proof before release.

## HTTP dependency compatibility

Keep `qs` at the patched 6.16.0 floor for CVE-2026-82417 (GHSA-4mjr-xmp4-gh2g). The older body-parser 1.20.6 and Express 4 query-parser ranges excluded that version, even though npm applied the security override; electron-builder resolves declared production ranges separately and could not collect the package. Express 4.22.3 and body-parser 1.20.8 both declare `qs ~6.16.0`. Update those parents instead of weakening the override. The lockfile regression checks the collector-compatible ranges and every locked qs copy; the HTTP behavior regression checks hostile query serialization and ordinary parsing.

The collector preflight also checks the complete desktop production tree. The server declares markdown-it 15.0.2 to match the existing security override and installed runtime; leaving its historical `^10` declaration prevents collection even though npm already installs 15.0.2. This changes metadata, not the resolved parser version.

## Round 8 staged status

The unsigned Round 8 build passes the staged shipped path with fake Keychain and a short private home: authenticated management, the actual Command Centre window rendering a fixture project/task, unauthenticated WebSocket close 4401, typed hook refusal with no native dispatch, uncertain pending management after the owned child is killed, bounded restart into a new epoch, serving after app quit, and clean disable. The validated unsigned bundle and its full-tree hashes are retained in the job's `artifacts/v4` directory. Independent trust-root review and a fresh-Mac trial remain separate release gates.

The labelled upgrade check replaces only the controller resource, then requires observed management health and the previously saved retention setting. It passes on the same private state; it is not a second versioned app build. Resources are restored afterward. V5 must preserve this distinction if testing a real two-build upgrade.

Round 8 proved the initial-probe and management-envelope repairs; Round 9 replaces its renderer credential handoff with main-only header attachment. The new boundary requires integration-candidate shipped proof before release. Argument-free plugin management commands include explicit JSON null input. The staged proof exercises both repairs in the shipped app. The accepted v0.2 host-event bound is 8 MiB with a finite queue; child requests and management remain 1 MiB. Catalog paging is backlog L17.

The whole-output audit passes with exact reviewed generic matches and three approved upstream PEM/header false positives. No personal-path or credential pattern was weakened. Dependency prepare/pin tooling is retired; dependency-switch.py is retained outside the shipped graph because historical overlay and provider repair routes still import it; unexercised provider patch and activation routes remain outside the shipped resource graph pending their separate parity coverage.

## v0.2 trust model and availability limits (Round 9)

The generated secret is stored using `/usr/bin/security`. Its default Keychain ACL trusts that creating binary: another process running as the same macOS user can invoke it to retrieve the item without a prompt. This is a same-user boundary, comparable to a private 0600 file, not isolation from malicious same-user processes. Signed-app Security-framework creation with an app-signature ACL is backlog L18. Bundled-file hashes likewise detect corruption, not a same-user writer replacing both manifest and resources.

Main-world plugins can still act through the app's existing connection and desktop APIs. The main-only header prevents exporting the persistent generated password; it does not isolate plugin execution. Ordinary plugin disable does not override the trusted distribution contribution: use Settings → Enable Command Centre to stop the distribution and its child.

Child output uses a dedicated length-prefixed pipe with a 1 MiB pre-parse limit; host input retains the 8 MiB bound. Password verification yields asynchronously with at most four concurrent checks. A controller ready for 60 seconds resets its restart budget; repeated rapid crashes remain bounded. Plugin catalog entries above 1 MiB encoded JSON fail loading visibly. Aggregate catalog paging and oversized non-catalog broadcasts remain L17; the per-entry check is not an aggregate paging implementation.

Round 9 is source repair and focused evidence only. The accepted Round 8 artifact is unchanged; the next release-candidate build comes from the integration branches and must repeat the real shipped-path proof and exact audit.

### Integration contract follow-up

The renderer asks main only for a boolean connection preflight; it cannot obtain the daemon credential. Missing credentials and a starting daemon fail visibly before socket creation. Explicit 4401 stops automatic retries until the user retries. Desktop startup refreshes and selects the current numeric endpoint even when the host was previously stored. Generated credentials are created only during start, and an enabled owned launch removes ambient PASEO_PASSWORD so main and the worker agree on persisted auth or the generated Keychain credential.

Controller lifecycle status and Retry use authenticated per-request management and the same one-use dispatch fence. Ordinary controller operations still require ready state. The service handshake has 15 seconds, followed by a bounded 180-second startup phase; management requests have 15 seconds inside the 50-second plugin RPC window, while invocation authority still expires at 30 seconds. Service frames carry version 1. Closing the child's SDK transport closes its owning epoch.

Round 9b source checks cover desktop bundle pinning (D27) and uncached credential correctness (D29-correctness). The integration candidate must still prove a modified second-host plugin shows “Plugin not trusted on this Mac” in the real window. Credential caching is deferred as D29-cache (performance); it is not in the candidate. See [Desktop plugin trust](plugin-trust.md) for the owner-rights boundary. Full isolation remains L21.
