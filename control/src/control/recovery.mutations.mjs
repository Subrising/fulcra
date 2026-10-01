// DESIGN-R §10 mutation run for R1. Not a test file (no .test. in the name), so the ordinary sweep never runs it.
//
//   node src/control/recovery.mutations.mjs [ids...]
//
// Same discipline as seat-inbox.mutations.mjs: exact-once anchors (an anchor that does not occur exactly once
// aborts the run), the NAMED test must fail, and the original bytes are restored in a finally. Runs one suite at a
// time -- never in parallel (IO-RULES.md).
//
// R-M17, R-M18, R-M21 and R-M22 are host mutations (R3a/R3b, Paseo). They ship with those host releases.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const C = path.join(here, 'controller.mjs'), V = path.join(here, 'recovery.mjs'), R = path.join(here, 'rpc.mjs'), G = path.join(here, 'admission-guard.mjs'),
  P = path.join(here, 'completion.mjs'), S = path.join(here, 'repo-state.mjs');
const SUITE = path.join(here, 'recovery.test.mjs');
const M = [
  { id: 'R-M1', why: 'a boot change no longer takes the session over', expect: 'R-M1 R-M3', edits: [[C, "(current.humanAt ?? 0) >= fresh.grantedAt || (current.boot ?? null) !== fresh.boot || (!knownWake", "(current.humanAt ?? 0) >= fresh.grantedAt || (!knownWake"]] },
  { id: 'R-M2', why: 'the interruption row written outside the takeover transaction', expect: 'R-M2', edits: [[C,
    "takeover(id, reason, evidence) { return this.store.atomic(() => { const before = this.store.get(id), generation = before?.generation; const grant = this.store.transferRows(id, 'human', reason); this.recovery?.record(before, grant.generation, reason, evidence);",
    "takeover(id, reason, evidence) { this.recovery?.record(this.store.get(id), (this.store.get(id)?.generation ?? 0) + 1, reason, evidence); return this.store.atomic(() => { const before = this.store.get(id), generation = before?.generation; const grant = this.store.transferRows(id, 'human', reason);"]] },
  { id: 'R-M3', why: 'expected captured after transferRows wiped it', expect: 'R-M1 R-M3', edits: [[C,
    "const before = this.store.get(id), generation = before?.generation; const grant = this.store.transferRows(id, 'human', reason); this.recovery?.record(before,",
    "const generation = this.store.get(id)?.generation; const grant = this.store.transferRows(id, 'human', reason); const before = { ...this.store.get(id), mode: 'delegated', generation }; this.recovery?.record(before,"]] },
  { id: 'R-M4', why: 'human input at the new boot classified as boot', expect: 'R-M4', edits: [[V, "if (current.saturated || (current.humanAt ?? 0) !== 0) return 'boot-human';", "if (current.saturated) return 'boot-human';"]] },
  { id: 'R-M5', why: 'any R5 failure classified as boot-mid-dispatch', expect: 'R-M5', edits: [[V,
    "if (current.promptClaimsControl && current.lastPromptId && current.lastPromptId === this.control.latestDispatched(row)) return 'boot-mid-dispatch';\n      return 'boot-human';",
    "return 'boot-mid-dispatch';"]] },
  { id: 'R-M6', why: 'G3 dropped: human input since the boot does not refuse', expect: 'R-M6', edits: [[V, "  if (!fence.ok) return no('revoke', fence.reason);\n", '']] },
  { id: 'R-M7', why: 'G4 dropped: input since the interruption does not refuse', expect: 'R-M7', edits: [[V, "  if (current.lastPromptId !== (at.lastPromptId ?? null) || (current.lastUserAt ?? null) !== (at.lastUserAt ?? null)) return no('revoke', 'The session has received input since it was interrupted');\n", '']] },
  { id: 'R-M8', why: 'G2 dropped: the generation pin', expect: 'R-M8', edits: [[V, "  if (s.mode !== 'human' || s.generation !== i.toGeneration) return no('revoke', 'Session control changed since the interruption was recorded');\n", '']] },
  { id: 'R-M9', why: 'session-resume reachable before the operator gate', expect: 'R-M9', edits: [[R, "    if (request.method === 'inspect') {", "    if (request.method === 'session-resume') return control.recovery.resume(a);\n    if (request.method === 'inspect') {"]] },
  { id: 'R-M10', why: 'resume re-dispatches the original prompt', expect: 'R-M10', edits: [[V, "    const r = record.result, text = r.continuationText;", "    const r = record.result, text = this.lastBrief(this.row(r.interruptionId)) ?? r.continuationText;"]] },
  { id: 'R-M11', why: 'a routine grant revoked by the operator is re-conferred', expect: 'R-M11', edits: [[V, "        if (!current || current.revoked) grants.permission", "        if (!current) grants.permission"]] },
  { id: 'R-M12a', why: 'the batch does not put the leader first', expect: 'the batch resumes the leader first', edits: [[V, "    const items = [...a.items].sort((x, y) => leader(x) - leader(y) || x.sessionId.localeCompare(y.sessionId)), results = [];", "    const items = [...a.items], results = [];"]] },
  { id: 'R-M12b', why: 'an inherited grant restored as a root grant', expect: 'never restored stale', edits: [[V,
    "} else grants.permission = await this.control.permissions.inherit(a.sessionId, i.grants.permission.rootSession) ??",
    "} else grants.permission = await this.control.permissions.grant({ sessionId: a.sessionId, expectedGeneration: generation, reason: 'Mutant: inherited grant restored as a root grant' }) ??"]] },
  { id: 'R-M13', why: 'reconcile marks delivered on the receipt alone', expect: 'R-M13', edits: [[V, "      const confirmed = row.mode === 'delegated' &&", "      const confirmed = true || row.mode === 'delegated' &&"]] },
  { id: 'R-M14', why: 'reconcile abandons a delivery with no receipt', expect: 'R-M14', edits: [[V, "    if (!receipt) return 'receipt-none';", "    if (!receipt) { this.store.finish(d.id, 'abandoned', { ...d.result, note: 'Mutant auto-abandon' }); return 'abandoned'; }"]] },
  { id: 'R-M15', why: 'reconcile takes over a row it cannot classify', expect: 'R-M15', edits: [[V, "    if (receipt.state !== 'completed') return 'receipt-' + receipt.state;", "    if (receipt.state !== 'completed') { this.control.takeover(d.session, 'Mutant: pending receipt taken over'); return 'receipt-' + receipt.state; }"]] },
  { id: 'R-M16', why: 'completionFor ignores the host interruption marker', expect: 'R-M16', edits: [[P, "    if (ended && mark && progress.found &&", "    if (false && mark && progress.found &&"]] },
  // ---- Review R (REVIEW-R.md) follow-ups: each must now fail a named test ----
  { id: 'X1', why: 'F2a: the double-reboot decline dropped', expect: 'F2a', edits: [[V, "  if (current.boot !== at.boot) return no('decline', 'The host restarted again since the interruption was recorded; wait for it to be recorded afresh');\n", '']] },
  { id: 'X12', why: 'F2b: reconcile confirms despite human input', expect: 'F2b', edits: [[V, " && current.lastPromptId === d.id && (current.humanAt ?? 0) < row.grantedAt;", " && current.lastPromptId === d.id;"]] },
  { id: 'X3', why: 'G7 dropped: a changed-yet-valid task authority adopted', expect: 'unreadable task authority says so', edits: [[V, "  if (facts.authorityKey !== undefined && facts.authorityKey !== i.authority) return no('decline', 'Task authority changed since this session was delegated; resume needs an explicit handback');\n", '']] },
  { id: 'F1a', why: 'authority lookup no longer deduped/cached', expect: 'looked up once per task', edits: [[V, "    if (hit && this.now() - hit.at < this.limits.authorityTtl) return hit.value;\n", '']] },
  { id: 'F1b', why: 'an unreadable authority reported as changed', expect: 'unreadable task authority says so', edits: [[V, "  if (facts.authorityUnavailable) return no('decline', `Task authority could not be read (${facts.authorityUnavailable}); retry when the task tracker is reachable`);\n", '']] },
  { id: 'F1c', why: 'recovery-status no longer single-flight', expect: 'concurrent reads share one flight', edits: [[V, "    if (this.statusFlight) return this.statusFlight;\n", '']] },
  { id: 'F1d', why: 'the status reuse window dropped', expect: 'concurrent reads share one flight', edits: [[V, "    if (this.statusCache && this.now() < this.statusCache.expires) return Promise.resolve(this.statusCache.value);\n", '']] },
  { id: 'F1e', why: 'a write no longer drops the cached read', expect: 'concurrent reads share one flight', edits: [[V, "      this.invalidate();\n      return { interruptionId: i.id, state: 'dismissed'", "      return { interruptionId: i.id, state: 'dismissed'"]] },
  { id: 'F1f', why: 'no per-read budget on daemon observations', expect: 'per-read budgets', edits: [[V, "      else if (inspects >= this.limits.inspectsPerRead) observeError", "      else if (false) observeError"]] },
  { id: 'F1g', why: 'no per-read budget on git reads', expect: 'per-read budgets', edits: [[V, "      if (!repo && repoReads < this.limits.repoSessionsPerRead) {", "      if (!repo) {"]] },
  { id: 'F4', why: 'the quoted brief can close its own fence', expect: 'R-M10', edits: [[V, "export const fenced = brief => brief.replace(/-{5}\\s*(BEGIN|END) QUOTED LAST INSTRUCTION/gi, '[marker removed]');", "export const fenced = brief => brief;"]] },
  { id: 'R-M19', why: 'admission guard edited', expect: 'R-M19', edits: [[G, "export const BOOT = randomUUID();", "export const BOOT = randomUUID(); // edited"]] },
  { id: 'R-M20a', why: 'the repo read allows optional locks', expect: 'R-M20', edits: [[S, "GIT_OPTIONAL_LOCKS: '0'", "GIT_OPTIONAL_LOCKS: '1'"]] },
  { id: 'R-M20b', why: 'the repo read fetches', expect: 'R-M20', edits: [[S, "export const GIT_ARGS = Object.freeze(['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);", "export const GIT_ARGS = Object.freeze(['fetch', '--porcelain=v2', '--branch', '--untracked-files=normal']);"]] },
  { id: 'R-M20c', why: 'the repo read walks node_modules', expect: 'R-M20', edits: [[S, " || e.name === 'node_modules') continue;", ") continue;"]] },
];
function failing(suite) {
  let out;
  try { out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', suite], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { out = String(e.stdout ?? ''); }
  return [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map(x => x[1]);
}
const only = process.argv.slice(2);
let bad = 0;
for (const m of M.filter(x => !only.length || only.includes(x.id))) {
  const originals = new Map();
  try {
    for (const [file, from, to] of m.edits) {
      originals.set(file, originals.get(file) ?? fs.readFileSync(file, 'utf8'));
      const current = fs.readFileSync(file, 'utf8');
      if (current.split(from).length !== 2) throw Error(`${m.id}: anchor does not occur exactly once in ${path.basename(file)}`);
      fs.writeFileSync(file, current.replace(from, () => to));
    }
    const failed = failing(m.suite ?? SUITE), killed = failed.some(name => name.includes(m.expect));
    if (!killed) bad++;
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${m.id.padEnd(6)} ${m.why} -> expected red: "${m.expect}"; red: ${failed.length ? failed.map(n => n.slice(0, 40)).join(' | ') : 'none'}`);
  } finally {
    for (const [file, text] of originals) fs.writeFileSync(file, text);
  }
}
console.log(bad ? `${bad} mutation(s) SURVIVED` : 'all mutations killed');
process.exitCode = bad ? 1 : 0;
