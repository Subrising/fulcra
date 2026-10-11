# Fulcra 0.2.18

## Security

- The packaged daemon no longer opens a Node inspector when it gets signal SIGUSR1. Before this, any process of the same user could send that signal and then run code inside the daemon (FU-79).
  - The supervisor and the worker start with `--disable-sigusr1`.
  - The Electron fuse `EnableNodeCliInspectArguments` is off. `RunAsNode` stays on, because the daemon runs as the Electron program in Node mode.
  - A released app has no run-time switch for this. No environment variable, file or argument turns the inspector on.

## Gate flavour

The hang gate blocks a worker through the inspector. It cannot run on a release build any more. It now runs on the gate flavour, a separate build.

The gate flavour differs from the release build in one place only: the compiled constant `GATE_FLAVOUR` in `packages/server/src/server/inspector-flavour.ts` is `true`, so the start arguments do not hold `--disable-sigusr1`. The fuse setting is the same in both builds.

To make the gate flavour, run `npm run build:server`, then `node scripts/build-gate-flavour.mjs`, then electron-builder. No workflow or package script runs that step. Never release a gate build.

The FU-80 gate does not use the inspector, so it still runs on the release build.
