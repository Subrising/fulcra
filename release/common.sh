#!/bin/bash
# Source after handling --help. Config is trusted local shell input; never echoed.
RELEASE_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$RELEASE_SCRIPT_DIR/.." && pwd)
RELEASE_CONFIG=${FULCRA_RELEASE_CONFIG:-$REPO_ROOT/local/release.env}
if [[ ! -f "$RELEASE_CONFIG" ]]; then echo 'Missing local release configuration; copy local/release.env.example.' >&2; exit 2; fi
set -a
source "$RELEASE_CONFIG"
set +a
export REPO_ROOT
export CONTROL_ROOT="$REPO_ROOT/control"
export PRODUCT_ROOT="$REPO_ROOT"
NODE_BIN=${NODE_BIN:-node}
PYTHON_BIN=${PYTHON_BIN:-python3}
export NODE_BIN PYTHON_BIN
require() { local key; for key in "$@"; do if [[ -z "${!key:-}" ]]; then echo "Missing release config key: $key" >&2; exit 2; fi; done; }
