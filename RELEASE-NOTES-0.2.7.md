# Fulcra 0.2.7

This release gives the source code only. It does not include an app download. To use Fulcra, build and package your own app. The README section "Build and package your own Fulcra" gives the steps.

Fulcra 0.2.7 is based on Paseo v0.11.0-beta.5. It also includes the changes of 0.2.6, which we did not publish separately.

## Fixed in 0.2.7

### Memory and processes

- Fulcra no longer starts a receiver process on a second Mac over SSH. That old path is removed. Each call started a remote process that did not stop. On one Mac, about 950 of these processes used about 60 GB of swap.
- When the app starts while its old daemon is still shutting down, the app now waits. When the old daemon stops, the app starts a new one. Before, the app stayed on "Connecting".

### Providers

- The daemon loads the provider list when it starts. Before, `provider ls` showed "loading" until the first request.

### Sidebar

- After a daemon restart, the main assistants list loads again by itself. You do not have to select Retry.
- Leads show "Working" or "Idle". Before, a lead could show "Status unknown" when many sessions were open.

### Words in the app

- The app uses plain words for roles: "lead" (not "orchestrator"), "main assistant" (not "prime") and "worker" for a session that does one job for a lead.
- The app does not use "seat" or "delegated". It says "you control this" or "Fulcra controls this".
- All ten languages use the new words for the role picker.

### Deploy

- Deploy has a new **Open architecture map** button. It opens the project's architecture map in the app.

### Build

- The pre-commit type check passes again.
- The README has a new section, "Build and package your own Fulcra". We tested the steps from a clean clone.

## Included from 0.2.6

- Image files: at about 2,000 files or 1 GB, Fulcra deletes the oldest images. A deleted image shows "Image no longer kept".
- A main assistant outside a project can answer questions on Home.
- Partial clones: the change map no longer downloads every file of a large repository.
- "Open code" opens the main source file before `package.json`.
- `provider models --refresh` and a **Refresh models** button show new models without a restart.
- Claude Haiku 5.5 is in the model list.
- A new "light" session role uses Claude Haiku 5.5 at medium effort. Use it for summaries, searches, test runs and monitors.

## Important

- **Codex Full Access runs commands without approval prompts. Fulcra cannot check credential access, destructive Git actions or publishing before they occur in this mode.**
- We tested Deploy on a local test cluster only. We did not test a deploy to a real cloud cluster.
- Fulcra keeps each loaded agent history in memory while the daemon runs. Right after a start, the daemon uses more memory. Then it becomes stable.

## What we tested

- We installed the signed app on the MacBook. The app, the daemon, the command line and the bundled plugins operate correctly. A new Claude Haiku 5.5 session answered.
- We installed the signed app on the Mac mini. The daemon is healthy, and Claude and Codex are available.
- The packaged Deploy check passed in the signed app on a local k3d cluster: connect, deploy, deploy a change and roll back.
- We built and packaged the app from a clean clone with the README steps. The packaged checks passed.
- One fresh review of all 0.2.7 changes found no blockers. We fixed its findings and checked the fixes again.
- The type checks, the lint check and the automatic tests pass. Some tests failed before this release too. They are not new failures.
