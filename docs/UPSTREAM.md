# Upstream

Fulcra is a fork of [Paseo](https://github.com/getpaseo/paseo) (Apache-2.0). It is branched from
Paseo 0.9.1 (upstream commit `818658520`, tag `v0.9.1`) and is kept mergeable with Paseo `main`.

## Rebrand at the edges

Like VSCodium does with VS Code, Fulcra renames only what a user sees:

| Renamed | Kept as Paseo (internal) |
|---|---|
| App, window, menu, About, installer and artifact names | `@getpaseo/*` package names and imports |
| UI copy in every locale | Type, function and variable names (`PaseoClient`, `resolvePaseoHome`, …) |
| CLI name `fulcra` (`paseo` stays as an alias) | Environment variables other than `FULCRA_HOME` (`PASEO_*`) |
| `FULCRA_HOME` (falls back to `PASEO_HOME`) | The default home `~/.paseo` and the project file `paseo.json` |
| README, NOTICE; desktop app name and bundle id (`app.fulcra.desktop`, settings in `Application Support/Fulcra`) | Mobile package ids `dev.orca.workspace*` and the `orca:` link scheme |

Keeping the internals means an upstream change applies to Fulcra without renaming, and existing
homes and project files keep working. When you add user-visible text, write "Fulcra"; when you touch
an identifier, leave it as upstream has it.

## Pulling upstream

`scripts/sync-upstream.sh` fetches `getpaseo/paseo` `main`, merges it into a `sync/upstream-<date>`
branch, runs the typecheck and unit tests, and lists conflicts. `.github/workflows/upstream-sync.yml`
runs it weekly and opens a pull request with the result. Resolve conflicts by keeping upstream's
behaviour and re-applying Fulcra's naming at the edges.

After merging, run the branding check: `git grep -i -w paseo` over user-visible text (locale files,
UI copy, README, desktop metadata) should find nothing except attribution (NOTICE, the About screen's
licence line, this file) and the kept identifiers above.

## Other integration sources

The same fetch-merge-verify pattern applies to projects Fulcra may take code from. Each keeps its own
licence and attribution in NOTICE.

| Source | Licence | How Fulcra uses it |
|---|---|---|
| [Paseo](https://github.com/getpaseo/paseo) | Apache-2.0 | Base of the fork; weekly sync |
| [Archify](https://github.com/tt-a1i/archify) | MIT | Integration source: add as a remote, merge or vendor with its MIT notice kept |
| [Radius](https://github.com/radius-project/radius) | Apache-2.0 | Integration source: same pattern, with its NOTICE carried over |
| Kepler | Proprietary | Feature parity only. No code, text or assets are copied |
