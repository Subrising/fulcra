# Packaged output review

Run `node tools/no-machine-ties.mjs /path/to/Fulcra.app tools/packaged-vendor-exemptions.json` through the assigned test slot. The JSON result must have `passed: true`. Without an explicit manifest, no findings are exempted.

The pattern list is unchanged. Framework symlinks must resolve inside the bundle. The audit opens ASAR entries independently, including archive headers, gaps and trailing bytes, so a vendor exemption cannot cover the entire archive or an adjacent Fulcra entry. Ordinary streaming scans retain their bounded reads; each vendor file is hashed in full.

Each exemption names one exact third-party path, its SHA-256, every reviewed matched spelling, and a one-line justification. There are no wildcard exemptions. Fulcra renderer, controller resources and `@getpaseo` entries cannot be exempted. A changed or missing reviewed file, an unreviewed pattern, or a new matching file fails. Clean new files are scanned normally; they do not inherit exemptions. Updating this manifest requires inspecting the changed bytes and recording a new review, not copying hashes from a failing result without investigation.

The initial nine entries were reviewed against restored Electron 44.2.0/native dependency bytes. All 294 corresponding Round 3 file/line observations reproduced. They cover upstream OS paths, language substrings, compression dictionary/decoder names, native diagnostic paths and one addon build RPATH whose first search location is `@loader_path` beside the shipped libraries. They remain conditional on matching the actual packaged bytes; they do not certify a new app build or independent release approval.

Round 4 preflight still fails on seven renderer observations. Three are our functional data (two toast durations and one public documentation URL); four come from bundled vendor data/module identifiers. The mixed renderer receives no exemption. The old app archive was removed by required cleanup, and its 115 raw line observations have no retained entry map; those remain unassigned rather than guessed. The task's `round4-scan-triage.json` accounts for every original observation and explicitly marks unresolved entries.

A full app build and controller lifecycle proof must not be called portable while this gate is red. No legacy route was removed on the strength of component compilation or a partial scan.

## PA21 refinement

The Round 4 restriction on generic first-party findings is superseded. Generic first-party findings may now have a `first-party-generic` review with exact file, SHA-256, matched token, line, decoded-text offset, surrounding context and justification. Every occurrence requires its own record; a second identical token does not inherit a review. Third-party match records use `vendor-generic`; previously reviewed identical vendor patterns remain grouped with their pinned file hash and provenance.

Personal home/volume paths and credential-shaped values cannot be approved through a generic review. The detector retains its original pattern list and additionally detects high-confidence credential shapes; credential-shaped contents are redacted in diagnostics. Known upstream CI runner paths remain vendor provenance, not a personal installation path. Unreviewed findings, missing/changed review locations and changed hashes still fail. The deleted Round 3 ASAR observations are moot under PA21: audit the new output instead.

## Round 5 actual artifact

Use `tools/packaged-round5-reviews.json` for the Round 5 artifact. It includes the nine unchanged binary reviews plus 127 new exact occurrence reviews: eight first-party generic matches and 119 vendor matches, with package/version provenance. The old Round 3 archive observations are moot; the new archive was scanned entry by entry.

The new audit scanned 7,543 physical/virtual files and found 2,042 occurrences. It accepts 2,039 reviewed generic occurrences, has zero stale-review errors, and remains **failed** on three PEM-marker findings: two truncated dotenv README examples and jose's header-only `indexOf` parser literal. These were inspected and independently rejected as keys by OpenSSL. Automatic approval review rejected contextual credential classification, so the detector is unchanged and none is exempted. No successful portability gate is claimed.

The path classifier now separates NUL-terminated OS root prefixes and nested API route segments from personal home paths. Exact personal path/token regressions remain passing. Root-job `round5-scan-triage.json` contains every new-artifact finding, its hash, position/context and review or unresolved disposition. The unchanged original patterns, bounded ASAR inspection, internal-symlink validation and changed-hash failure rule remain in force.
