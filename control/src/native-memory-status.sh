#!/bin/sh
set -eu
[ "$*" = 'memory status --agent main --json' ] || exit 2
export OPENCLAW_NO_RESPAWN=1 NODE_DISABLE_COMPILE_CACHE=1 ORCA_TRIAL_RUN="${ORCA_TRIAL_RUN:-fulcra-local}"
runtime=${ORCA_MEMORY_RUNTIME:-}
if [ -z "$runtime" ]; then
    config="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)/local/machine-values.json"
    runtime=$(/opt/homebrew/opt/node@24/bin/node -e 'try { const v = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).memoryRuntime; if (typeof v !== "string" || !v.startsWith("/") || v.split("/").includes("..")) throw Error(); process.stdout.write(v); } catch { console.error("Set ORCA_MEMORY_RUNTIME or populate local/machine-values.json memoryRuntime"); process.exit(1); }' "$config")
fi
mkdir -p "$runtime"
printf '%s\n' "$$" >> "$runtime/memory-status-pids"
exec /opt/homebrew/opt/node@24/bin/node /opt/homebrew/lib/node_modules/openclaw/openclaw.mjs memory status --agent main --json
