#!/bin/sh
set -eu
: "${TEST_SLOT:?Set TEST_SLOT to the authorized shared light-test runner}"
cd "$(dirname "$0")/../../.."
export PASEO_SKIP_PROTOCOL_BUILD=1
# Existing focused suites, installed matching dependencies only. No build/install/live/staged gate.
"$TEST_SLOT" npx --no-install vitest run packages/cli/src/commands/agent/run.test.ts --bail=1 --cache=false
"$TEST_SLOT" npx --no-install vitest run packages/app/src/hooks/sidebar-workspaces-view-model.test.ts --bail=1 --cache=false -t 'all-session sidebar'
"$TEST_SLOT" npx --no-install vitest run packages/app/src/components/sidebar-callout.test.tsx --bail=1 --cache=false -t 'mounted all-session sidebar'
