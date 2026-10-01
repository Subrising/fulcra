#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == --help ]]; then echo 'Usage: release/run-control-test.sh <control-relative test files...>'; exit 0; fi
source "$(dirname "$0")/common.sh"
require TEST_HOST
export FULCRA_TEST_PRODUCT="$REPO_ROOT" FULCRA_TEST_HOST="$TEST_HOST"
cd "$CONTROL_ROOT"
exec "$NODE_BIN" --import ./tools/host-test-config.mjs --loader ./tools/host-test-loader.mjs --experimental-test-module-mocks --test "$@"
