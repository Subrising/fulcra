# Private installation data

This directory is ignored except for this README and top-level `*.example` templates. Copy a template and replace placeholders with reviewed values for your installation. Never commit credentials, grants, receipts, controller state, pairing payloads or machine identifiers. The normal portable controller uses its existing `ORCA_HOME` configuration; these files support legacy deployment and release tools only.

Files:

- `machine-values.json`: legacy installation paths and the displayed Fulcra URL. Missing paths resolve to `/path/to/unconfigured/<key>` in JavaScript and Python deployment tools refuse clearly. Existing runtime env overrides retain priority.
- `host-probes.json`: reviewed local/remote bases, task roots, Node executable, enrolled Book prefix and SSH target. Probing requires this file and validates every path/target before spawning.
- `activation-releases.json`: reviewed legacy guard/entrypoint digests and full file closure. Missing file yields no trusted releases; verification refuses.
- `admission-base.json`: pristine native module digests used by legacy admission deployment. Required for deployment; readiness reports no baseline when absent.
- `permission-base.json`: reviewed active selector, guard and native/deny module digests used by the stopped permission overlay. Required at prepare time.
- `dependency-sides.json`: reviewed package/lock digests for both sides of a dependency switch. No default build is trusted.
- `components.json`: legacy four-component bootstrap source commits. Required unless all four explicit source checkout options are supplied. The single-checkout candidate pipeline owns its own provenance.
- `native-sources.json`: reviewed native source commits and every durable source/dist digest used by historical native staging. Missing selection refuses; passing an explicit reviewed pin remains supported.
- `personal-patterns.json`: optional owner-specific regular expressions for the no-machine-ties audit. Generic path, tailnet, UUID and server-ID detection always runs; missing file retains generic checks. Treat patterns as private owner data.
- `screens/`: newly generated control and sidebar capture output, kept private until explicitly reviewed for publication.
- `archive/`: untracked historical screenshots, e2e video evidence, and mutation receipts, retained only as private evidence. These are never runtime input.

For the owner's existing installations, an external private snapshot was captured before removing/editing originals. Run `release/populate-local.sh /path/to/private/local-snapshot` to copy its `config/` files into a new checkout. The script refuses to overwrite any existing configuration and changes no service. Archived source/evidence lives at its original relative paths in that snapshot; it is not necessary for runtime.

`ORCA_MEMORY_RUNTIME` selects the legacy memory-status PID-log directory; `ORCA_ADMISSION_HOME` can select the guard home before staging. A staged guard binds its home explicitly using the existing native release hooks. Runtime names and data directories remain migration-sensitive.

Machine-value keys:

- `legacyControllerHome`: Legacy controller home (includes grants, journal and tasks).
- `openclawConfig`: Existing OpenClaw configuration file.
- `conversationInstallHome`: Conversation release selector home.
- `conversationSkill`: Installed conversation skill path.
- `watchLaunchAgent`: Owned watcher LaunchAgent profile.
- `conversationReleaseRoot`: Historical immutable conversation releases.
- `openclawCache`: OpenClaw writable cache directory.
- `openclawTmp`: OpenClaw writable staging directory.
- `nodeExecutable`: Private Node executable.
- `watchPath`: Watcher service PATH (colon-separated executable search path).
- `watchLog`: Watcher stdout log.
- `watchErrorLog`: Watcher stderr log.
- `legacyActivationSelector`: Legacy admission active selector file.
- `legacyControllerSocket`: Legacy controller socket path.
- `paseoHome`: Existing daemon state home.
- `daemonClientSdk`: Reviewed daemon client SDK module.
- `healthInstallHome`: Health monitor install home.
- `healthLaunchAgent`: Owned health monitor LaunchAgent profile.
- `conversationQueue`: Conversation queue SQLite file.
- `nodeRoot`: Reviewed private Node runtime root.
- `healthLog`: Health monitor stdout log.
- `healthErrorLog`: Health monitor stderr log.
- `nodeInstallHome`: Private Node runtime installation parent.
- `legacyProductRoot`: Legacy product checkout/dependency root.
- `watchedControlReleases`: Owned historical control release watch root.
- `watchedEvents`: Owned historical event modules watch root.
- `watchedControllerSource`: Owned historical controller source watch root.
- `memoryRuntime`: private legacy memory-status PID-log directory.
- `fulcraUrl`: Owner-configured Fulcra URL shown by the conversation command.

- `acceptancePasswordFile`: existing installed-app credential filename, read only by an explicitly invoked acceptance run.
- `acceptancePluginRoot`: installed-app acceptance tooling source root.

- `legacyOldConfigReader`: read-only historical configuration reader for W1 compatibility fixtures.
- `legacyOperatorJob`: read-only historical fixture bundle root for W1 compatibility fixtures.

## Local release configuration

Local release settings and receipts belong here or in an explicitly configured private output directory. Copy `release.env.example` to `release.env`; every non-example file in this directory is ignored. This trusted shell file can select executables, so use only your own reviewed local configuration. Keep credential values in their existing protected stores.
