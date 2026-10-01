#!/bin/bash
set -u
if [[ "${1:-}" == --help ]]; then echo 'Usage: release/gates-8.sh; unchanged candidate-8 gate command list with local path configuration'; exit 0; fi
source "$(dirname "$0")/common.sh"
require CANDIDATE_APP PREVIOUS_APP PROBE_CLIENT TESTDEVICE_CLIENT EVIDENCE_DIR GATE_FIXTURES_DIR GATE_OPERATOR_DIR GATE_CHANGE_PAYLOAD
cd "$GATE_FIXTURES_DIR"
A8=$CANDIDATE_APP; A7=$PREVIOUS_APP; CL=$PROBE_CLIENT; TD=$TESTDEVICE_CLIENT; PY=$PYTHON_BIN; N=$NODE_BIN
G="$EVIDENCE_DIR/gates"; mkdir -p "$G"
export U8_PROBE_CLIENT="$CL" U8_TESTDEVICE_CLIENT="$TD"
export U8_MACBOOK_APP="${MACBOOK_APP:-$A8}"
failed=0
run() { local name=$1; shift; echo "== $name"; "$@" > "$G/$name.out" 2>&1; local rc=$?; echo "rc=$rc"; if [[ "$rc" != 0 ]]; then failed=1; fi; }
run pool            "$N" u7/gate-pool.mjs "$A8" u8g-pool 6895
run roles           "$N" u7/gate-roles.mjs "$A8" u8g-roles 6896
run modes           "$N" u7/gate-modes.mjs "$A8" u8g-modes 6898 6899
run remote-accounts "$N" u7/gate-remote-accounts.mjs "$A8" "$A7" "$TD" u8g-remote 6897 8796
run macbook-trust   "$N" u7/gate-macbook-trust.mjs "$A8" "${U8_MACBOOK_APP:-$A8}" "$A7" "$TD" u8g-macbook 6900 8797 6901
run github-l54      "$N" u7/gate-github-l54.mjs "$A8" "$TD" u8g-ghl54 6903
run sigterm         "$PY" -B sigterm-restart.py "$A8" u8g-sigterm 6881
run gate-a-special  "$PY" -B u4/gate-a-special.py "$A8" u8g-special 6882 "$CL"
run gate-e-relay    "$PY" -B u4/gate-b-relay.py "$A8" u8g-relay 6883 8794
run testdevice      "$PY" -B "$GATE_OPERATOR_DIR/u5-testdevice-offline-test.py" "$A8" u8g-td 6884 8795
run diag            "$PY" -B "$GATE_OPERATOR_DIR/u6-diag-offline-test.py" "$A8" u8g-dg 6885
run tracker         "$PY" -B "$GATE_OPERATOR_DIR/u6-tracker-offline-test.py" "$A8" u8g-tr 6886
run activity-diag   "$PY" -B "$GATE_OPERATOR_DIR/u6-activity-diag-offline-test.py" "$A8" u8g-ad 6889
run gate-b-l39      "$N" u5/gate-b-l39.mjs "$A8" u8g-l39 6876 8792
run gate-c-l48      "$PY" -B u5/gate-c-l48.py u8g-l48 6874 "$A8" "$A7"
run gate-f          "$N" u6/gate-f-changes.mjs "$A8" u8g-f 6893
run kit-installed   "$N" "$GATE_OPERATOR_DIR/usertest-u6/installed-view-test.mjs" "$A8" "$GATE_CHANGE_PAYLOAD" "$G/kit-installed-view"
run modes-live-shape env GM_LIVE_SHAPE=1 "$N" u7/gate-modes.mjs "$A8" u8g-modes-live 6898 6899

exit "$failed"
