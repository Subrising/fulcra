#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == --help ]]; then echo 'Usage: release/gates.sh [--dry-run]; runs the configured owner-reviewed candidate driver under heavy lock'; exit 0; fi
source "$(dirname "$0")/common.sh"
require GATE_DRIVER CANDIDATE_APP EVIDENCE_DIR HEAVY_LOCK_RUNNER HEAVY_LOCK_PATH
[[ -f "$GATE_DRIVER" ]] || { echo 'Configured gate driver missing' >&2; exit 2; }
if [[ "${1:-}" == --dry-run ]]; then echo 'Gate driver configuration present'; exit 0; fi
export U8_PROBE_CLIENT="${PROBE_CLIENT:-}" U8_TESTDEVICE_CLIENT="${TESTDEVICE_CLIENT:-}"
exec "$HEAVY_LOCK_RUNNER" "$HEAVY_LOCK_PATH" "$GATE_DRIVER"
