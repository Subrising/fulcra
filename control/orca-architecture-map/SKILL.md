---
name: fulcra-architecture-map
description: Author a project's architecture map for Fulcra — a hand-mapped Architecture IR v1 file at .fulcra/architecture/<name>.ir.json, derived by reading the project's definitions as text, citing every source by SHA-256, and validated before review — and keep it current: a significant change updates the map in the same branch. Never runs, deploys or extracts anything.
user-invocable: false
---

# Map a project's architecture for Fulcra

Use this when a worker is asked to "map the architecture", "draw the architecture map" or to
update an existing map for a project in Fulcra. The output is one reviewed JSON file that
Fulcra's **Architecture map** tab renders. You are the author; the app only reads.

## Output

- Path: `<project root>/.fulcra/architecture/<name>.ir.json` (lower-case name, `.ir.json` suffix).
  Fulcra lists at most 20 maps there and refuses files over 1 MiB.
- Format: Architecture IR v1 — `schema_version: 1`, `diagram_type: "architecture"`, `meta`,
  `components[]`, `connections[]`, `cards[]`, optional `boundaries[]`. The worked example is
  `fixtures/head.ir.json` beside this file. Limits: 500 components, 2000 connections, labels
  ≤ 120 characters, ids `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, every `pos`/`size` authored.

## Or generate it

A map drawn from the code needs no authoring: `node orca-architecture-map/generate.mjs <project root> HEAD --write <name>`
writes one from the committed code (parts are folders, connections are imports). It says "automatically generated",
cites its commit and passes the validator; the gate re-generates it at that commit. Fulcra also draws these maps
itself for every pull request, so write one only when the project wants a committed picture. Draw by hand (below)
when the system's shape isn't its folders: deployments, cloud resources, services talking over the network.

## Evidence rules for hand-drawn maps (from the reviewed Archify/Radius record)

1. **Hand-mapped, from source text only.** Read `.bicep`, compiled JSON, compose or manifest
   files as text. Do not compile, extract, deploy or query anything: never run `rad`,
   `bicep build`, `az`, `kubectl`, `docker`, a deployment, or any cloud or Radius call. Radius
   holds stay as they are.
2. **Say so in the subtitle.** `meta.subtitle` must contain "manually mapped" and say nothing was
   deployed ("not deployed" / "no deployment").
3. **Cite every source by hash.** Put a Source card whose items read
   `<project-relative path> SHA256 <first 8+ hex>` for each file you mapped from. Paths are
   relative to the project root and stay inside it.
4. **Map only what the source declares.** One component per declared resource; parameters and
   references that the definition does not create are `type: "external"` and labelled as such.
   Do not invent a region, database, owner, cluster, cloud account or traffic edge. Edges are
   deploy-time references as authored, not observed traffic.
5. **Keep limits visible.** Add a "Bindings & limits" card listing unresolved parameters and what
   the map does not establish (no runtime acceptance, no live state).
6. **Identity is stable.** Keep existing component and connection `id`s when you update a map, so
   a later comparison can tell changed from replaced.
7. **Plain text only.** Labels are shown as text; do not put markup, URLs meant to be clicked, or
   control/bidi characters in them (Fulcra strips the latter and flags the map).

## Validate before hand-off

Run the validator from the Fulcra control checkout (read-only; it re-hashes the cited files):

```sh
node orca-architecture-map/validate.mjs <project root> .fulcra/architecture/<name>.ir.json
```

It exits 0 only when the renderer contract and rules 2–3 pass, and prints warnings for text that
claims a live observation. Fix every error; explain every warning in your hand-off. A passing
validator is not a fidelity review — the reviewer still compares each node and edge with the
source.

## Keep the map current (the gate)

Fulcra shows every significant change as a _Before_ and _After_ picture of the system, built
from the map at the branch's starting point and the map at its tip. That picture is only true if
you update the map in the same branch as the change. So before hand-off, on any branch:

```sh
node orca-architecture-map/validate.mjs <project root> --since <base branch>
```

- **Significant change.** Your branch changes 10 or more files (map files not counted;
  `--threshold N` changes the number), or it changes any file a map cites as its source.
- **Then you must update the map in this branch.** Otherwise the gate fails with
  _"Map not updated"_. Draw what the change adds, removes or alters, and nothing else.
- **Keep every existing id (rule 6).** Change a label, not an id. A part whose id changed shows
  up as "removed" plus "added", and the gate warns: _"looks renamed"_.
- **Re-cite what you re-read.** Every cited source is re-hashed. If a source changed since the
  map cited it, the gate says the map _"is out of date"_ and names the file. Read it again, update
  the map, and write the new SHA-256.
- **No change to the system's shape?** Some big changes don't alter it (a rename across files,
  tests only). Say so in one sentence on the map's "Bindings & limits" card. That updates the map
  and records why. Don't skip the gate.
- **No map yet?** The gate passes with a notice. Add a map when the project is ready for one.

It checks committed work only. It reads every map, and every source file a map cites, from your
branch's latest commit with `git show`, so an uncommitted edit can't make it pass or fail. It says
so if you have uncommitted changes. The comparison itself is `node orca-architecture-map/diff.mjs <repo> <base> <head>`: it reads both maps with
`git show`, never your working copy.

## Hand-off

Commit the map on your task branch with the sources unchanged, and report: the map path, the
cited source paths with full SHA-256, the component/connection counts, the validator output
(and the `--since` gate output when you changed an existing project), and anything in the source
you chose not to map and why.
