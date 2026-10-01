# C9 host enablement acceptance

C9 selects the Keychain diagnostic/readback repair `568c631625e64b06adeb2dfb06120223a4453657`, owned app-managed restart `9a45e0f9bb7a4cbcff5a03c05c03842b9cf9e963` and staged adapter gate `018da2730496e4f92abbcab457c7d1d3e54f97cd`. Pool implementation, enrollment and initial cross-host sync remain outside C9 and HOLD.

Run the desktop adapter gate once under the existing heavy lock in packager gates-9, against the sealed candidate. It uses the candidate Electron runtime and compiled modules, an isolated HOME, fake Keychain commands and fake restart ports. It never opens a real Keychain or starts/stops a daemon.

```sh
HEAVY_ROOT_MIN_GIB=9 HEAVY_MAC_MIN_GIB=25 <heavy-lock.sh> node control/tools/w7/gate-desktop-enablement.mjs <staged-Fulcra.app> <fresh-evidence-directory>
```

Preflight actual compiled CommonJS/ASAR paths and dependencies in the candidate. Bind the receipt to the full candidate seal, source SHA/tree, ASAR hash, runner executable/runtime, gate/probe hashes, compiled module hashes and artifact dependency graph. Missing artifact paths or dependencies leave the gate HOLD; source modules and a prebuilt test host cannot substitute. The worker has not run this staged gate.

Passing this gate proves only the packaged command adapters and restart port helper. It does not prove actual daemon-manager stop/start wiring, Settings enablement recovery, foreign adoption, real Keychain or MacBook behavior. Packager/prime must retain separate bound integration evidence that the actual compiled manager stops the captured owned lifetime, refuses replaced/unowned targets and launches through the app with desktopManaged/authentication preserved.

A runs fresh focused fake-interface suites on its composed source for auth/Keychain, restart helper and the changed daemon-manager. Bind exact source/input hashes, command/config/runtime, output and exit status. Prior 14/14, 5/5, 21/21 counts and targeted lint are session-reported; retained raw logs and run-to-source bindings are unavailable. They do not replace these fresh receipts. Typecheck remains HOLD.

Prime alone performs C9 MacBook app enablement/recovery acceptance on the same connection and supplies sanitized app-context create/write/readback status and exit codes, Fulcra-owned ACL/trusted-app metadata, exact installed source/seal/home/port-owner and rollback evidence. No historical failure cause is established. Preserve the old home/history/pairings until copy/import is reviewed; credentials and daemon identity are never merged. Never use /login, claude auth status, secret reads, or orphan kill/adoption. Historical candidate 7 evidence does not establish C9 behavior.

## Future pool prerequisites

The independent scratch probe `prove-owner-host-primitives.mjs` and its limited evidence are outside the C9 selection. Its local Node receipt is not packaged TLS, coordinator, writer-lease or activation proof. Do not add a pool run to C9 gates-9 or claim cross-host acceptance from adapter receipts.

Keep owner-host enrollment separate from the revocable account-pool-sync grant and daemon-only credential channel; client accounts.manage never exports credentials. Real enrollment and pool acceptance remain prime-only after prerequisite seam review and implementation/source acceptance. No runnable live pool driver is claimed.
