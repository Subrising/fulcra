#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == --help ]]; then echo 'Usage: release/scan-and-seal.sh (configure local/release.env)'; exit 0; fi
source "$(dirname "$0")/common.sh"
require CANDIDATE_APP EVIDENCE_DIR REVIEWS ADAPTER_BASELINE PREVIOUS_HANDOFF
exec "$NODE_BIN" "$RELEASE_SCRIPT_DIR/scan-and-seal.mjs"
