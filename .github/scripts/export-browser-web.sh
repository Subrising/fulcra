#!/usr/bin/env bash
set -euo pipefail
npm exec --workspace=@getpaseo/app -- expo export --platform web --output-dir .e2e-web --max-workers 2
