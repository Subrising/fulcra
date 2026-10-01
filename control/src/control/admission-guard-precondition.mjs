import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
// Test-only precondition. Not imported by any production module.
//
// The live controller hashes THIS worktree's src/control/admission-guard.mjs (activation.mjs, via
// bindGuardHome) and refuses every native operation when it does not match the deployed release. So the
// working copy is sometimes deliberately pinned to older content while the control plane runs, and a
// pinned guard is missing whatever the newest commits added to it.
//
// That makes any suite exercising admit() a statement about the guard ON DISK, not the guard the commit
// ships. Where the pinned diff happens to be inert the suite still passes -- which is the dangerous case,
// because the green is not evidence for the shipped guard, it is a coincidence. Where it is not inert the
// failures are generic: queuedSource's `else require(false)` reports "changed queued source or
// configuration" for a branch that simply is not there, which reads as a defect in the caller.
//
// This throws at module load so the suite aborts rather than reporting partial results.
const GUARD = new URL('./admission-guard.mjs', import.meta.url);
// Capability markers, not a digest: a digest comparison against HEAD would also fire while someone is
// legitimately editing the guard, and a tripwire that blocks real work gets switched off.
const MARKERS = ['roleChannelAdmitted', "'role-channel'"];
const digest = value => createHash('sha256').update(value).digest('hex');
// Closes the limit the marker check leaves open: a future pin that happens to preserve the markers.
// The insight is that a pin is by definition a PREVIOUSLY COMMITTED blob, while an in-progress edit is
// not -- which is what a plain digest-versus-HEAD comparison could not distinguish, and why that was
// rejected. Unknown history means silence, never a false alarm.
export function classifyGuard(working, head, historical) {
  if (!working || !head) return 'unknown';
  if (working === head) return 'current';
  return historical.includes(working) ? 'pinned' : 'editing';
}
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
// Returns the commit a pinned working copy was taken from, or null when it is current, being edited, or
// git cannot answer. Only ever consulted after the marker check has already passed.
function pinnedFrom(root, relative) {
  try {
    const working = git(root, ['hash-object', relative]);
    const head = git(root, ['rev-parse', `HEAD:${relative}`]);
    if (classifyGuard(working, head, []) === 'current') return null;
    const commits = git(root, ['log', '--all', '--format=%H', '-n', '200', '--', relative]).split('\n').filter(Boolean);
    const blobs = commits.map(commit => { try { return { commit, blob: git(root, ['rev-parse', `${commit}:${relative}`]) }; } catch { return null; } }).filter(Boolean);
    const hit = blobs.find(b => b.blob === working);
    return classifyGuard(working, head, blobs.map(b => b.blob)) === 'pinned' ? (hit?.commit.slice(0, 8) ?? 'an earlier commit') : null;
  } catch { return null; }
}
export function requireUnpinnedAdmissionGuard() {
  const source = fs.readFileSync(GUARD, 'utf8');
  const missing = MARKERS.filter(marker => !source.includes(marker));
  const root = new URL('../../', import.meta.url).pathname;
  if (!missing.length) {
    // Markers present, so this is not the pin we know about. It may still be one.
    const from = pinnedFrom(root, 'src/control/admission-guard.mjs');
    if (!from) return;
    throw new Error([
      `admission-guard.mjs in this worktree is PINNED to ${from}, so every result from this suite is invalid.`,
      'The markers this check looks for are present, so the pin is a different one -- it was identified as a previously committed blob that is not HEAD.',
      'Do NOT restore it in place: the live controller hashes this file.',
      'Run guard-dependent suites in a detached worktree instead (see DO-NOT-COMMIT-admission-guard-pin.md).',
    ].join('\n'));
  }
  let identity = `working copy sha256 ${digest(source).slice(0, 16)}…`;
  try {
    const head = execFileSync('git', ['show', 'HEAD:src/control/admission-guard.mjs'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    identity += `, HEAD sha256 ${digest(head).slice(0, 16)}…`;
  } catch { identity += ', HEAD unavailable'; }
  throw new Error([
    'admission-guard.mjs in this worktree is PINNED to older content, so every result from this suite is invalid.',
    `Missing from the working copy: ${missing.join(', ')} (${identity}).`,
    'Do NOT restore it in place: the live controller hashes this file and refuses native operations while it differs from the deployed release.',
    'Run guard-dependent suites in a detached worktree instead:',
    '  git worktree add --detach /tmp/orca-guard-check HEAD',
    '  cp <your changed files> /tmp/orca-guard-check/src/control/',
    '  cd /tmp/orca-guard-check && node --test src/control/<suite>.test.mjs',
    '  git worktree remove --force /tmp/orca-guard-check',
    'See DO-NOT-COMMIT-admission-guard-pin.md in the repository root.',
  ].join('\n'));
}
