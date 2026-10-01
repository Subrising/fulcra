// Mutation harness for STAGE2-DESIGN.md s8 (and the carried-over DESIGN.md s6 mutations).
//
// For each mutation: apply the exact textual replacement(s) to the shipped source, REFUSE to score it if
// any replacement did not match exactly once (reported NO-OP (INVALID), never a false kill), run the
// suites, restore the file byte-for-byte, and record KILLED (some test failed) or SURVIVED.
// Usage: node research/stage2-mutations.mjs [id ...]      (from the repository root)
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const C = 'src/control/';
// Each suite is [label, command, args, cwd]. The Python suites carry the F1 disarm in the overlay and launcher.
const SUITES = [
  ...['boot-reestablishment.test.mjs', 'human-log.test.mjs', 'seat-sweep.test.mjs'].map(f => [f, process.execPath, ['--test', C + f], '.']),
  ['permission-overlay-test.py', 'python3', [C + 'permission-overlay-test.py'], '.'],
  ['test_launch.py', 'python3', ['-m', 'unittest', 'test_launch'], 'service-recovery'],
];
const A = C + 'activation.mjs', D = C + 'deploy-admission.mjs', O = C + 'permission-overlay.py', L = 'service-recovery/launch.py';
const G = C + 'boot-reestablishment.mjs', CT = C + 'controller.mjs', R = C + 'rpc.mjs', H = C + 'human-log.mjs',
  SW = C + 'seat-sweep.mjs', SV = C + 'server.mjs', GU = C + 'admission-guard.mjs';
const m = (id, what, edits) => ({ id, what, edits });
export const MUTATIONS = [
  // ---- DESIGN.md s6, carried over (Stage 1) ----
  m('M1', 'drop R1 (mode delegated)', [[G, "if (!row || row.mode !== 'delegated') return decline(", 'if (!row) return decline(']]),
  m('M2', 'reinstate the controlDispatched exemption in prompt identity', [[G, 'return current.lastPromptId === row.expected &&', 'return (current.lastPromptId === row.expected || current.promptClaimsControl === true) &&']]),
  m('M3', '&& -> || in prompt identity', [[G, 'return current.lastPromptId === row.expected && (current.lastUserAt', 'return current.lastPromptId === row.expected || (current.lastUserAt']]),
  m('M4', 'drop the lastUserAt conjunct', [[G, 'return current.lastPromptId === row.expected && (current.lastUserAt ?? null) === (row.expectedAt ?? null);', 'return current.lastPromptId === row.expected;']]),
  m('M5', 'grantedAt !== 1 -> < 1', [[G, 'if (grantedAt !== 1) return', 'if (grantedAt < 1) return']]),
  m('M6', 'write the carried-over grantedAt', [[CT, '.run(current.boot, verdict.grantedAt, id,', '.run(current.boot, row.grantedAt, id,']]),
  m('M7', 'unconditional UPDATE', [[CT, "WHERE id=? AND generation=? AND mode='delegated' AND boot IS ? AND expected IS ? AND expectedAt IS ?\")", 'WHERE id=?")'], [CT, '.run(current.boot, verdict.grantedAt, id, row.generation, previousBoot, row.expected ?? null, row.expectedAt ?? null);', '.run(current.boot, verdict.grantedAt, id);']]),
  m('M8', 'zero-row update counts as success', [[CT, 'if (Number(applied.changes) !== 1) return false;', 'if (false) return false;']]),
  m('M9', 'refusal does not take over', [[CT, "if (verdict.disposition === REVOKE && this.store.get(id)?.mode === 'delegated') this.takeover(", 'if (false) this.takeover(']]),
  m('M10', 'bump generation while re-pinning', [[CT, 'UPDATE sessions SET boot=?,grantedAt=? WHERE id=? AND generation=?', 'UPDATE sessions SET boot=?,grantedAt=?,generation=generation+1 WHERE id=? AND generation=?']]),
  m('M11', 'RPC accepts a caller-supplied boot', [[R, "case 'reestablish': if (!a || Object.keys(a).sort().join() !== 'reason,sessionId')", "case 'reestablish': if (!a || !['reason,sessionId','boot,reason,sessionId'].includes(Object.keys(a).sort().join()))"]]),
  m('M12', 'sessionQuiescent always null', [[G, 'export function sessionQuiescent(current) {', 'export function sessionQuiescent(current) { return null;']]),
  m('M13', 'drop UNIQUE on the operator attempt index', [[G, 'CREATE UNIQUE INDEX IF NOT EXISTS boot_reestablishments_once', 'CREATE INDEX IF NOT EXISTS boot_reestablishments_once']]),
  m('M14', 'drop observationStable', [[CT, 'if (!observationStable(initial, current)) verdict =', 'if (false) verdict =']]),
  m('M15', 'exclusive() no longer refuses', [[CT, "if (this.busy.has(id)) throw new Error('Session operation already in flight');", '']]),
  m('M16', 'drop R6 (authority)', [[G, 'if (facts.authorityKey !== row.authority) return decline(', 'if (false) return decline(']]),
  m('M17', 'drop R2 (boot change), gate and controller', [[G, 'if (current.boot === row.boot) return decline(', 'if (false) return decline('], [CT, 'if (previousBoot && initial.boot === previousBoot) throw', 'if (false) throw']]),
  m('M18', 'drop R7 (seated)', [[G, 'if (!facts.seated) return decline(', 'if (false) return decline(']]),
  m('M19', 'humanInputFence swallows the fence refusal', [[G, 'catch (e) { return { ok: false, grantedAt: null, reason: e.message }; }', 'catch (e) { grantedAt = 1; }']]),
  m('N1', 'drop the second-observation quiescence re-run', [[CT, 'const moved = sessionQuiescent(current);', 'const moved = null;']]),
  m('N2', 'drop R8 (dispatchSupported)', [[G, 'if (!facts.dispatchSupported) return decline(', 'if (false) return decline(']]),
  m('N3', 'an extra automatic caller of the operator trigger in server.mjs', [[SV, 'eventWatchdog = setInterval(', "setInterval(() => void control.reestablish(undefined, 'automatic re-pin'), 60000);\neventWatchdog = setInterval("]]),
  m('K7', 'write and attempt finish no longer atomic', [[CT, 'const changed = this.store.atomic(() => {', 'const changed = (() => {'], [CT, "            return true;\n          });\n          if (!changed)", "            return true;\n          })();\n          if (!changed)"]]),
  // ---- s7, now implementable ----
  m('M20', 'ignore a recorded post-grant human input', [[H, 'if (hit && !dirty) dirty =', 'if (false) dirty =']]),
  m('M21', 'a missing log directory reads as clean', [[H, "catch { return { state: UNAVAILABLE, reason: 'The human-input log directory does not exist', path }; }", 'catch { return { state: CLEAN, reason: null, path }; }']]),
  m('M21b', 'the gate treats unavailable evidence as clean for the sweep', [[G, "if (facts.trigger !== OPERATOR && facts.humanLog?.state !== 'clean') return decline(", "if (facts.trigger !== OPERATOR && facts.humanLog?.state === 'dirty') return decline("]]),
  // ---- Stage 2 ----
  m('S1', 'log written after guard() returns', [[GU, 'recordHuman({ a: agent.id, n: counted ? next : null });', 'setImmediate(() => recordHuman({ a: agent.id, n: counted ? next : null }));']]),
  m('S2', 'no disarm on a write/fsync failure', [[GU, "if (++humanLines >= 100000) disarmHuman(); }\n  catch { disarmHuman(); }", "if (++humanLines >= 100000) disarmHuman(); }\n  catch { }"]]),
  m('S3', 'a log failure refuses the human input', [[GU, "if (++humanLines >= 100000) disarmHuman(); }\n  catch { disarmHuman(); }", "if (++humanLines >= 100000) disarmHuman(); }\n  catch (e) { disarmHuman(); throw e; }"]]),
  m('S4', 'predecessor disarmed only when own log creation succeeded', [[GU, "for (const name of predecessors) try { fs.unlinkSync(HUMAN_DIR + '/' + name); } catch {}", "if (fd !== null) for (const name of predecessors) try { fs.unlinkSync(HUMAN_DIR + '/' + name); } catch {}"]]),
  m('S5', 'drop the anchor check', [[H, 'if (!anchorMatches(successor, log)) faults.push(', 'if (false) faults.push(']]),
  m('S6', 'n >= grantedAt -> n > grantedAt', [[H, 'r.n >= grantedAt', 'r.n > grantedAt']]),
  m('S7', 'ignore uncounted (null) inputs', [[H, '(!grant || r.n === null || r.n >= grantedAt)', '(!grant || r.n >= grantedAt)']]),
  m('S8', 'ignore inputs in boots after the grant boot', [[H, '(!grant || r.n === null || r.n >= grantedAt)', '(grant && (r.n === null || r.n >= grantedAt))']]),
  m('S9', 'the sweep uses the operator trigger', [[CT, ', SWEEP, report)', ', OPERATOR, report)']]),
  m('S10', 'a broken chain is not a fault', [[H, 'if (prev === null) { faults.push(', 'if (prev === null) { if (false) faults.push(']]),
  m('S11', 'accept a torn trailing line', [[H, "if (lines.at(-1) !== '') fault(", "if (false) fault("]]),
  m('S12', 'several armed markers still name a predecessor', [[GU, 'if (predecessors.length === 1) try {', 'if (predecessors.length >= 1) try {']]),
  m('S12b', 'reader accepts a header naming another boot', [[H, '|| value.v !== 1 || value.boot !== boot)', '|| value.v !== 1)']]),
  m('S13', 'drop the seal requirement', [[H, 'if (!log.sealed) faults.push(', 'if (false) faults.push(']]),
  m('S13b', 'the guard never writes the seal', [[GU, "process.once('exit', code => { recordHuman({ end: 'exit', code }); humanLog = null; });", '']]),
  m('S14', 'R9a declines instead of revoking', [[G, "if (facts.humanLog?.state === 'dirty') return revoke(", "if (facts.humanLog?.state === 'dirty') return decline("]]),
  m('S14b', 'R9a applies to the sweep only (D4 removed)', [[G, "if (facts.humanLog?.state === 'dirty') return revoke(", "if (facts.trigger !== OPERATOR && facts.humanLog?.state === 'dirty') return revoke("]]),
  m('S15', 'a fault masks dirty', [[H, "  if (dirty) return { state: DIRTY, reason: dirty, path };\n  if (faults.length) return { state: UNAVAILABLE, reason: faults[0], path };", "  if (faults.length) return { state: UNAVAILABLE, reason: faults[0], path };\n  if (dirty) return { state: DIRTY, reason: dirty, path };"]]),
  m('S16', 'drop UNIQUE on seat_sweeps', [[G, 'CREATE UNIQUE INDEX IF NOT EXISTS seat_sweeps_once', 'CREATE INDEX IF NOT EXISTS seat_sweeps_once']]),
  m('S17', 'the sweep claims in the operator table', [[CT, "INSERT INTO ${trigger === SWEEP ? 'seat_sweeps' : 'boot_reestablishments'} VALUES", 'INSERT INTO boot_reestablishments VALUES'], [CT, "const table = trigger === SWEEP ? 'seat_sweeps' : 'boot_reestablishments';", "const table = 'boot_reestablishments';"]]),
  m('S18', 'first sweep moved after the socket listens', [[SV, 'await Promise.race([sweep(), new Promise(resolve => setTimeout(resolve, 60000).unref())]);\n', ''], [SV, 'eventsReady = true;\n', 'eventsReady = true;\nawait Promise.race([sweep(), new Promise(resolve => setTimeout(resolve, 60000).unref())]);\n']]),
  m('S18b', 'a third sweep caller', [[SV, 'eventWatchdog = setInterval(', 'setTimeout(() => sweep(), 5000);\neventWatchdog = setInterval(']]),
  m('S19', 'an absent mode file means on', [[SW, "catch { return { mode: 'off', reason: 'No mode file; the sweep is off by default' }; }", "catch { return { mode: 'on', reason: null }; }"]]),
  m('S19b', 'mode file privacy not checked', [[SW, '|| (stat.mode & 0o077) !== 0 ', '']]),
  m('S20', 'report mode writes', [[CT, '        else if (report) {', '        else if (false) {']]),
  m('S21', 'reader privacy/regular-file checks relaxed', [[H, 'const privateEntry = (stat, directory) => (directory ? stat.isDirectory() : stat.isFile()) && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;', 'const privateEntry = () => true;']]),
  m('S22', 'no cycle detection', [[H, "if (seen.has(prev)) { faults.push('The human-input chain contains a cycle'); break; }", '']]),
  m('S22b', 'no hop bound', [[H, 'if (hop >= maxHops) {', 'if (false) {']]),
  // ---- Review F1 / F2 (C2-REVIEW.md) ----
  m('F1a', 'reader ignores the receipt gap', [[H, '    const gap = receiptGap(successor, log);\n    if (gap) faults.push(gap);', '']]),
  m('F1b', 'reader does not require the predecessor receipt to survive', [[H, "  if (!later.includes(log.boot)) return", "  if (false) return"]]),
  m('F1c', 'reader accepts a missing receipt snapshot', [[H, "  if (!Array.isArray(later) || !Array.isArray(earlier)) return", "  if (!Array.isArray(later) || !Array.isArray(earlier)) return null; if (false) return"]]),
  m('F1d', 'guard snapshots receipts AFTER writing its own', [[GU, "const PRIOR_RECEIPTS = DEPLOYED ? receiptBoots() : null;\n", ''], [GU, "  writeLine(fd, { v: 1, boot: BOOT, pid: process.pid, prev, prevBytes, prevSha256, receipts: PRIOR_RECEIPTS });", "  writeLine(fd, { v: 1, boot: BOOT, pid: process.pid, prev, prevBytes, prevSha256, receipts: receiptBoots() });"]]),
  m('F1e', 'guard writes no receipt snapshot', [[GU, 'prevSha256, receipts: PRIOR_RECEIPTS });', 'prevSha256, receipts: null });']]),
  m('F1f', 'deploy-admission rollback does not disarm', [[D, "function rollback(manifest) {\n  assertStopped();\n  disarmHumanChain(home);", "function rollback(manifest) {\n  assertStopped();"]]),
  m('F1g', 'deploy-admission apply does not disarm', [[D, "  assertStopped();\n  disarmHumanChain(home);\n  fs.mkdirSync(path.dirname(destination)", "  assertStopped();\n  fs.mkdirSync(path.dirname(destination)"]]),
  m('F1h', 'permission overlay switch does not disarm', [[O, "        disarm_human_chain(self.home); checkpoint('disarmed')\n", "        checkpoint('disarmed')\n"]]),
  m('F1i', 'launcher trusts any release on disk', [[L, "        if hashlib.sha256(guard).hexdigest() != active['guard']['sha256'] or b\"/admission/human'\" not in guard:\n            return False", "        return True"]]),
  m('F1j', 'launcher does not disarm', [[L, "    return None if stage2_release_on_disk(home) else disarm_human_chain(home)", "    return None"]]),
  m('F1k', 'witness never fires', [[A, "  try { verifyActivationAt(home, port); return false; } catch { return true; }", "  return false;"]]),
  m('F1l', 'witness removed from controller startup', [[SV, "witnessDaemon();\nconst local = await connectNative()", "const local = await connectNative()"]]),
  m('F1m', 'witness removed from the watchdog', [[SV, "eventWatchdog = setInterval(() => { witnessDaemon(); void", "eventWatchdog = setInterval(() => { void"]]),
  m('F2', 'anchor compares length only', [[H, "  && successor.header.prevSha256 === createHash('sha256').update(log.bytes).digest('hex');", ";"]]),
];

// Crash safety. A host crash on 2026-09-23 killed this harness mid-run and left mutation S21 (the reader's
// privacy checks switched off) live in the working tree. So the original bytes are journalled BEFORE any
// mutation is written, and a journal found at startup is restored first, loudly, before anything else runs.
const JOURNAL = 'research/.stage2-mutation-in-flight.json';
if (fs.existsSync(JOURNAL)) {
  const { id, originals } = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
  for (const [file, text] of Object.entries(originals)) fs.writeFileSync(file, text);
  fs.unlinkSync(JOURNAL);
  console.error(`RESTORED ${Object.keys(originals).join(', ')} from an interrupted run (mutation ${id} was live)`);
}
const journal = (id, originals) => { const tmp = JOURNAL + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ id, originals: Object.fromEntries(originals) })); fs.renameSync(tmp, JOURNAL); };

function apply(mutation) {
  const originals = new Map();
  for (const [file, from, to] of mutation.edits) {
    const text = originals.get(file) ?? fs.readFileSync(file, 'utf8');
    if (!originals.has(file)) originals.set(file, text);
    const current = fs.readFileSync(file, 'utf8');
    if (current.split(from).length !== 2) { for (const [f, t] of originals) fs.writeFileSync(f, t); if (fs.existsSync(JOURNAL)) fs.unlinkSync(JOURNAL); return null; }
    journal(mutation.id, originals);
    fs.writeFileSync(file, current.replace(from, () => to));
  }
  return originals;
}

const only = process.argv.slice(2), rows = [];
for (const mutation of MUTATIONS.filter(x => !only.length || only.includes(x.id))) {
  const originals = apply(mutation);
  if (!originals) { rows.push({ id: mutation.id, what: mutation.what, result: 'NO-OP (INVALID)', failing: [] }); continue; }
  try {
    const failing = [];
    for (const [label, command, args, cwd] of SUITES) {
      const run = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300000 });
      const out = (run.stdout ?? '') + (run.stderr ?? '');
      const names = [...out.matchAll(/^✖ (.+?) \(\d/gm), ...out.matchAll(/^(?:FAIL|ERROR): (\S+)/gm)].map(x => x[1]).filter(n => n !== 'failing tests:');
      if (run.status !== 0) failing.push(...(names.length ? [...new Set(names)].map(n => `${label}: ${n}`) : [`${label}: (suite failed to load)`]));
    }
    rows.push({ id: mutation.id, what: mutation.what, result: failing.length ? 'KILLED' : 'SURVIVED', failing });
  } finally { for (const [file, text] of originals) fs.writeFileSync(file, text); fs.unlinkSync(JOURNAL); }
  const r = rows.at(-1); console.log(`${r.id.padEnd(5)} ${r.result.padEnd(9)} ${r.what}${r.failing.length ? '  <- ' + r.failing.length + ' test(s)' : ''}`);
}
fs.writeFileSync('research/stage2-mutations.result.json', JSON.stringify(rows, null, 2) + '\n');
const bad = rows.filter(r => r.result !== 'KILLED');
console.log(`\n${rows.length - bad.length} / ${rows.length} killed; ${bad.length} not killed${bad.length ? ': ' + bad.map(r => r.id + ' ' + r.result).join(', ') : ''}`);
process.exit(bad.length ? 1 : 0);
