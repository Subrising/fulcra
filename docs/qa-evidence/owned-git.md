# Owned Git process checks

Date: 18 October 2026. Base: `1ee55c99`. Issue: FU-350.

The incident logs identify `workspace-git-service` background fetches. PID 52344 recorded 78 fetch timeouts and three other fetch failures.
The timeout stopped the direct child. Credential helpers could remain alive while the next scheduled fetch started.

The shared helper now owns daemon, desktop, CLI, plugin, controller, and architecture-tool Git calls.
It sets noninteractive credential and SSH controls for each child. It leaves global Git settings unchanged.
Windows uses a retained Job Object with a separate deadline. Git starts suspended and joins the job before it runs.
The job closes on completion or timeout. It also contains descendants whose Git parent exits first.
Each process admits at most eight owned Git trees. Bundled copies share this limit.
Unix Git groups also register with the existing supervisor, so daemon shutdown can remove them.
Fetches share one repository key across worktrees. Failures cause exponential delays; authentication failures require an explicit user retry.
Missing-ref fallback remains available within a requested checkout. Different stdin blob requests remain separate.

## Checks

- Thirteen focused policy tests passed, including environment, single-flight, backoff, cancellation, cap, and tree cleanup.
- Forty-five daemon and worktree tests passed.
- All 141 selected controller, architecture, connector, and deploy tests passed.
- Workspace type checks, changed-file lint, and formatting passed.
- All 57 SDK boundary checks and 76 compiler checks passed.
- The actual Command Centre build passed against the updated SDK.
- One fresh risk review passed after its listed repairs.

The Windows authentication endpoint returned HTTP 401. The scratch repository used GCM with no matching stored credential.
A five-minute run rejected 3,150 concurrent and repeated requests. Only the first fetch reached the endpoint.
Its three HTTP requests were authentication exchanges. Later requests remained paused.
Authentication failed in 1.236 seconds. No new credential or console window appeared during 305 seconds of desktop observation.
Worker private memory changed from 65,048,576 to 68,812,800 bytes. Other owners' processes remained untouched.
Host-wide Git and GCM counts peaked at ten and twelve. These totals include unrelated processes.

The final boundary check used the final compiled helper. It refused a ninth child while eight owned calls were active.
A detached descendant remained alive after its parent exited. The 1,800 ms deadline stopped the tree.
A second check wrote two MiB through the synchronous adapter. Its deadline also removed the descendant.
The saved JSON contains samples, final boundary results, and the compiled bundle hash.
The published SDK entry also passed asynchronous and synchronous Git calls on Windows.

The logs prove GCM attempted to create credential UI. They do not prove the source of each repeated console window.
The old shared launcher already used `windowsHide`. Some direct probes lacked it.
All owned Git launches now hide their windows. Native Windows Git also uses `CREATE_NO_WINDOW`.

## Existing portable-build limit

The optional standalone portable build rejects hoisted Zod and protocol inputs on both the base and this candidate.
The source snapshots produced the same dependency-scope failure. No scope exception was added for those dependencies.
The candidate permits only the three new, self-contained Git modules in that build.
This check does not establish portable-release acceptance.

No live daemon was restarted. No installed application was changed.
