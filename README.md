# Fulcra

Fulcra lets you run and watch your AI coding agents — Claude Code, Codex, GitHub Copilot, OpenCode
and Pi — from one app. A small host runs on your machine next to your code; the Fulcra app connects
to it from the desktop, the browser or your phone. Your code stays on your machine.

- Start agents in a workspace, follow their output live, answer permission prompts and send
  follow-ups from anywhere.
- Pick the provider, model, permission mode and effort per session. New sessions start on your
  host's defaults (for Claude: Auto mode and the default model with its default effort).
- Claude models are read from your installed Claude Code, so new models appear without a Fulcra
  update.
- Several hosts, several projects, one app.

Fulcra is based on [Paseo](https://github.com/getpaseo/paseo) (Apache-2.0) by Mohamed Boudra. See
[NOTICE](NOTICE) and [docs/UPSTREAM.md](docs/UPSTREAM.md).

## Install (macOS, Apple silicon)

1. Download `Fulcra-0.1.0-arm64.dmg` from the release page and drag **Fulcra** into Applications.
2. This build is not notarized. The first time, macOS blocks it: open **System Settings → Privacy &
   Security**, scroll to the message about Fulcra and choose **Open Anyway**, then confirm.
3. You need at least one agent CLI installed and logged in, for example
   [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or Codex. Providers without a CLI
   show as "Not installed" in the model picker.

The desktop app starts its own host. To run a host on another machine and connect to it, use the
CLI (below).

## Build from source

Requirements: Node.js 22+, npm, and for the desktop app macOS with Xcode command line tools.

```bash
npm ci
npm run typecheck
npm run build:server                 # host, CLI and their libraries
cd packages/desktop && npm run build:unsigned   # macOS app in packages/desktop/release/
```

Development:

```bash
npm run dev                          # host + app in development mode
npm run cli -- ls -a -g              # list agents through the CLI
```

## CLI

The CLI is `fulcra` (`paseo` still works as an alias):

```bash
fulcra daemon status
fulcra run "fix the failing test"
fulcra ls
```

The host keeps its state in `~/.paseo` by default. Set `FULCRA_HOME` to use another directory
(`PASEO_HOME` is still honoured).

## Documentation

`docs/` holds the architecture, provider, plugin and testing guides. Start with
[docs/architecture.md](docs/architecture.md) and [docs/providers.md](docs/providers.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
