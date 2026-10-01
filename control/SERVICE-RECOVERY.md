# Owned Mini service recovery — AIN79

The user asked to continue implementation while Claude is unavailable. Add login-time launchd supervision for the existing owned Paseo host and controller. Independent review stays pending. This does not reboot the Mac, restart main OpenClaw, take over another owner's service, or create model work.

## Design and limits

Use two user LaunchAgents, `ai.orca.paseo` and `ai.orca.controller`, with30second restart throttling. The launcher validates the exact deployed profile, required existing state and pinned entry files, then execs the existing Paseo supervisor or controller process.py. Native PID/advisory locks retain single ownership and stale-socket recovery. No new lock protocol, timer-driven model, credential store or delivery journal is introduced. Missing volume/state or changed pins fail before the native entry, so an empty replacement organization is not created.

The controller can start before Paseo; native admission verification/connect fails and launchd retries later. On Paseo boot change, existing boot-bound delegated authority remains invalid until the existing explicit handback process authorizes it. Recovered availability does not imply automatic resumption of delegated work. Native output/history is never replayed by this launcher.

The user and same-UID deployment publisher are trusted. File checks are operational integrity checks, not isolation against a malicious local owner racing filesystem changes. Interpreter/dependency upgrades require deployment verification; only the listed entry/admission/controller files are pinned, not every transitive dependency. The existing private Tailscale8443→6791 route and normal authentication remain intact. User LaunchAgents start after login, not before FileVault unlock; a physical machine reboot is not part of this acceptance.

## Deployment and rollback

Save the exact current journal via SQLite backup and record saved-session IDs/modes, native identities, configs, process identities and tailnet route. Require all19 enrolled sessions human, no active/pending owned turns and empty Discord bindings. Generate an immutable service release with launch.py and a profile referencing only the current owned bundles. Keep credentials in their existing files. Render plists and validate with plutil; register only the two named user services.

Transfer the controller first: stop its exact previous owner normally, bootstrap its LaunchAgent, verify fresh PID and authenticated observe/list plus identical journal. Kill only the now launchd-owned idle controller once and require automatic restart with preserved history. A concurrent second process must lose the existing advisory lock.

Transfer Paseo through its supported lifecycle shutdown under the exact owned home, then bootstrap its native supervisor LaunchAgent. Keep the new controller service registered so it reconnects/retries normally. Verify actual host health, loaded admission receipt, unchanged configuration and saved native identities, UI outcome RPC and human ownership. Do not certify full host recovery from a listening port alone.

To pause or roll back, `launchctl bootout gui/501/ai.orca.controller` and `launchctl bootout gui/501/ai.orca.paseo` stop these services; removing only their plist files prevents next-login startup. An ordinary stop or SIGTERM while KeepAlive remains loaded restarts the service by design. Start the former explicit immutable entries against CURRENT state when needed. Never restore old journal/config over newly saved work. If a takeover fails, retain service logs and diagnose the exact process/lock; do not delete an active owner's lock.

Logs are `~/Library/Logs/Orca/controller.log`, `controller-error.log`, `paseo.log`, `paseo-error.log`. A startup refusal records its reason without credential contents. Launchd status and authenticated RPC checks are the availability evidence. Automatic phone error alerts and comprehensive service SLO monitoring are separate remaining work.
