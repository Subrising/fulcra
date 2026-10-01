#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == --help ]]; then echo 'Usage: release/release-zip.sh [--dry-run]; zip and verify the configured sealed bundle'; exit 0; fi
source "$(dirname "$0")/common.sh"
require CANDIDATE_APP ZIP_OUTPUT_DIR ZIP_NAME EXPECTED_BUNDLE_SHA SCRATCH_DIR
if [[ "${1:-}" == --dry-run ]]; then echo 'Zip configuration present'; exit 0; fi
[[ "$ZIP_NAME" == *.zip && "$ZIP_NAME" != */* ]] || { echo 'ZIP_NAME must be a zip basename' >&2; exit 2; }
mkdir -p -m 700 "$ZIP_OUTPUT_DIR" "$SCRATCH_DIR"
[[ ! -e "$ZIP_OUTPUT_DIR/$ZIP_NAME" ]] || { echo 'Refusing to overwrite zip' >&2; exit 2; }
X=$(mktemp -d "$SCRATCH_DIR/zip-check.XXXXXX")
trap 'rm -rf "$X"' EXIT
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$CANDIDATE_APP" "$ZIP_OUTPUT_DIR/$ZIP_NAME"
/usr/bin/ditto -x -k "$ZIP_OUTPUT_DIR/$ZIP_NAME" "$X"
export ZIP_CHECK_APP="$X/$(basename "$CANDIDATE_APP")"
"$NODE_BIN" --input-type=module -e 'const {sealBundle}=await import(process.env.REPO_ROOT+"/release/contract.mjs"); if(sealBundle(process.env.ZIP_CHECK_APP).sha256!==process.env.EXPECTED_BUNDLE_SHA) throw Error("Unzipped seal mismatch"); console.log("Unzipped seal matches");'
(cd "$ZIP_OUTPUT_DIR" && /usr/bin/shasum -a 256 "$ZIP_NAME" > "$ZIP_NAME.sha256")
