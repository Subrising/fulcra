# ADW in Fulcra: the verification loop

ADW is a **verification loop**, not a review pipeline. Define the target and its
acceptance checks first, build, verify against the real target, fix, re-verify —
until every check passes or the iteration cap is hit, then escalate with the diff
to target. Review is one gate inside the loop.

## Who does what

| Seat                            | Does                                                                                                                                                                                                                                                                          | Does not                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker**                      | Builds in its own worktree. Self-verifies against the acceptance matrix on the real target and records each result (`adw accept record … --evidence`). Fixes build/compile/test breakage on standing authority.                                                               | Run independent review loops (Superpowers per-task review, `/complete-work` Codex loop, GSD code-review are self-checks at most). Hand-build receipts, pins or ledgers. |
| **Lead** (project orchestrator) | Owns the contract and the matrix (`adw accept add`) before work starts. Integrates, freezes, runs ONE whole-candidate review (`adw review run --lane review`), folds findings + acceptance failures into one repair batch, then ONE cumulative-delta review. Runs `adw gate`. | Review per fix, per slice or per commit. Gate work on ACKs.                                                                                                             |
| **Prime**                       | Sees the outcome: the gate verdict, the evidence index, any ESCALATE with its diff to target, and decisions only the owner can make.                                                                                                                                          | Re-review, re-sign or re-pin evidence.                                                                                                                                  |

## The loop, per change

1. **C1 contract** — requirements, invariants, nonGoals, and the acceptance matrix:
   topologies/environments (packaged build on every host shape, empty and full
   states), upgrade over the user's real prior state (`state-before`/`state-after`),
   real UI routes, visual compare against a reference, harness preflight against the
   real library, publication (tree, commit author/committer/message, tags, release
   text — `~/.adw/tools/publication-check.mjs`).
2. **Build** — workers verify on the real target as they go.
3. **C2 whole-candidate review** — every unit plus mandatory seams (call arity,
   guards through real entry points, enabled vs default-off, installer input mapping,
   error-code preservation). Units are coverage accounting inside one assignment.
4. **C3 repair batch** — fix everything found, re-verify affected acceptance items,
   one cumulative-delta review of units changed since the last accepted assessment.
5. **C4 gate** — `adw gate` writes `EVIDENCE-INDEX.md` beside `verdict.json`. An item
   that fails at the cap (default 3) is ESCALATE: stop and report the diff to target.

## Rules for briefs

- Name the outcome, worktree, assigned files and the acceptance items the worker
  must verify. Do not add hash/pin/seal/receipt/intake/board requirements — the
  ADW ledger, git, CI and test output are the record, and the gate re-hashes.
- ACK means "received, proceeding". Never wait on an ACK before continuing work.
- Fold all items for a worker into one message to the SAME worker session. A new or
  revised instruction gets a fresh `messageId`; reuse a `messageId` only to retry
  identical text when the tool's receipt permits it.
- Write owner process decisions into the contract (nonGoals/acceptance) or policy,
  not only into an inbox, so later briefs cannot re-import retired rules.
- Report milestones in ≤3 lines: outcome or blocker, commit/artifact, next step.

`NOT_RUN` is never green and is reported as **unrecorded** (run it), **stale**
(re-verify this candidate) or **missing** (record what the tier asks for).
