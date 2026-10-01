#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == --help ]]; then echo 'Usage: release/package.sh [--dry-run] (configure local/release.env; run under configured heavy-lock runner)'; exit 0; fi
source "$(dirname "$0")/common.sh"
require STAGING_DIR EVIDENCE_DIR SPACE_VOLUME INTERNAL_MIN_GIB EXTERNAL_MIN_GIB EXPECTED_REPO_COMMIT
P=$REPO_ROOT; C=$CONTROL_ROOT; REL=$STAGING_DIR; job=$RELEASE_SCRIPT_DIR
# Dry-run checks provenance/config only. It neither builds nor writes evidence.
"$NODE_BIN" "$job/provenance.mjs" --check
if [[ "${1:-}" == --dry-run ]]; then exit 0; fi
require HEAVY_LOCK_RUNNER HEAVY_LOCK_PATH
if [[ "${1:-}" != --under-lock ]]; then
  exec "$HEAVY_LOCK_RUNNER" "$HEAVY_LOCK_PATH" "$0" --under-lock
fi
"$PYTHON_BIN" - <<'CHECK'
import os, shutil
from pathlib import Path
assert shutil.disk_usage('/').free >= int(os.environ['INTERNAL_MIN_GIB'])*2**30, 'internal disk floor'
assert shutil.disk_usage(os.environ['SPACE_VOLUME']).free >= int(os.environ['EXTERNAL_MIN_GIB'])*2**30, 'external disk floor'
assert not (Path(os.environ['STAGING_DIR'])/'output').exists(), 'output must be absent'
Path(os.environ['STAGING_DIR']).mkdir(parents=True, mode=0o700, exist_ok=True)
Path(os.environ['EVIDENCE_DIR']).mkdir(parents=True, mode=0o700, exist_ok=True)
CHECK
"$NODE_BIN" "$job/provenance.mjs" > "$EVIDENCE_DIR/build-attempt.json"
export FULCRA_PACKAGE_OUTPUT=$REL/output
export FIX_BUILD_SCRATCH=$REL/scratch
export TMPDIR="$FIX_BUILD_SCRATCH/tmp" TMP="$FIX_BUILD_SCRATCH/tmp" TEMP="$FIX_BUILD_SCRATCH/tmp"
export npm_config_cache="$FIX_BUILD_SCRATCH/npm-cache"
export XDG_CACHE_HOME="$FIX_BUILD_SCRATCH/cache"
export ELECTRON_BUILDER_CACHE="$FIX_BUILD_SCRATCH/electron-builder-cache"
export ELECTRON_CACHE="$FIX_BUILD_SCRATCH/electron-cache"
export NODE_COMPILE_CACHE="$FIX_BUILD_SCRATCH/node-compile-cache"
export JITI_CACHE_DIR="$FIX_BUILD_SCRATCH/jiti"
export BABEL_CACHE_PATH="$FIX_BUILD_SCRATCH/babel.json"
export npm_config_devdir="$FIX_BUILD_SCRATCH/node-gyp"
export __UNSAFE_EXPO_HOME_DIRECTORY="$FIX_BUILD_SCRATCH/expo-home"
export FULCRA_BUILDER_TMP="$FIX_BUILD_SCRATCH/builder-tmp"
export FULCRA_PLUGIN_OUTPUT="$FIX_BUILD_SCRATCH/bundled-plugins"
export FULCRA_WEB_OUTPUT="$FIX_BUILD_SCRATCH/web-dist"
export FULCRA_PACKAGE_CONFIG="$FIX_BUILD_SCRATCH/electron-builder.json"
mkdir -p "$TMPDIR" "$FULCRA_BUILDER_TMP"
cd "$P"
"$NODE_BIN" --input-type=module <<'CONFIG'
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(path.resolve('package.json'));
const yaml=require('js-yaml');
const base=path.resolve('packages/desktop/electron-builder.yml');
const config=yaml.load(fs.readFileSync(base,'utf8'));
const {commandCentreBuildConfig}=await import(path.resolve('scripts/command-centre-build-config.mjs'));
const complete=commandCentreBuildConfig(config,{desktop:path.dirname(base),pluginOutput:process.env.FULCRA_PLUGIN_OUTPUT,webOutput:process.env.FULCRA_WEB_OUTPUT});
fs.writeFileSync(process.env.FULCRA_PACKAGE_CONFIG,JSON.stringify(complete,null,2));
CONFIG
export FIX_RESOURCE_RECEIPT="$EVIDENCE_DIR/build-resources.json" FIX_RELEASE_ROOT="$REL" FIX_INTERNAL_MIN_GIB="$INTERNAL_MIN_GIB"
test ! -e "$EVIDENCE_DIR/build-resources.samples.jsonl"
set +e
"$PYTHON_BIN" "$job/resource-run.py" "$NODE_BIN" scripts/package-command-centre.mjs "$C"
result=$?
set -e
exit "$result"
