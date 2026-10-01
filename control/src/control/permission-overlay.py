"""One stopped native-overlay transaction, composed with the dependency record."""
import importlib.util, json, os, stat, subprocess, sys, uuid
from pathlib import Path

# Machine-specific legacy deployment inputs live outside the tracked tree.
def local_machine(key):
    config = Path(__file__).resolve().parents[3] / 'local' / 'machine-values.json'
    if not config.is_file():
        raise ValueError('Populate local/machine-values.json before running this legacy deployment tool')
    value = json.loads(config.read_text()).get(key)
    if not isinstance(value, str) or not value.startswith('/'):
        raise ValueError('Missing canonical local machine path: ' + key)
    return value
SPEC = importlib.util.spec_from_file_location('dependency_switch', Path(__file__).parents[1] / 'dependency-switch.py')
m = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(m)
HOME = Path(local_machine("legacyControllerHome"))
BASE = Path('@getpaseo/server/dist/server/server/agent')
SOURCE = Path(__file__).parent

def replace_once(text, before, after):
    if text.count(before) != 1: raise ValueError('native patch anchor is not unique')
    return text.replace(before, after)

def disarm_human_chain(home):
    # STAGE2 review F1: any release switch, forward or back, may put a daemon on this host that does not run
    # the Stage 2 guard, and such a boot cannot disarm anything itself. Break the human-input chain here so
    # every seat whose evidence crosses this switch declines (mirrors human-log.mjs disarmHumanChain).
    directory = Path(home) / 'admission' / 'human'
    if not directory.is_dir(): return []
    names = sorted(n for n in os.listdir(directory) if n.startswith('armed-'))
    for name in names: os.unlink(directory / name)
    m.sync(directory); return names

def patch_module(name, data, old_guard, new_guard):
    text = replace_once(data.decode(), json.dumps(old_guard), json.dumps(new_guard))
    if name == 'agent-manager.js':
        text = replace_once(text, 'guard as orcaAdmissionGuard, observation as orcaAdmissionObservation', 'guard as orcaAdmissionGuard, observation as orcaAdmissionObservation, permissionGuard as orcaPermissionGuard')
        before = '    async respondToPermission(agentId, requestId, response) {\n        const agent = this.requireAgent(agentId);'
        text = replace_once(text, before, before + '\n        requestId = orcaPermissionGuard(agent, requestId, response);')
    if name == 'agent-prompt.js':
        before = 'export async function sendPromptToAgent(params) {'
        text = replace_once(text, before, before + "\n    if (!params.messageId?.startsWith('orca-control:')) orcaAdmissionGuard({ id: params.agentId }, '', undefined, false);")
    if name == '../session.js':
        before = '            await respondToAgentPermission({\n                agentManager: this.agentManager,\n                agentId,\n                requestId,\n                response,\n                logger: this.sessionLogger,\n            });'
        text = replace_once(text, before, before + '\n            if (requestId.startsWith("orca-permission:")) this.emit({ type: "agent_permission_resolved", payload: { agentId, requestId, resolution: response } });')
    return text.encode()

# P1 R-F-A1 (S-2): the Claude SDK launch choke point, the same text native-release-hooks.mjs writes. The baseline
# module does not import the guard yet; once patched it does, so a later overlay re-points it like any other.
CLAUDE_QUERY = 'providers/claude/query.js'
CLAUDE_LAUNCH = '        options: applyRuntimeSettingsToClaudeOptions(input.options, context),'
def patch_deny_module(data, guard):
    text = data.decode()
    if 'orcaDenyClaudeQueryOptions' in text or 'admission-guard' in text: raise ValueError('native deny module already patched')
    text = replace_once(text, CLAUDE_LAUNCH, CLAUDE_LAUNCH.replace('(input.options, context)', '(orcaDenyClaudeQueryOptions(input.options), context)'))
    return ('import { denyClaudeQueryOptions as orcaDenyClaudeQueryOptions } from ' + json.dumps(guard) + ';\n' + text).encode()

class Overlay:
    def __init__(self, root=m.ROOT, home=HOME, sides=m.SIDES):
        self.root, self.home = Path(root), Path(home)
        self.switch = m.Switch(self.root, sides); m.identity(self.home)
        self.operation = self.root / 'permission-overlay-operation.json'
    def directory(self, operation_id):
        if str(uuid.UUID(operation_id)) != operation_id: raise ValueError('invalid overlay identity')
        p = self.root / ('permission-overlay-' + operation_id); m.identity(p); return p
    def write(self, directory, target, data, mode):
        # Temporary files stay outside node_modules; a crash cannot contaminate its fingerprint.
        if target.parent.resolve(strict=True) != target.parent or target.parent.stat().st_dev != directory.stat().st_dev: raise ValueError('overlay destination is not on the same real filesystem')
        temp = directory / ('pending-' + str(uuid.uuid4()))
        with temp.open('xb') as f:
            os.chmod(temp, mode); f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(temp, target); m.sync(target.parent); m.sync(directory)
    def prepare(self, owners, source_head, expected):
        if os.path.lexists(self.operation): raise ValueError('an overlay operation already exists')
        record = self.switch.load(); live = self.root / 'node_modules'
        self.switch.metadata(self.root, 'after')
        if record['phase'] != 'complete' or record.get('nativeOverlay') or m.identity(live) != record['after']['identity'] or m.fingerprint(live) != record['after']['treeDigest']: raise ValueError('complete repaired dependency side required')
        active_bytes = m.regular(self.home / 'admission/active.json'); active = json.loads(active_bytes)
        if m.sha(active_bytes) != expected['active'] or active['guard'] != expected['guard'] or active['after'] != expected['modules'] or active['sourceHead'] != expected['sourceHead'] or active['base'] != str(live / BASE) + '/': raise ValueError('installed guard baseline changed')
        deny = expected.get('denyModules', {})
        if list(deny) != [CLAUDE_QUERY] or CLAUDE_QUERY in active['after']: raise ValueError('Claude launch choke point missing from the baseline')
        guard = replace_once(m.regular(SOURCE / 'admission-guard.mjs').decode(), "const HOME = process.env.ORCA_ADMISSION_HOME ?? '/path/to/unconfigured/controller';", 'const HOME = ' + json.dumps(str(HOME)) + ';').encode(); guard_hash = m.sha(guard)
        guard_path = self.home / 'admission' / guard_hash / 'admission-guard.mjs'
        if m.sha(m.regular(Path(active['guard']['path']))) != active['guard']['sha256']: raise ValueError('baseline guard changed')
        operation_id = str(uuid.uuid4()); directory = self.root / ('permission-overlay-' + operation_id); directory.mkdir(mode=0o700)
        for side in ['before', 'after']: (directory / side).mkdir(mode=0o700)
        modules = {}; before_inventory = m.inventory(live); after_inventory = json.loads(json.dumps(before_inventory))
        for name, old_hash in {**expected['modules'], **deny}.items():
            relative = os.path.normpath(str(BASE / name)); target = live / relative; old = m.regular(target)
            if m.sha(old) != old_hash: raise ValueError('native module baseline changed')
            new = patch_deny_module(old, str(guard_path)) if name in deny else patch_module(name, old, active['guard']['path'], str(guard_path)); filename = Path(name).name
            for side, data in [('before', old), ('after', new)]: (directory / side / filename).write_bytes(data); os.chmod(directory / side / filename, 0o400)
            subprocess.run(['/opt/homebrew/opt/node@24/bin/node', '--check', str(directory / 'after' / filename)], check=True, capture_output=True)
            mode = stat.S_IMODE(target.stat().st_mode); modules[relative] = {'filename': filename, 'before': m.sha(old), 'after': m.sha(new), 'mode': mode}
            after_inventory[relative] = {'mode': mode, 'sha256': m.sha(new)}
        # The patched launch module joins active.after, so activation proves the running daemon loaded it.
        after = {**active, 'after': {name: modules[os.path.normpath(str(BASE / name))]['after'] for name in [*active['after'], *deny]}, 'guard': {'path': str(guard_path), 'sha256': guard_hash}, 'sourceHead': source_head, 'permissionOverlay': operation_id}
        after_bytes = json.dumps(after, indent=2).encode()
        for name, data in [('before/active.json', active_bytes), ('after/active.json', after_bytes), ('after/admission-guard.mjs', guard)]:
            (directory / name).write_bytes(data); os.chmod(directory / name, 0o400)
        manifest = {'schema': 1, 'id': operation_id, 'sourceHead': source_head, 'captured': [{'pid': p['pid'], 'started': p['started']} for p in m.capture(owners)], 'watched': m.required_watched(self.root), 'dependency': record, 'modules': modules, 'active': {'before': m.sha(active_bytes), 'after': m.sha(after_bytes)}, 'guard': after['guard'], 'tree': {'before': record['after']['treeDigest'], 'after': m.sha(json.dumps(after_inventory, sort_keys=True).encode())}}
        encoded = json.dumps(manifest, indent=2).encode(); (directory / 'manifest.json').write_bytes(encoded); os.chmod(directory / 'manifest.json', 0o400)
        for folder in [directory / 'before', directory / 'after', directory]:
            for file in folder.iterdir():
                if file.is_file(): m.sync(file)
            m.sync(folder)
        m.atomic(self.operation, json.dumps({'id': operation_id, 'manifest': m.sha(encoded), 'phase': 'prepared', 'target': 'before'}).encode()); return manifest
    def load(self):
        state = json.loads(m.regular(self.operation)); directory = self.directory(state['id']); encoded = m.regular(directory / 'manifest.json')
        if m.sha(encoded) != state['manifest'] or state.get('phase') not in ['prepared', 'switching', 'complete'] or state.get('target') not in ['before', 'after']: raise ValueError('overlay manifest or operation changed')
        manifest = json.loads(encoded)
        if manifest.get('schema') != 1 or manifest.get('id') != state['id']: raise ValueError('invalid overlay manifest')
        return state, manifest, directory
    def move(self, target, stopped=m.assert_stopped, checkpoint=lambda name: None):
        if target not in ['before', 'after']: raise ValueError('invalid overlay side')
        state, manifest, directory = self.load(); live = self.root / 'node_modules'; record = self.switch.load(); original = manifest['dependency']
        self.switch.metadata(self.root, 'after')
        if record['phase'] not in ['complete', 'switching'] or record['after']['treeDigest'] not in manifest['tree'].values(): raise ValueError('unknown dependency overlay phase or fingerprint')
        expected_record = json.loads(json.dumps(record)); expected_record.pop('nativeOverlay', None); expected_record['phase'] = original['phase']; expected_record['after']['treeDigest'] = original['after']['treeDigest']
        if expected_record != original or record.get('nativeOverlay') not in [None, manifest['id']] or m.identity(live) != original['after']['identity']: raise ValueError('dependency record or active side changed')
        current_inventory = m.inventory(live); normalized = json.loads(json.dumps(current_inventory))
        for relative, item in manifest['modules'].items():
            if os.path.normpath(relative) != relative or relative.startswith('../') or Path(relative).is_absolute() or Path(relative).name != item['filename']: raise ValueError('invalid overlay module path')
            for side in ['before', 'after']:
                if m.sha(m.regular(directory / side / item['filename'])) != item[side]: raise ValueError('overlay backup changed')
            actual = current_inventory.get(relative)
            if actual not in [{'mode': item['mode'], 'sha256': item[side]} for side in ['before', 'after']]: raise ValueError('unknown native module bytes')
            normalized[relative] = {'mode': item['mode'], 'sha256': item['before']}
        if m.sha(json.dumps(normalized, sort_keys=True).encode()) != manifest['tree']['before']: raise ValueError('unrelated dependency bytes changed')
        active_path = self.home / 'admission/active.json'; active_hash = m.sha(m.regular(active_path))
        if active_hash not in manifest['active'].values(): raise ValueError('unknown active admission manifest')
        for side in ['before', 'after']:
            if m.sha(m.regular(directory / side / 'active.json')) != manifest['active'][side]: raise ValueError('active manifest backup changed')
        old_guard = json.loads(m.regular(directory / 'before/active.json'))['guard']
        if m.sha(m.regular(Path(old_guard['path']))) != old_guard['sha256']: raise ValueError('rollback guard changed')
        guard = m.regular(directory / 'after/admission-guard.mjs'); guard_path = Path(manifest['guard']['path'])
        if guard_path != self.home / 'admission' / m.sha(guard) / 'admission-guard.mjs' or m.sha(guard) != manifest['guard']['sha256']: raise ValueError('invalid overlay guard')
        if os.path.lexists(guard_path) and m.regular(guard_path) != guard: raise ValueError('overlay guard destination changed')
        stopped(manifest['captured'], manifest['watched']); state.update(phase='switching', target=target); m.atomic(self.operation, json.dumps(state).encode()); checkpoint('intent')
        record['phase'] = 'switching'; record['nativeOverlay'] = manifest['id']; self.switch.save(record); checkpoint('blocked')
        disarm_human_chain(self.home); checkpoint('disarmed')
        guard_path.parent.mkdir(mode=0o700, exist_ok=True); m.identity(guard_path.parent)
        if not guard_path.exists(): self.write(directory, guard_path, guard, 0o600)
        checkpoint('guard')
        for index, (relative, item) in enumerate(manifest['modules'].items()):
            stopped(manifest['captured'], manifest['watched']); self.write(directory, live / relative, m.regular(directory / target / item['filename']), item['mode']); checkpoint('module-' + str(index))
        stopped(manifest['captured'], manifest['watched']); self.write(directory, active_path, m.regular(directory / target / 'active.json'), 0o600); checkpoint('active')
        if m.fingerprint(live) != manifest['tree'][target]: raise ValueError('completed overlay tree does not match')
        self.switch.metadata(self.root, 'after')
        record['after']['treeDigest'] = manifest['tree'][target]; record['phase'] = 'complete'
        if target == 'before': record.pop('nativeOverlay', None)
        self.switch.save(record); checkpoint('dependency-complete')
        state['phase'] = 'complete'; m.atomic(self.operation, json.dumps(state).encode()); checkpoint('complete'); return manifest

if __name__ == '__main__':
    operation = Overlay()
    with operation.switch.locked():
        if len(sys.argv) == 4 and sys.argv[1] == 'prepare':
            head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip()
            if subprocess.check_output(['git', 'status', '--porcelain', '--', 'src/control', 'src/dependency-switch.py'], cwd=SOURCE.parents[1], text=True).strip(): raise SystemExit('Clean reviewed source required')
            result = operation.prepare([int(sys.argv[2]), int(sys.argv[3])], head, json.loads(m.regular(Path(__file__).resolve().parents[3] / 'local' / 'permission-base.json')))
        elif len(sys.argv) == 2 and sys.argv[1] in ['before', 'after']: result = operation.move(sys.argv[1])
        else: raise SystemExit('Use permission-overlay.py prepare CONTROLLER_PID PASEO_SUPERVISOR_PID | before | after')
    print(json.dumps({'id': result['id'], 'tree': result['tree'], 'sourceHead': result['sourceHead']}))
