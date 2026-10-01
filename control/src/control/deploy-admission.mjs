import { bindGuardHome } from './native-release-hooks.mjs';
import { localJson } from '../local-machine.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { disarmHumanChain } from './human-log.mjs';
import { controlHome } from './home.mjs';
import { releasePaths } from './release-paths.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(directory, '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = localJson('admission-base.json');
// The operator's configured installation (config/runtime.json) and controller home, not code defaults.
const { admissionBase: base, daemonPid } = releasePaths();
const home = controlHome();
const output = path.join(root, 'runtime/admission-preview');
function assertStopped() {
  let listeners;
  try { listeners = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP:6791', '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim(); }
  catch (e) { if (e.status !== 1) throw e; }
  if (listeners) throw new Error('Stop the owned Paseo daemon before changing modules');
  for (const file of [daemonPid]) {
    if (!fs.existsSync(file)) continue;
    const pid = JSON.parse(fs.readFileSync(file)).pid;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') continue; throw e; }
    throw new Error('Owned Paseo supervisor still running');
  }
}
function atomicWrite(file, bytes, mode = 0o600) {
  const tmp = file + '.orca-tmp'; let fd;
  try { fd = fs.openSync(tmp, 'wx', mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(tmp, file); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
// STAGE2 review F1: the release on either side of an apply or a rollback may not run the Stage 2 guard, and
// a boot without it cannot disarm anything. So every release switch breaks the human-input chain itself,
// while the daemon is stopped; every seat whose evidence crosses the switch then declines to the operator.
function rollback(manifest) {
  assertStopped();
  disarmHumanChain(home);
  for (const name of Object.keys(expected)) {
    const current = digest(fs.readFileSync(base + name)), original = fs.readFileSync(path.join(output, path.basename(name) + '.original'));
    if (![manifest.after[name], expected[name]].includes(current) || digest(original) !== expected[name]) throw new Error('Rollback source or backup drift');
  }
  for (const name of Object.keys(expected)) atomicWrite(base + name, fs.readFileSync(path.join(output, path.basename(name) + '.original')), 0o644);
  for (const name of ['active.json', 'loaded.json']) { const file = home + '/admission/' + name; if (fs.existsSync(file)) fs.renameSync(file, file + '.retired-' + Date.now()); }
}
if (process.argv[2] === '--rollback') { rollback(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json')))); console.log('Released modules restored; restart and verify the owned daemon'); process.exit(0); }
const guard = Buffer.from(bindGuardHome(fs.readFileSync(path.join(directory, 'admission-guard.mjs'), 'utf8'), home)), guardHash = digest(guard);
const destination = `${home}/admission/${guardHash}/admission-guard.mjs`;
const replacements = {
  '../session.js': [["    async interruptAgentIfRunning(agentId) {", "    async interruptAgentIfRunning(agentId) {\n        orcaAdmissionGuard({ id: agentId }, '', undefined, false);"], ["        const agent = await this.getAgentPayloadById(resolved.agentId);\n        if (!agent) {", "        const agent = await this.getAgentPayloadById(resolved.agentId);\n        if (agent) agent.labels = { ...agent.labels, 'orca.native-barrier': JSON.stringify(orcaAdmissionObservation(resolved.agentId)) };\n        if (!agent) {"]],
  'lifecycle-command.js': [["export async function cancelAgentRunCommand(dependencies, agentId) {", "export async function cancelAgentRunCommand(dependencies, agentId) {\n    orcaAdmissionGuard({ id: agentId }, '', undefined, false);"]],
  'agent-manager.js': [
    ["    async archiveSnapshot(agentId, archivedAt) {", "    async archiveSnapshot(agentId, archivedAt) {\n        orcaAdmissionGuard({ id: agentId }, '', undefined, false);"],
    ["    closeAgent(agentId) {", "    closeAgent(agentId) {\n        orcaAdmissionGuard({ id: agentId }, '', undefined, false);"],
    ["    async archiveAgent(agentId) {", "    async archiveAgent(agentId) {\n        orcaAdmissionGuard({ id: agentId }, '', undefined, false);"],
    ["    async cancelAgentRun(agentId) {", "    async cancelAgentRun(agentId) {\n        orcaAdmissionGuard({ id: agentId }, '', undefined, false);"],
    ['        const { agent, agentId, pendingRun, prompt, options } = params;\n        try {\n            const result = await agent.session.startTurn(prompt, options);', '        const { agent, agentId, pendingRun, prompt, options } = params;\n        try {\n            orcaAdmissionGuard(agent, prompt, options, pendingRun.settled || Boolean(agent.activeForegroundTurnId));\n        } catch (error) {\n            pendingRun.start = { status: "failed", error: error.message };\n            this.emitState(agent);\n            this.runs.settleForegroundRun(agentId, pendingRun.token);\n            throw error;\n        }\n        try {\n            const result = await agent.session.startTurn(prompt, options);'],
    ['    streamAgent(agentId, prompt, options) {\n        const existingAgent = this.requireSessionAgent(agentId);', '    streamAgent(agentId, prompt, options) {\n        const existingAgent = this.requireSessionAgent(agentId);\n        orcaAdmissionGuard(existingAgent, prompt, options, this.hasInFlightRun(agentId));'],
    ['    async replaceAgentRun(agentId, prompt, options) {\n        const snapshot = this.requireAgent(agentId);', '    async replaceAgentRun(agentId, prompt, options) {\n        const snapshot = this.requireAgent(agentId);\n        orcaAdmissionGuard(snapshot, prompt, options, this.hasInFlightRun(agentId));'],
    ['    async steerOrReplaceActiveTurn(agentId, prompt, options) {\n        const agent = this.requireSessionAgent(agentId);', '    async steerOrReplaceActiveTurn(agentId, prompt, options) {\n        const agent = this.requireSessionAgent(agentId);\n        orcaAdmissionGuard(agent, prompt, options, this.hasInFlightRun(agentId));'],
  ],
  'agent-prompt.js': [["    const record = await params.agentStorage.get(params.agentId);\n    if (record?.archivedAt) {", "    const record = await params.agentStorage.get(params.agentId);\n    if (record?.archivedAt && params.messageId?.startsWith('orca-control:')) throw new Error('Orca native admission refused archived session');\n    if (record?.archivedAt) {"], ['export async function startAgentRun(agentManager, agentId, prompt, logger, options) {\n    const snapshot = agentManager.getAgent(agentId);', 'export async function startAgentRun(agentManager, agentId, prompt, logger, options) {\n    const snapshot = agentManager.getAgent(agentId);\n    orcaAdmissionGuard(snapshot, prompt, options?.runOptions, agentManager.hasInFlightRun(agentId));']],
};
const staged = {};
for (const [name, pairs] of Object.entries(replacements)) {
  let text = fs.readFileSync(base + name, 'utf8');
  if (digest(text) !== expected[name]) throw new Error(`Released source changed: ${name}`);
  for (const [before, after] of pairs) { if (text.split(before).length !== 2) throw new Error('Patch anchor is not unique'); text = text.replace(before, after); }
  staged[name] = `import { guard as orcaAdmissionGuard, observation as orcaAdmissionObservation } from ${JSON.stringify(destination)};\n` + text;
}
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
for (const [name, text] of Object.entries(staged)) { fs.writeFileSync(path.join(output, path.basename(name)), text); execFileSync(process.execPath, ['--check', path.join(output, path.basename(name))]); }
const manifest = { base, before: expected, after: Object.fromEntries(Object.entries(staged).map(([name, text]) => [name, digest(text)])), guard: { path: destination, sha256: guardHash } };
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
if (process.argv[2] === '--apply') {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (process.argv[3] !== head || execFileSync('git', ['status', '--porcelain', '--', 'src/control'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Explicit clean reviewed commit required');
  assertStopped();
  disarmHumanChain(home);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) { if (digest(fs.readFileSync(destination)) !== guardHash) throw new Error('Guard destination drift'); }
  else fs.writeFileSync(destination, guard, { flag: 'wx', mode: 0o600 });
  for (const name of Object.keys(staged)) {
    if (digest(fs.readFileSync(base + name)) !== expected[name]) throw new Error('Concurrent product edit');
    const backup = path.join(output, path.basename(name) + '.original');
    if (fs.existsSync(backup)) { if (digest(fs.readFileSync(backup)) !== expected[name]) throw new Error('Backup drift'); }
    else fs.copyFileSync(base + name, backup, fs.constants.COPYFILE_EXCL);
  }
  try {
    for (const [name, text] of Object.entries(staged)) atomicWrite(base + name, text, 0o644);
    atomicWrite(home + '/admission/active.json', JSON.stringify({ ...manifest, sourceHead: head, appliedAt: new Date().toISOString() }, null, 2));
  } catch (e) { rollback(manifest); throw e; }

}
console.log(JSON.stringify(manifest, null, 2));
