#!/bin/sh
set -eu
: "${TEST_SLOT:?Set TEST_SLOT to the authorized shared light-test runner}"
cd "$(dirname "$0")/../../.."
export PASEO_SKIP_PROTOCOL_BUILD=1
config=control/tools/gates/parent-source-vitest.config.mts
# Existing per-file suites; requires installed dependencies. No build/install/staged or live acceptance.
"$TEST_SLOT" npx --no-install vitest run packages/protocol/src/trusted-input.test.ts --config "$config" --bail=1 --cache=false
"$TEST_SLOT" npx --no-install vitest run packages/server/src/server/agent/agent-manager.test.ts --config "$config" --bail=1 --cache=false -t 'native parent adoption'
"$TEST_SLOT" npx --no-install vitest run packages/server/src/server/plugins/management-session.test.ts --config "$config" --bail=1 --cache=false -t 'native parent adoption'
