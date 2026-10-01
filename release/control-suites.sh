#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == --help ]]; then echo 'Usage: release/control-suites.sh; each control test runs through the host-test loader'; exit 0; fi
source "$(dirname "$0")/common.sh"
require EVIDENCE_DIR TEST_HOST
OUT="$EVIDENCE_DIR/control-suites"; mkdir -p "$OUT"
cd "$REPO_ROOT"; : > "$OUT/summary.tsv"
failed=0
while IFS= read -r f; do
  testfile=${f#control/}; log="$OUT/${testfile//\//_}.log"
  rc=0
  "$PYTHON_BIN" "$RELEASE_SCRIPT_DIR/run-with-timeout.py" "${FILE_TIMEOUT:-600}" "$RELEASE_SCRIPT_DIR/run-control-test.sh" "$testfile" > "$log" 2>&1 || rc=$?
  printf '%s\t%s\n' "$testfile" "$rc" >> "$OUT/summary.tsv"
  if [[ "$rc" != 0 ]]; then failed=1; fi
 done < <(git ls-files 'control/src/*.test.mjs' 'control/orca-conversation/*.test.mjs' 'control/tools/*.test.mjs' | sort)
exit "$failed"
