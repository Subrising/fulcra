#!/bin/bash
# Merge a tested PR through the workflow. Create an annotated tag and source release.
set -euo pipefail
fail() { echo "$1" >&2; exit 1; }
[ "$#" -eq 3 ] || fail 'usage: release.sh <version> <pr> <sha>'
VERSION=$1
PR=$2
SHA=$3
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Invalid version.'
[[ "$PR" =~ ^[1-9][0-9]*$ ]] || fail 'Invalid PR number.'
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'Use the full tested SHA.'
REPO=Subrising/fulcra
TAG=v$VERSION
SOURCE=${FULCRA_RELEASE_REPO:-$PWD}
cd "$SOURCE"
case "$(git remote get-url origin)" in
  https://github.com/Subrising/fulcra.git|git@github.com:Subrising/fulcra.git) ;;
  *) fail 'Wrong origin repository.' ;;
esac
PATTERNS=${FULCRA_RELEASE_PATTERNS:-$PWD/local/personal-patterns.tsv}
[ -s "$PATTERNS" ] || fail 'Private scanner patterns are missing.'
export FULCRA_PRIVATE_PATTERNS
FULCRA_PRIVATE_PATTERNS=$(cat "$PATTERNS")
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fulcra-release.XXXXXX")
WORKTREE=$TMP/source
cleanup() {
  git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
git fetch -q origin main
MAIN=$(git rev-parse origin/main)
git fetch -q origin "refs/pull/$PR/head"
git fetch -q origin "refs/pull/$PR/merge"
TEST_MERGE=$(git rev-parse FETCH_HEAD)
[ "$(git rev-parse "$TEST_MERGE^1")" = "$MAIN" ] || fail 'The tested base is stale.'
[ "$(git rev-parse "$TEST_MERGE^2")" = "$SHA" ] || fail 'The tested head is stale.'
git merge-base --is-ancestor "$MAIN" "$SHA" || fail 'Update the candidate from main.'
TESTED_TREE=$(git rev-parse "$TEST_MERGE^{tree}")
[ "$(git rev-parse "$SHA^{tree}")" = "$TESTED_TREE" ] || fail 'The tested tree differs.'
[ -z "$(git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}")" ] || fail 'The release tag exists.'
! git show-ref --verify --quiet "refs/tags/$TAG" || fail 'The local release tag exists.'
PREVIOUS=$(gh release view -R "$REPO" --json tagName --jq .tagName)
[[ "$PREVIOUS" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'No stable release base.'
git fetch -q origin "refs/tags/$PREVIOUS:refs/tags/$PREVIOUS"
git merge-base --is-ancestor "$PREVIOUS" "$MAIN" || fail 'The release base is outside main.'
gh api "repos/$REPO/pulls/$PR" > "$TMP/pr.json"
jq -e --arg sha "$SHA" '.state == "open" and .base.ref == "main" and .head.sha == $sha and .draft == false' "$TMP/pr.json" >/dev/null || fail 'The PR does not match.'
gh api "repos/$REPO/commits/$SHA/check-runs?check_name=ci-passed&filter=latest&per_page=100" > "$TMP/checks.json"
jq -e --arg sha "$SHA" '[.check_runs[] | select(.name == "ci-passed" and .app.id == 15368)] | length == 1 and all(.head_sha == $sha and .status == "completed" and .conclusion == "success")' "$TMP/checks.json" >/dev/null || fail 'CI did not pass on this SHA.'
IDENTITIES=$(git log --format='%an <%ae>|%cn <%ce>' "$PREVIOUS..$SHA")
while IFS= read -r identity; do
  case "$identity" in
    'Fulcra <fulcra@users.noreply.github.com>|Fulcra <fulcra@users.noreply.github.com>'|'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|GitHub <noreply@github.com>') ;;
    *) fail 'Candidate commit identity failed.' ;;
  esac
done <<< "$IDENTITIES"
git show "$MAIN:scripts/check-machine-data.mjs" > "$TMP/check-machine-data.mjs"
node --input-type=module - "$TMP/check-machine-data.mjs" <<'NODE'
const { parsePrivateRules } = await import(process.argv[2]);
if (!parsePrivateRules(process.env.FULCRA_PRIVATE_PATTERNS).length) process.exit(1);
NODE
git worktree add -q --detach "$WORKTREE" "$SHA"
(cd "$WORKTREE" && node "$TMP/check-machine-data.mjs" --commits "$PREVIOUS..$SHA") > "$TMP/scan.log" 2>&1 || fail 'Candidate scan failed.'
git show "$SHA:RELEASE-NOTES-$VERSION.md" > "$TMP/notes.md"
[ -s "$TMP/notes.md" ] || fail 'Release notes are missing.'
echo 'candidate_verified=true'
DISPATCH=$(gh workflow run merge-pr.yml -R "$REPO" --ref main -f pr="$PR" -f sha="$SHA")
RUN_ID=$(printf '%s\n' "$DISPATCH" | sed -n 's|^https://github.com/Subrising/fulcra/actions/runs/\([0-9][0-9]*\)$|\1|p')
[[ "$RUN_ID" =~ ^[0-9]+$ ]] || fail 'No exact workflow run ID. Inspect the dispatch before any retry.'
# One native workflow wait. A failed run stops tagging and publication.
gh run watch "$RUN_ID" -R "$REPO" --exit-status > "$TMP/watch.log" 2>&1 || fail 'Merge workflow failed.'
gh api "repos/$REPO/pulls/$PR" > "$TMP/merged.json"
jq -e --arg sha "$SHA" '.merged == true and .base.ref == "main" and .head.sha == $sha' "$TMP/merged.json" >/dev/null || fail 'The merged PR does not match.'
MERGED=$(jq -er '.merge_commit_sha' "$TMP/merged.json")
[[ "$MERGED" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid merge commit.'
[ "$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)" = "$MERGED" ] || fail 'Main moved after the merge.'
git fetch -q origin main
[ "$(git rev-parse origin/main)" = "$MERGED" ] || fail 'Fetched main differs.'
[ "$(git rev-parse "$MERGED^{tree}")" = "$TESTED_TREE" ] || fail 'The merged tree differs from the tested tree.'
[ "$(git rev-parse "$MERGED^1")" = "$MAIN" ] || fail 'The merge base changed.'
[ "$(git rev-parse "$MERGED^2")" = "$SHA" ] || fail 'The merge head changed.'
[ "$(git show -s --format='%an <%ae>|%cn <%ce>' "$MERGED")" = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|GitHub <noreply@github.com>' ] || fail 'Merge identity failed.'
git -C "$WORKTREE" checkout -q --detach "$MERGED"
(cd "$WORKTREE" && node "$TMP/check-machine-data.mjs" --commits "$PREVIOUS..$MERGED") > "$TMP/scan.log" 2>&1 || fail 'Merged source or commit scan failed.'
echo 'merge_verified=true'
git -c user.name=Fulcra -c user.email=fulcra@users.noreply.github.com tag -a "$TAG" -m "Fulcra $VERSION" "$MERGED"
[ "$(git for-each-ref --format='%(taggername) <%(taggeremail:trim)>' "refs/tags/$TAG")" = 'Fulcra <fulcra@users.noreply.github.com>' ] || fail 'Tag identity failed.'
[ "$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)" = "$MERGED" ] || fail 'Main moved before tag publication.'
git push origin "refs/tags/$TAG"
[ "$(git ls-remote origin "refs/tags/$TAG^{}" | cut -f1)" = "$MERGED" ] || fail 'The remote tag differs.'
gh release create "$TAG" -R "$REPO" --verify-tag --title "Fulcra $VERSION — Source only" --notes-file "$TMP/notes.md"
gh release view "$TAG" -R "$REPO" --json assets,isDraft,tagName --jq '.assets == [] and .isDraft == false and .tagName == "'"$TAG"'"' | grep -qx true || fail 'Source release verification failed.'
echo 'source_release_verified=true'
