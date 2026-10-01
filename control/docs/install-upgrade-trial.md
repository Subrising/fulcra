# Digest-bound disposable Fulcra trial adapter

`tools/fulcra-postinstall-smoke` drives a **copy** of an unsigned bundle. It never installs into `/Applications`, uses launchd, or reads a user's Keychain. Its current mode is explicitly **private HOME + fake Keychain**, not an isolated-account or fresh-Mac result. The adapter has been exercised against the first integrated RC; the full smoke remains release-gated on the repaired candidate. REPAIR's external `handoff.example.json` was unavailable on the Mini; this local schema is provisional until compatibility is checked against that file. Do not claim D23 closed from the local contract tests.

The tool uses Node standard libraries. Transfer the whole `tools/trial/` directory, `fulcra-postinstall-smoke` and `fulcra-postinstall-smoke.mjs` together. The `seal` output binds every bundle file, its mode, every link and all adapter JavaScript bytes. Verification happens before launch and every command. A changed bundle or adapter requires a new reviewed handoff; resealing is not acceptance.

```
tools/fulcra-postinstall-smoke seal /private/trial-copy/Fulcra.app handoff.json
tools/fulcra-postinstall-smoke prepare handoff.json /private/trial-copy/Fulcra.app /private/tmp/rc-trial-new 16767
tools/fulcra-postinstall-smoke start /private/tmp/rc-trial-new
tools/fulcra-postinstall-smoke command /private/tmp/rc-trial-new desktop_daemon_status
tools/fulcra-postinstall-smoke command /private/tmp/rc-trial-new patch_desktop_settings '{"daemon":{"commandCentreEnabled":true}}'
tools/fulcra-postinstall-smoke command /private/tmp/rc-trial-new probe '{"auth":true}'
tools/fulcra-postinstall-smoke command /private/tmp/rc-trial-new probe '{"auth":false}'
tools/fulcra-postinstall-smoke stop /private/tmp/rc-trial-new
```

Choose a new private home and unused numeric-loopback port before first launch. The tool refuses 6767/6791, an existing home, a changed PID/start identity and any escaping bundle link. It records the app PID/start/entry and observes the desktop's daemon status. Controller identity comes from this home's `paseo/command-centre/process.lock` and must be correlated with the owned daemon's direct child and packaged controller entry before signals. Never kill by name or process group alone. `stop` uses the app's normal disable and daemon-stop handlers; after a prior quit, `start` reconnects only when the saved owned daemon PID/start still matches.

For postinstall, `smoke <prepared-run>` opens the shipped window, enables Command Centre, captures `evidence/command-centre.png` and `evidence/smoke.json`, requires an observed health RPC on the real renderer's WebSocket, checks unauthenticated 4401 with zero frames, quits, reopens and requests clean shutdown. A diagnostic health result alone cannot pass. Inspect the screenshot yourself; `humanInspected` is deliberately false until separate human/agent visual evidence is recorded. Failure receipts retain the exact missing check; inspect `cleanup` and finish owned-process cleanup if needed. No secret or raw WebSocket frame enters the receipt. Additional RC changed-path checks remain separate; this smoke is not the full release gate.

## Synthetic scale state (D25)

`node tools/real-scale-fixture.mjs <new-directory>` creates two independent host trees, each with 140 native agent metadata files, 14 workspace directories, 140 journal enrollments, 2,800 settled deliveries, 2,800 consumed events and 14 stale project seats. Across both hosts: 280 sessions, 28 workspaces, 5,600 deliveries/events and 5,600 native timeline rows (20 per session). The native journals use the real FileAgentTimelineStore format; the RC reader validates every row. It uses the real journal schema and storage implementation, no provider credentials, network, copied user content or artificial sleep/load. All files and state directories are private. Never seed a running controller. The generated state must be placed in a prepared disposable trial before launch, preserving the preselected daemon config.

All enrolled sessions have an old synthetic boot. Missing human-input evidence must prevent automatic regrant; this fixture does not fabricate a successful grant. Record actual seat-sweep, watch and usage completion times on the RC, then crash/restart the owned child. Generating the state is not startup or performance acceptance. REPAIR fresh/upgrade uses this same generator and records its source digest.

## Host alignment and upgrade

Use **the same validated artifact on both Macs**, with equal per-plugin client pins. Before pairing and after each install/upgrade, compare archive and client digests, restart only the test background services and reconnect. A visible “Plugin not trusted on this Mac” means those plugin bytes or the pin cannot be verified; update both ends to the same artifact. Local plugins need the same exact bundled bytes too. Never bypass the pin.

Capture a deliberately different-build test host's explained untrusted state, then align it and capture the accepted panel. The live 0.9.1 host is untouched; its expected absent/different plugin state is policy inference only. Do not upgrade that host before V6.

The RC upgrade is labelled **resource replacement from the retained R8 baseline**, using the same private controller state. Stop the old owned app/daemon before replacing the disposable app copy. Verify both bundle digests, preserve logical task/session identities and retained settings, then rerun authentication, rendering and the exact scan. This is not evidence of two public releases or a fresh Mac. Keep the R8 baseline immutable for rollback.

The `inspect` command returns the current daemon status, controller PID/start/entry and epoch, requires the controller's direct parent to be the daemon worker and that worker's parent to be the recorded owned supervisor, and performs the separately labelled diagnostic health probe. A controller-ready receipt is not evidence of renderer authentication.

The initial RC fixture run had all external providers disabled. Usage completed as unavailable, and stale-seat timeline observations failed closed because their provider was unavailable. This is not proof of successful provider-backed history/sweep timing. Retain this limitation in any D25 receipt; do not enable a real provider or read the operator's credentials to hide it.

### Verified termination receipts

`stop` captures owned app/supervisor/worker/descendant PID + start-time identities before disable, then waits for all those lifetimes to exit. A survivor or process-table query failure fails the operation; `stopRequested` alone is not proof. `command <root> quit` verifies app and non-background descendant exit and explicitly lists the retained background lifetimes (Command Centre intentionally keeps serving after app quit). Final `stop` verifies those background lifetimes too. No signal is sent by the verifier and a reused PID is never treated as the original process.
