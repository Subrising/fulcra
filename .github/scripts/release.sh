#!/bin/bash
# Merge a tested PR through the workflow. Create an annotated tag and source release.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CI_OWNER=${FULCRA_CI_OWNER:-${PASEO_AGENT_ID:-}}
fail() { echo "$1" >&2; exit 1; }
{ [ "$#" -eq 3 ] || [ "$#" -eq 5 ]; } || fail 'usage: release.sh <version> <pr> <sha> [--after-merge <run-id>]'
MERGE_RUN=
if [ "$#" -eq 5 ]; then
  [ "$4" = --after-merge ] || fail 'Invalid resume option.'
  [[ "$5" =~ ^[0-9]+$ ]] || fail 'Invalid merge run ID.'
  MERGE_RUN=$5
fi
VERSION=$1
PR=$2
SHA=$3
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Invalid version.'
[[ "$PR" =~ ^[1-9][0-9]*$ ]] || fail 'Invalid PR number.'
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'Use the full tested SHA.'
if [ -z "$MERGE_RUN" ] && [ -n "$CI_OWNER" ]; then
  [[ "$CI_OWNER" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || fail 'CI owner must be a full lowercase session UUID.'
fi
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
  python3 "$HOME/.local/share/fulcra-cleanup/cleanup_guard.py" remove --path "$WORKTREE" --root "$TMP" || true
  python3 "$HOME/.local/share/fulcra-cleanup/cleanup_guard.py" legacy || true
}
trap cleanup EXIT
git fetch -q origin main
MAIN=$(git rev-parse origin/main)
git fetch -q origin "refs/pull/$PR/head"
if [ -n "$MERGE_RUN" ]; then
  gh api "repos/$REPO/actions/runs/$MERGE_RUN" > "$TMP/run.json"
  jq -e --arg title "Merge PR $PR at $SHA" '.path == ".github/workflows/merge-pr.yml" and .event == "workflow_dispatch" and .head_branch == "main" and .status == "completed" and .conclusion == "success" and .display_title == $title and .repository.full_name == "Subrising/fulcra"' "$TMP/run.json" >/dev/null || fail 'Merge completion does not match.'
  gh api "repos/$REPO/pulls/$PR" > "$TMP/pr.json"
  TEST_MERGE=$(jq -er '.merge_commit_sha' "$TMP/pr.json")
  [[ "$TEST_MERGE" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid merged SHA.'
  git fetch -q origin "$TEST_MERGE"
  MAIN=$(git rev-parse "$TEST_MERGE^1")
else
  git fetch -q origin "refs/pull/$PR/merge"
  TEST_MERGE=$(git rev-parse FETCH_HEAD)
fi
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
if [ -n "$MERGE_RUN" ]; then
  jq -e --arg sha "$SHA" '.merged == true and .base.ref == "main" and .head.sha == $sha' "$TMP/pr.json" >/dev/null || fail 'The merged PR does not match.'
else
  jq -e --arg sha "$SHA" '.state == "open" and .base.ref == "main" and .head.sha == $sha and .draft == false' "$TMP/pr.json" >/dev/null || fail 'The PR does not match.'
fi
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
check_publishers() {
gh api --paginate --slurp "repos/$REPO/actions/workflows?per_page=100" > "$TMP/workflows.json" || return 1
# Ruby's standard YAML parser needs no repository dependencies.
ruby -rjson -ryaml -ropen3 - "$TMP/workflows.json" "$SHA" <<'RUBY'
begin
  read_only_permissions = lambda do |permissions|
    permissions.nil? || permissions == 'read-all' ||
      (permissions.is_a?(Hash) && permissions.values.all? { |level| ['read', 'none'].include?(level) })
  end
  states = {}
  JSON.parse(File.read(ARGV[0])).each do |page|
    page.fetch('workflows').each do |workflow|
      path = workflow.fetch('path')
      state = workflow.fetch('state')
      raise unless path.is_a?(String) && state.is_a?(String)
      states[path] = state
    end
  end
  output, status = Open3.capture2e('git', 'ls-tree', '-rz', '--name-only', ARGV[1], '--', '.github/workflows/')
  raise unless status.success?
  paths = output.split("\0").select { |path| path.match?(/\A\.github\/workflows\/[^\/]+\.ya?ml\z/) }
  # GitHub retains records for deleted files. Only files in this tree can run.
  # New definitions have no API state yet and become active on main.
  paths.each do |path|
    next if states[path]&.start_with?('disabled_')
    source, status = Open3.capture2e('git', 'show', "#{ARGV[1]}:#{path}")
    raise unless status.success? && YAML.parse_stream(source).children.length == 1
    document = YAML.safe_load(source, aliases: true)
    raise unless document.is_a?(Hash)
    # Psych uses YAML 1.1, where an unquoted `on` key becomes true.
    events = document.key?('on') ? document.fetch('on') : document.fetch(true)
    events = { events => nil } if events.is_a?(String)
    events = events.to_h { |event| [event, nil] } if events.is_a?(Array)
    raise unless events.is_a?(Hash) && events.keys.all? { |event| event.is_a?(String) }
    raise if events.key?('release') || events.key?('create')
    next unless events.key?('push')
    push = events.fetch('push')
    if path == '.github/workflows/ci.yml' && document['permissions'] == { 'contents' => 'read' } &&
      push.is_a?(Hash) && push == { 'tags' => ['v*'] } && document['jobs'].is_a?(Hash) &&
      document['jobs'].values.all? { |job| job.is_a?(Hash) && read_only_permissions.call(job['permissions']) }
      next
    end
    # Only explicit branch filters exclude tag pushes.
    raise unless push.is_a?(Hash) &&
      (push.key?('branches') || push.key?('branches-ignore')) &&
      !push.key?('tags') && !push.key?('tags-ignore')
  end
  puts true
rescue StandardError
  warn false
  exit 1
end
RUBY
}
check_publishers || fail 'Workflow trigger check failed.'
echo 'candidate_verified=true'
if [ -z "$MERGE_RUN" ]; then
  DISPATCH=$(gh workflow run merge-pr.yml -R "$REPO" --ref main -f pr="$PR" -f sha="$SHA")
  RUN_ID=$(printf '%s\n' "$DISPATCH" | sed -n 's|^https://github.com/Subrising/fulcra/actions/runs/\([0-9][0-9]*\)$|\1|p')
  [[ "$RUN_ID" =~ ^[0-9]+$ ]] || fail 'No exact workflow run ID. Inspect the dispatch before any retry.'
  echo "merge_dispatched=$RUN_ID"
  if [ -n "$CI_OWNER" ]; then
    node "$SCRIPT_DIR/watch-ci.mjs" "$RUN_ID" "$CI_OWNER"
  else
    echo 'Register the printed run with watch-ci.mjs and the owner session UUID.'
  fi
  echo "Resume only after the completion event: release.sh $VERSION $PR $SHA --after-merge $RUN_ID"
  exit 0
fi
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
check_publishers || fail 'Workflow trigger check failed.'
git -c user.name=Fulcra -c user.email=fulcra@users.noreply.github.com tag -a "$TAG" -m "Fulcra $VERSION" "$MERGED"
[ "$(git for-each-ref --format='%(taggername) <%(taggeremail:trim)>' "refs/tags/$TAG")" = 'Fulcra <fulcra@users.noreply.github.com>' ] || fail 'Tag identity failed.'
[ "$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)" = "$MERGED" ] || fail 'Main moved before tag publication.'
git push origin "refs/tags/$TAG"
[ "$(git ls-remote origin "refs/tags/$TAG^{}" | cut -f1)" = "$MERGED" ] || fail 'The remote tag differs.'
[ "$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)" = "$MERGED" ] || fail 'Main moved before release publication.'
check_publishers || fail 'Workflow trigger check failed.'
gh release create "$TAG" -R "$REPO" --verify-tag --title "Fulcra $VERSION — Source only" --notes-file "$TMP/notes.md"
gh release view "$TAG" -R "$REPO" --json assets,isDraft,tagName --jq '.assets == [] and .isDraft == false and .tagName == "'"$TAG"'"' | grep -qx true || fail 'Source release verification failed.'
echo 'source_release_verified=true'
