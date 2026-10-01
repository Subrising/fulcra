import { localJson } from '../local-machine.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bindGuardHome, CLAUDE_QUERY_MODULE, patchNativeHooks } from './native-release-hooks.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const control = path.dirname(fileURLToPath(import.meta.url));
export function validateStagePaths(outputRoot, controllerHome, journalFile) {
  if (![outputRoot, controllerHome, journalFile].every(p => typeof p === 'string' && path.isAbsolute(p) && path.resolve(p) === p) || journalFile !== path.join(controllerHome, 'journal.sqlite') || fs.realpathSync(path.dirname(outputRoot)) !== path.dirname(outputRoot) || fs.existsSync(outputRoot)) throw Error('New private staging root and exact controller journal required');
  if (controllerHome !== outputRoot) {
    const home = fs.lstatSync(controllerHome), journal = fs.lstatSync(journalFile);
    if (!home.isDirectory() || home.uid !== process.getuid() || home.mode & 0o077 || fs.realpathSync(controllerHome) !== controllerHome || !journal.isFile() || journal.uid !== process.getuid() || journal.mode & 0o077 || journal.nlink !== 1) throw Error('Existing controller state must be private, owned and unaliased');
  }
}
// Reviewed native sources are pinned by exact commit and by the sha256 of every durable file
// staged from it. Selecting a different reviewed source never relaxes those checks and never
// changes where staging writes; the layout is a separate explicit input below.
// `maintained` is the long-standing pin. `reviewed` records the already built native at
// /path/to/reviewed-native, measured read only on 2026-09-18 from a
// clean worktree; re-verify with `git -C <sourceRoot> rev-parse HEAD` plus `shasum -a 256` of
// each listed path under packages/server before trusting it for a rollout.
export const NATIVE_SOURCES = new Proxy({}, { get: (_target, key) => localJson('native-sources.json')[key] });
const DURABLE_NAMES = ["src/server/agent/agent-manager.ts", "src/server/agent/file-agent-timeline-store.ts", "dist/server/server/agent/agent-manager.js", "dist/server/server/agent/file-agent-timeline-store.js", "src/server/agent/agent-prompt.ts", "dist/server/server/agent/agent-prompt.js", "src/server/session.ts", "src/server/agent/lifecycle-command.ts", "dist/server/server/session.js", "dist/server/server/agent/lifecycle-command.js"];
export function resolveNativeSource(selection = 'maintained') {
  const pin = typeof selection === 'string' ? NATIVE_SOURCES[selection] : selection;
  if (!pin || typeof pin !== 'object' || !/^[a-f0-9]{40}$/.test(pin.head ?? '')) throw Error('Reviewed native source pin with an exact commit required');
  const durable = pin.durableFiles;
  if (!durable || typeof durable !== 'object' || Object.keys(durable).length !== DURABLE_NAMES.length || !DURABLE_NAMES.every(name => /^[a-f0-9]{64}$/.test(durable[name] ?? ''))) throw Error('Native source pin must hash every durable native file');
  return { head: pin.head, durableFiles: Object.fromEntries(DURABLE_NAMES.map(name => [name, durable[name]])) };
}
// Legacy keeps the guards inside the new immutable staging root and leaves the installed
// controller home untouched; portable owns the controller admission directory the deployed
// guard reads. authority.mjs imports ../portable-config.mjs, so that module is always staged
// beside the guard directory and resolves in both layouts.
export function stageDestinations({ outputRoot, controllerHome, layout }) {
  if (layout !== 'legacy' && layout !== 'portable') throw Error('Explicit legacy or portable staging layout required');
  const guards = layout === 'legacy' ? path.join(outputRoot, 'control') : path.join(controllerHome, 'admission');
  return { layout, guards, configFile: path.join(path.dirname(guards), 'portable-config.mjs'), activeFile: layout === 'portable' ? path.join(guards, 'active.json') : null };
}
export function assertStageDestinations({ guards, configFile, activeFile }) {
  for (const target of [guards, configFile, activeFile]) if (target && fs.existsSync(target)) throw Error('Staging destination already exists: ' + target);
}
// The portable installer (scripts/orca/bootstrap.mjs) already pins the native commit it selected
// into the installed home, and upstream native updates move that commit. Its call keeps the
// original semantics: any exact selected commit, verified against that clean checkout, with the
// durable build hashes recorded. Explicit nativeSource selections stay pinned to reviewed hashes,
// and neither form decides the layout for the other.
export function resolveStageSelection({ layout, nativeSource, portableSourceHead }) {
  if (portableSourceHead === undefined) return { layout: layout ?? 'legacy', nativeSource: nativeSource ?? 'maintained', selectedHead: null };
  if (layout !== undefined || nativeSource !== undefined) throw Error('Use either portableSourceHead or explicit nativeSource and layout');
  if (!/^[a-f0-9]{40}$/.test(portableSourceHead)) throw Error('Selected portable native source with an exact commit required');
  return { layout: 'portable', nativeSource: null, selectedHead: portableSourceHead };
}
// H7b: the one host-owned close path. patchNativeManager exports it from agent-manager.js; patchNativeShutdown makes
// bootstrap's closeAllAgents its only caller; checkShutdownCloseCallers proves no other staged file names it.
export const SHUTDOWN_CLOSE = 'orcaShutdownClose';
export const SHUTDOWN_CLOSE_FILES = Object.freeze(['agent/agent-manager.js', 'bootstrap.js']);
export function patchNativeShutdown(before) {
  let code = before;
  const once = (from, what) => { if (code.split(from).length !== 2) throw Error('Native shutdown anchor changed: ' + what); };
  // The order the exemption relies on, in the host's stop(): ingress frozen, then prepareForShutdown, then the closure.
  const stop = code.indexOf('    const stop = async () => {\n');
  once('    const stop = async () => {\n', 'stop()');
  const at = s => { const i = code.indexOf(s, stop); if (i < 0) throw Error('Native shutdown anchor changed: ' + s); return i; };
  if (!(at('        wsServer?.prepareForShutdown();\n') < at('        agentManager.prepareForShutdown();\n') && at('        agentManager.prepareForShutdown();\n') < at('        await closeAllAgents(logger, agentManager);\n')))
    throw Error('Native shutdown anchor changed: stop() order');
  if (code.split('closeAllAgents(').length !== 3) throw Error('Native shutdown anchor changed: closeAllAgents is defined once and called once, from stop()');
  once('async function closeAllAgents(logger, agentManager) {\n    const agents = agentManager.listAgents();\n    await Promise.all(agents.map(async (agent) => {\n        try {\n            await agentManager.closeAgent(agent.id);\n', 'closeAllAgents');
  const call = '            await agentManager.closeAgent(agent.id);\n';
  once(call, 'the closure call');
  code = code.replace(call, `            await agentManager[${SHUTDOWN_CLOSE}](agent.id);\n`);
  return `import { ${SHUTDOWN_CLOSE} } from "./agent/agent-manager.js";\n` + code;
}
// Every .js file under a staged server dist (overrides: text to read instead of the file, for tests of a pristine dist).
export function checkStagedShutdownClose(server, overrides = {}) {
  const files = {};
  for (const entry of fs.readdirSync(server, { recursive: true })) { const name = String(entry); if (name.endsWith('.js')) files[name] = overrides[name] ?? fs.readFileSync(path.join(server, name), 'utf8'); }
  for (const [name, text] of Object.entries(overrides)) files[name] = text;
  checkShutdownCloseCallers(files);
  return Object.keys(files).length;
}
// No staged file but the two that define and use it may name the host-owned close path.
export function checkShutdownCloseCallers(files) {
  const named = Object.entries(files).filter(([, text]) => text.includes(SHUTDOWN_CLOSE)).map(([name]) => name).sort();
  if (JSON.stringify(named) !== JSON.stringify([...SHUTDOWN_CLOSE_FILES].sort())) throw Error('The host-owned shutdown close is named outside closeAllAgents: ' + named.join(', '));
  const uses = files['bootstrap.js'].split(`[${SHUTDOWN_CLOSE}](`).length - 1, defs = files['agent/agent-manager.js'].split(`[${SHUTDOWN_CLOSE}](`).length - 1;
  if (uses !== 1 || defs !== 1) throw Error(`The host-owned shutdown close must have exactly one definition and one call (${defs}, ${uses})`);
}

// The agent-manager.js patch, as text (exported for the H7b tests): the turn fences, the human-input fences and
// their imports. Every anchor must occur exactly once, so a product change fails staging instead of skipping a fence.
export function patchNativeManager(before, { journalFile, guards }) {
  let code = before;
  const replace = (from, to) => { if (code.split(from).length !== 2) throw Error('Native manager anchor changed'); code = code.replace(from, to); };
  replace('const result = await agent.session.startTurn(prompt, options);', `const fenced = orcaTurnOptions({ journalFile: ${JSON.stringify(journalFile)}, agent, getAgent: id => this.getAgent(id), prompt, options, busy: () => pendingRun.settled || Boolean(agent.activeForegroundTurnId), symbol: ORCA_CODEX_TURN });\n            let result;\n            try { result = await agent.session.startTurn(prompt, fenced); }\n            catch (error) { if (fenced !== options && error instanceof OrcaQuotaError) throw orcaQuotaFailure(error, fenced); throw error; }`);
  const entry = name => `orcaTurnOptions({ journalFile: ${JSON.stringify(journalFile)}, agent: ${name}, getAgent: id => this.getAgent(id), prompt, options, busy: () => this.hasInFlightRun(agentId), symbol: ORCA_CODEX_TURN });`;
  replace('const existingAgent = this.requireSessionAgent(agentId);\n        this.logger.trace({', 'const existingAgent = this.requireSessionAgent(agentId);\n        ' + entry('existingAgent') + '\n        this.logger.trace({');
  for (const [name, variable, getter] of [['replaceAgentRun', 'snapshot', 'requireAgent'], ['steerAgentRun', 'agent', 'requireSessionAgent'], ['steerOrReplaceActiveTurn', 'agent', 'requireSessionAgent']]) {
    const anchor = `async ${name}(agentId, prompt, options) {\n        const ${variable} = this.${getter}(agentId);`;
    replace(anchor, anchor + '\n        ' + entry(variable));
  }
  // Human input (the admission guard's durable log and in-memory counter) is every close, archive and cancel through
  // the manager's methods -- always, whoever calls them and whatever state the host is in. H7b: the host's OWN shutdown
  // closure is not a client's act. bootstrap's stop() calls prepareForShutdown() and then closeAllAgents, which closed
  // every loaded agent through closeAgent; fenced, that wrote one "human input" per agent into the exiting boot's log,
  // and after every clean host restart the seat sweep found every seat dirty and revoked it (H7 rehearsal, 26 Sep).
  // The exemption is a CALL PATH, not a state: closeAllAgents (patchNativeShutdown) calls the symbol-keyed method
  // below, which no client verb can name (a Symbol never crosses a JSON boundary) and which staging proves nothing else
  // references (checkShutdownCloseCallers). closeAgent itself stays fenced, so a client close admitted before the
  // shutdown and resumed after it is still recorded (Codex review H7b B1). The symbol path also requires the host to be
  // shutting down (prepareForShutdown, the product's only false assignment of acceptingAgentRegistrations, pinned
  // below); called at any other time it is exactly closeAgent, fenced. Archive, cancel and archive-snapshot keep their
  // fences unconditionally. Both paths share one close body, so in-flight close joining is unchanged.
  if (code.split('this.acceptingAgentRegistrations = false;').length !== 2 || code.split('acceptingAgentRegistrations = true;').length !== 2
    || code.split('prepareForShutdown() {\n        this.acceptingAgentRegistrations = false;\n    }').length !== 2) throw Error('Native shutdown anchor changed');
  const fence = 'orcaHumanFence({ id: agentId }, "", undefined, false);';
  replace('    closeAgent(agentId) {\n', `    closeAgent(agentId) {\n        ${fence}\n        return this[ORCA_CLOSE_AGENT](agentId);\n    }\n`
    + `    [${SHUTDOWN_CLOSE}](agentId) {\n        if (this.acceptingAgentRegistrations !== false) return this.closeAgent(agentId);\n        return this[ORCA_CLOSE_AGENT](agentId);\n    }\n`
    + '    [ORCA_CLOSE_AGENT](agentId) {\n');
  for (const signature of ['async archiveAgent(agentId) {', 'async cancelAgentRun(agentId) {', 'async archiveSnapshot(agentId, archivedAt) {']) replace(signature, signature + '\n        ' + fence);
  code = `const ORCA_CLOSE_AGENT = Symbol('orca.closeAgent'), ${SHUTDOWN_CLOSE} = Symbol('orca.shutdownClose');\nexport { ${SHUTDOWN_CLOSE} };\n` + code;
  code = `import { nativeTurnOptions as orcaTurnOptions, quotaFailure as orcaQuotaFailure } from ${JSON.stringify(path.join(guards, 'native-turn.mjs'))};\nimport { guard as orcaHumanFence } from ${JSON.stringify(path.join(guards, 'admission-guard.mjs'))};\nimport { CODEX_TURN_ADMISSION as ORCA_CODEX_TURN } from './agent-sdk-types.js';\nimport { CodexQuotaError as OrcaQuotaError } from './providers/codex/quota.js';\n` + code;
  return code;
}

export function stageNativeTurn({ sourceRoot, outputRoot, journalFile, controllerHome = outputRoot, layout, nativeSource, portableSourceHead }) {
  const selection = resolveStageSelection({ layout, nativeSource, portableSourceHead });
  const pin = selection.selectedHead ? null : resolveNativeSource(selection.nativeSource);
  const destinations = stageDestinations({ outputRoot, controllerHome, layout: selection.layout });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  const controllerSource = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: control, encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: control, encoding: 'utf8' }).trim()) };
  if (head !== (pin?.head ?? selection.selectedHead) || execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8' }).trim()) throw Error('Exact clean selected durable native source required');
  // A pinned selection must match its reviewed hashes; a selected commit records the hashes of
  // the clean checkout it just verified. Both produce the same durable manifest shape.
  const durableFiles = Object.fromEntries(DURABLE_NAMES.map(file => {
    const observed = sha(fs.readFileSync(path.join(sourceRoot, 'packages/server', file)));
    if (pin && observed !== pin.durableFiles[file]) throw Error('Pinned durable native build drift: ' + file);
    return [file, observed];
  }));
  validateStagePaths(outputRoot, controllerHome, journalFile);
  assertStageDestinations(destinations);
  fs.mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  const base = path.join(sourceRoot, 'packages/server'), destination = path.join(outputRoot, 'packages/server');
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(base, 'dist'), path.join(destination, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(base, 'package.json'), path.join(destination, 'package.json'));
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(outputRoot, 'package.json'));
  fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(outputRoot, 'node_modules'));
  if (fs.existsSync(path.join(base, 'node_modules'))) fs.symlinkSync(path.join(base, 'node_modules'), path.join(destination, 'node_modules'));
  const guards = destinations.guards; fs.mkdirSync(guards, { recursive: false, mode: 0o700 });
  const configBytes = fs.readFileSync(path.join(control, '../portable-config.mjs'));
  fs.writeFileSync(destinations.configFile, configBytes, { flag: 'wx', mode: 0o600 });
  const portableConfig = { path: destinations.configFile, sha256: sha(configBytes) };
  const files = ['admission-guard.mjs', 'native-turn.mjs', 'quota-wait.mjs', 'quota-observation.mjs', 'authority.mjs'];
  const controller = {}, controllerSources = {};
  for (const name of files) {
    const source = fs.readFileSync(path.join(control, name)); controllerSources[name] = sha(source);
    const bytes = name === 'admission-guard.mjs' ? bindGuardHome(source.toString('utf8'), controllerHome) : source;
    fs.writeFileSync(path.join(guards, name), bytes); controller[name] = sha(bytes);
  }
  const manager = path.join(destination, 'dist/server/server/agent/agent-manager.js'), before = fs.readFileSync(manager, 'utf8');
  const code = patchNativeManager(before, { journalFile, guards });
  fs.writeFileSync(manager, code); execFileSync(process.execPath, ['--check', manager]);
  const promptFile = path.join(destination, 'dist/server/server/agent/agent-prompt.js'), promptBefore = fs.readFileSync(promptFile, 'utf8');
  const archived = '    if (record?.archivedAt) {';
  if (promptBefore.split(archived).length !== 2) throw Error('Native archive anchor changed');
  const promptAfter = promptBefore.replace(archived, `    if (record?.archivedAt && params.messageId?.startsWith('orca-control:')) throw Error('Orca native admission refused archived session');\n` + archived);
  fs.writeFileSync(promptFile, promptAfter); execFileSync(process.execPath, ['--check', promptFile]);
  const server = path.join(destination, 'dist/server/server');
  const names = ['agent/agent-manager.js', 'agent/agent-prompt.js', 'session.js', 'agent/lifecycle-command.js', CLAUDE_QUERY_MODULE];
  const sources = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(server, name), 'utf8')]));
  const patched = patchNativeHooks(sources, path.join(guards, 'admission-guard.mjs')), hooks = {};
  for (const [name, text] of Object.entries(patched)) {
    const file = path.join(server, name); fs.writeFileSync(file, text); execFileSync(process.execPath, ['--check', file]);
    hooks[name] = { path: file, before: sha(sources[name]), after: sha(text) };
  }
  // H7b: bootstrap's closeAllAgents becomes the only caller of the host-owned shutdown close, and no other staged file
  // may name it (every .js file under the server dist is read).
  const bootstrap = path.join(server, 'bootstrap.js'), bootstrapBefore = fs.readFileSync(bootstrap, 'utf8'), bootstrapAfter = patchNativeShutdown(bootstrapBefore);
  fs.writeFileSync(bootstrap, bootstrapAfter); execFileSync(process.execPath, ['--check', bootstrap]);
  hooks['bootstrap.js'] = { path: bootstrap, before: sha(bootstrapBefore), after: sha(bootstrapAfter) };
  checkStagedShutdownClose(server);
  const manifest = { sourceRoot, sourceHead: head, durableFiles, outputRoot, controllerHome, journalFile, layout: selection.layout, nativeSource: selection.nativeSource ?? 'selected', durablePinned: Boolean(pin), guards, portableConfig, controller, controllerSource, controllerSources, hooks, prompt: { path: promptFile, before: sha(promptBefore), after: sha(fs.readFileSync(promptFile)) }, manager: { path: manager, before: sha(before), after: sha(fs.readFileSync(manager)) }, scope: 'Owned private staged daemon only; requires matching candidate controller semantics; production activation is not configured' };
  fs.writeFileSync(path.join(outputRoot, 'native-turn-stage.json'), JSON.stringify(manifest, null, 2));
  // Portable staging owns its controller admission directory, so it publishes the activation
  // record here. Legacy staging leaves the installed active.json to the reviewed deployment
  // step; manifest.portableConfig gives that step the entry it must cover.
  if (destinations.activeFile) {
    const after = Object.fromEntries([...names, 'bootstrap.js'].map(name => [name, sha(fs.readFileSync(path.join(server, name)))]));
    fs.writeFileSync(destinations.activeFile, JSON.stringify({ base: server + '/', after,
      guard: { path: path.join(guards, 'admission-guard.mjs'), sha256: controller['admission-guard.mjs'] },
      files: { ...Object.fromEntries(files.map(name => [path.join(guards, name), controller[name]])), [portableConfig.path]: portableConfig.sha256 }, sourceHead: head }), { flag: 'wx', mode: 0o600 });
  }
  return manifest;
}
