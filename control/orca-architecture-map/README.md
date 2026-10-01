# orca-architecture-map

Authoring support for Fulcra's **Architecture map** tab (J4, option C).

- `SKILL.md` — the worker brief for writing `.fulcra/architecture/<name>.ir.json` by hand from a
  project's definitions, with the evidence rules from the Archify/Radius review record.
- `validate.mjs` — read-only check a worker runs before hand-off: the renderer contract Fulcra
  enforces (`packages/app/src/architecture-map/ir-schema.ts` in the product repo) plus the
  subtitle qualifier and SHA-256 re-hash of every cited source. No network, no Radius.
- `validate.mjs --since <base>` — the ADW gate: a significant change must update the map in the
  same branch, and stale source hashes are named (SKILL "Keep the map current").
- `generate.mjs` — draws a map from the code at one commit, or Before/After for a change (folders as parts,
  imports as connections). The product host's `packages/server/src/utils/architecture-map/generate.ts` is its
  TypeScript twin and gives byte-identical output. `--write <name>` saves `.fulcra/architecture/<name>.ir.json`.
  The validator accepts a generated map when it says "automatically generated", cites its commit, and the gate
  re-generates it at that commit to the same parts and connections.
- `diff.mjs` — the Before/After comparison (CHANGES): two maps compared by stable id, read with
  `git show` at each commit. Pure core; the app carries a TypeScript twin with the same cases.
- `change-evidence.mjs` — builds the evidence for a `change` decision packet from a PR:
  `archmap:` refs for base and head, the sessions and tasks from commit trailers, and one plain
  sentence. It registers nothing; the decision store (J3) owns execution.
- `fixtures/` — the reviewed head IR and the historical baseline Bicep used by the tests, and
  `changes/{base,head}.ir.json`, a made-up shop used for the comparison tests and screenshots.

Tests (per file): `TMPDIR=<scratch> node --test orca-architecture-map/<name>.test.mjs`.

Nothing here is installed. Installing the skill into a worker's skill directory is the prime's
step after review; there is no `install.py` on purpose.
