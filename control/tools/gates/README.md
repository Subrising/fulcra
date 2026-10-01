# FIX-8 modes gate

The packager runs this once in the candidate-9 batch against the staged app.
No staged PASS is supplied by this source handoff. Candidate-8 failures are in
R1 REVIEW-U7-FINAL §10 and REPORT-U8.

```sh
export FULCRA_TEST_PRODUCT=/path/to/matching/product
export U8_PROBE_CLIENT=/path/to/matching/u8-probe-client.mjs
export U8_GATE_OUT=/path/to/evidence
# Run through the existing heavy lock with internal >=9 GiB, external >=25 GiB
# and memory admission. Use two unused scratch ports, never 6767.
node control/tools/gates/gate-modes.mjs /path/to/staged/Fulcra.app c9-modes 6891 6892
```

M checks all six creation paths with Command Centre enabled. B checks P1/P2/P6
on a plain host; P3/P4/P5 require Command Centre. Both expect Claude auto and
Codex full-access. Missing provider launch evidence fails. C retains child caps,
X explicit choices, Z routine MCP/file completion, K credential escalation, and
N permission attention. Stand-ins never read real accounts or Keychain items.
`GM_LIVE_SHAPE=1` deliberately tests the old stored Codex auto-review setting;
leave it unset for the built-in-default acceptance run.

K covers requests received by Fulcra. Codex never/danger-full-access can execute
without submitting a permission request; this gate does not prove enforcement
over those actions. The automatic-tool classifier is a best-effort denylist,
not a security sandbox. Independent review must assess these limits.
