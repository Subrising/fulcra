#!/usr/bin/env bash
# Merge upstream Paseo into a sync branch, verify it, and report conflicts. See docs/UPSTREAM.md.
# Usage: scripts/sync-upstream.sh [upstream-url] [upstream-branch]
set -euo pipefail

UPSTREAM_URL="${1:-https://github.com/getpaseo/paseo.git}"
UPSTREAM_BRANCH="${2:-main}"
SYNC_BRANCH="sync/upstream-$(date -u +%Y%m%d)"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi
git fetch upstream "$UPSTREAM_BRANCH"
git checkout -B "$SYNC_BRANCH"

if ! git merge --no-ff --no-edit "upstream/$UPSTREAM_BRANCH"; then
  echo "Conflicts merging upstream/$UPSTREAM_BRANCH:"
  git diff --name-only --diff-filter=U
  echo "SYNC_RESULT=conflicts"
  exit 2
fi

npm ci
npm run typecheck
npm run test:unit --workspaces --if-present

echo "Branding check (user-visible text should only mention Paseo in attribution):"
git grep -i -w -n paseo -- 'packages/app/src/i18n/resources/*.ts' README.md || true

echo "SYNC_RESULT=clean branch=$SYNC_BRANCH"
