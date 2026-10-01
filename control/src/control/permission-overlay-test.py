import importlib.util, json, os, signal, subprocess, sys, tempfile, unittest, uuid
from pathlib import Path
spec = importlib.util.spec_from_file_location('overlay', Path(__file__).with_name('permission-overlay.py'))
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p); m = p.m

# The compiled Claude launch module in miniature: the same anchor, and a query factory standing in for the SDK.
QUERY = ('function applyRuntimeSettingsToClaudeOptions(options, context) {\n    return { ...options, spawnClaudeCodeProcess: context.spawn };\n}\n'
         'export function claudeQuery(input, context = {}) {\n    const launchQuery = context.queryFactory;\n    return launchQuery({\n        ...input,\n'
         '        options: applyRuntimeSettingsToClaudeOptions(input.options, context),\n    });\n}\n')
NODE = '/opt/homebrew/opt/node@24/bin/node'

class OverlayTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix='orca-overlay-'); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve(); home = root / 'controller'; (home / 'admission' / 'old').mkdir(parents=True)
        old_guard = home / 'admission/old/admission-guard.mjs'; old_guard.write_text('export function guard() {}\nexport function observation() {}\n')
        imported = 'import { guard as orcaAdmissionGuard, observation as orcaAdmissionObservation } from ' + json.dumps(str(old_guard)) + ';\n'
        modules = {
            'agent-manager.js': imported + 'export class Manager {\n    async respondToPermission(agentId, requestId, response) {\n        const agent = this.requireAgent(agentId);\n        return agent.session.respondToPermission(requestId, response);\n    }\n}\n',
            'agent-prompt.js': imported + 'export async function sendPromptToAgent(params) {\n await params.wait();\n}\n',
            'lifecycle-command.js': imported + 'export function stop() {}\n', '../session.js': imported + 'export class Session {\n async handle(agentId, requestId, response) {\n            await respondToAgentPermission({\n                agentManager: this.agentManager,\n                agentId,\n                requestId,\n                response,\n                logger: this.sessionLogger,\n            });\n }\n}\n'}
        operation_id = str(uuid.uuid4()); sides = {}
        for side, label in [('before', 'original'), ('after', 'prepared')]:
            directory = root / ('dependency-' + label + '-' + operation_id); directory.mkdir(); sides[side] = {}
            for key, name in [('package', 'package.json'), ('lock', 'package-lock.json')]:
                data = json.dumps({'side': side, 'key': key}).encode(); (directory / name).write_bytes(data); sides[side][key] = m.sha(data)
                if side == 'before': (root / name).write_bytes(data)
            tree = root / 'node_modules' if side == 'before' else directory / 'node_modules'; (tree / p.BASE).mkdir(parents=True)
            for name, text in {**modules, p.CLAUDE_QUERY: QUERY}.items(): (tree / p.BASE / name).parent.mkdir(parents=True, exist_ok=True); (tree / p.BASE / name).write_text(text)
            (tree / 'marker').write_text(side)
        prepared = root / ('dependency-prepared-' + operation_id)
        (prepared / 'preparation.json').write_text(json.dumps({'id': operation_id, 'beforeDigest': m.fingerprint(root / 'node_modules'), 'afterDigest': m.fingerprint(prepared / 'node_modules')}))
        switch = m.Switch(root, sides); switch.initialize(operation_id, [{'pid': 99999999, 'started': 'absent'}], m.required_watched(root)); switch.move('after', stopped=lambda *args: None)
        active = {'base': str(root / 'node_modules' / p.BASE) + '/', 'before': {}, 'after': {name: m.sha(text.encode()) for name, text in modules.items()}, 'guard': {'path': str(old_guard), 'sha256': m.sha(old_guard.read_bytes())}, 'sourceHead': 'old-reviewed-source'}
        active_bytes = json.dumps(active).encode(); (home / 'admission/active.json').write_bytes(active_bytes)
        expected = {'active': m.sha(active_bytes), 'guard': active['guard'], 'modules': active['after'], 'denyModules': {p.CLAUDE_QUERY: m.sha(QUERY.encode())}, 'sourceHead': active['sourceHead']}
        operation = p.Overlay(root, home, sides); manifest = operation.prepare([os.getpid()], 'new-reviewed-source', expected)
        self.expected = expected
        return operation, manifest
    def assert_side(self, operation, manifest, side):
        record = operation.switch.load(); self.assertEqual(record['phase'], 'complete'); self.assertEqual(m.fingerprint(operation.root / 'node_modules'), manifest['tree'][side]); self.assertEqual(record['after']['treeDigest'], manifest['tree'][side])
        active = json.loads(m.regular(operation.home / 'admission/active.json'))
        self.assertEqual(m.sha(m.regular(operation.home / 'admission/active.json')), manifest['active'][side])
        self.assertEqual(m.sha(m.regular(Path(active['guard']['path']))), active['guard']['sha256'])
        for name, expected in active['after'].items(): self.assertEqual(m.sha(m.regular(Path(os.path.normpath(str(Path(active['base']) / name))))), expected)
        self.assertEqual(bool(record.get('nativeOverlay')), side == 'after')
    def test_apply_rollback_reapply_and_dependency_rollback_order(self):
        operation, manifest = self.fixture()
        with operation.switch.locked(): operation.move('after', stopped=lambda *args: None)
        self.assert_side(operation, manifest, 'after')
        with self.assertRaisesRegex(ValueError, 'overlay'): operation.switch.move('before', stopped=lambda *args: None)
        operation.move('before', stopped=lambda *args: None); self.assert_side(operation, manifest, 'before')
        operation.move('after', stopped=lambda *args: None); self.assert_side(operation, manifest, 'after')
        operation.move('before', stopped=lambda *args: None); operation.switch.move('before', stopped=lambda *args: None)
        self.assertEqual((operation.root / 'node_modules/marker').read_text(), 'before')
        with self.assertRaisesRegex(ValueError, 'active side|metadata'): operation.move('after', stopped=lambda *args: None)
    def test_every_switch_breaks_the_stage2_human_input_chain(self):
        # Review F1: the release on the other side of a switch may not run the Stage 2 guard, and such a boot
        # cannot disarm anything itself. Both directions must leave no armed marker, and must not touch logs.
        operation, manifest = self.fixture(); human = operation.home / 'admission' / 'human'; human.mkdir(mode=0o700)
        for target in ['after', 'before']:
            boot = str(uuid.uuid4()); (human / ('armed-' + boot)).write_bytes(b''); (human / (boot + '.log')).write_text('{}\n')
            with operation.switch.locked(): operation.move(target, stopped=lambda *args: None)
            self.assertEqual(sorted(n for n in os.listdir(human) if n.startswith('armed-')), [])
            self.assertTrue((human / (boot + '.log')).exists())
    def test_process_death_at_each_boundary_recovers_both_directions(self):
        script = '''import importlib.util,json,os,signal,sys
spec=importlib.util.spec_from_file_location('overlay',sys.argv[1]);p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
op=p.Overlay(sys.argv[2],sys.argv[3],json.loads(sys.argv[4]))
def checkpoint(name):
 if name==sys.argv[5]:os.kill(os.getpid(),signal.SIGKILL)
with op.switch.locked():op.move('after',stopped=lambda *args:None,checkpoint=checkpoint)
'''
        for boundary in ['intent', 'blocked', 'disarmed', 'guard', 'module-0', 'module-1', 'module-2', 'module-3', 'module-4', 'active', 'dependency-complete', 'complete']:
            for target in ['before', 'after']:
                with self.subTest(boundary=boundary, target=target):
                    operation, manifest = self.fixture()
                    result = subprocess.run([sys.executable, '-c', script, str(Path(p.__file__)), str(operation.root), str(operation.home), json.dumps(operation.switch.sides), boundary], capture_output=True)
                    self.assertEqual(result.returncode, -signal.SIGKILL, result.stderr)
                    with operation.switch.locked(): operation.move(target, stopped=lambda *args: None)
                    self.assert_side(operation, manifest, target)
    def test_unknown_bytes_manifests_fingerprints_and_running_owner_refuse(self):
        for mutation in ['module', 'unrelated', 'active', 'fingerprint', 'guard', 'package', 'lock']:
            operation, manifest = self.fixture()
            if mutation == 'module': (operation.root / 'node_modules' / p.BASE / 'agent-manager.js').write_text('unknown')
            elif mutation == 'unrelated': (operation.root / 'node_modules' / 'marker').write_text('unknown')
            elif mutation == 'active': (operation.home / 'admission/active.json').write_text('{}')
            elif mutation == 'guard': (operation.home / 'admission/old/admission-guard.mjs').write_text('unknown')
            elif mutation in ['package', 'lock']: (operation.root / ('package.json' if mutation == 'package' else 'package-lock.json')).write_text('{}')
            else:
                record = operation.switch.load(); record['after']['treeDigest'] = 'unknown'; operation.switch.save(record)
            with self.assertRaises(ValueError): operation.move('after', stopped=lambda *args: None)
            self.assertEqual(json.loads(operation.operation.read_bytes())['phase'], 'prepared')
        operation, manifest = self.fixture()
        def running(*args): raise ValueError('owned process active')
        with self.assertRaisesRegex(ValueError, 'active'): operation.move('after', stopped=running)
        self.assert_side(operation, manifest, 'before')
    def test_patch_places_human_barrier_before_first_await_and_permission_gate_before_provider(self):
        operation, manifest = self.fixture(); directory = operation.directory(manifest['id'])
        prompt = (directory / 'after/agent-prompt.js').read_text(); manager = (directory / 'after/agent-manager.js').read_text()
        self.assertLess(prompt.index('orcaAdmissionGuard({ id: params.agentId }'), prompt.index('await params.wait'))
        self.assertLess(manager.index('requestId = orcaPermissionGuard('), manager.index('return agent.session.respondToPermission'))
        session = (directory / 'after/session.js').read_text(); self.assertLess(session.index('await respondToAgentPermission('), session.index('this.emit({ type: "agent_permission_resolved"'))
        with self.assertRaisesRegex(ValueError, 'unique'): p.patch_module('agent-manager.js', b'unknown', 'old', 'new')

    def test_the_claude_launch_choke_point_carries_the_controller_home_deny(self):
        # R-F-A1 (prime S-2): the overlay patches the one module every Claude SDK process is started from, with the
        # deny imported from the same pinned guard as the other hooks, and records it in active.after.
        operation, manifest = self.fixture(); directory = operation.directory(manifest['id'])
        query = (directory / 'after/query.js').read_text()
        self.assertTrue(query.startswith('import { denyClaudeQueryOptions as orcaDenyClaudeQueryOptions } from ' + json.dumps(manifest['guard']['path']) + ';\n'))
        self.assertIn('options: applyRuntimeSettingsToClaudeOptions(orcaDenyClaudeQueryOptions(input.options), context),', query)
        self.assertEqual((directory / 'before/query.js').read_text(), QUERY)
        self.assertEqual(json.loads((directory / 'after/active.json').read_text())['after'][p.CLAUDE_QUERY], m.sha(query.encode()))
        self.assertNotIn(p.CLAUDE_QUERY, json.loads((directory / 'before/active.json').read_text())['after'])
        # One choke point: no call site in the manager carries its own copy.
        self.assertNotIn('Deny', (directory / 'after/agent-manager.js').read_text())
        with operation.switch.locked(): operation.move('after', stopped=lambda *args: None)
        self.assert_side(operation, manifest, 'after')
        live = operation.root / 'node_modules' / p.BASE / p.CLAUDE_QUERY
        run = ('const {claudeQuery}=await import(process.argv[1]);let seen;'
               'claudeQuery({prompt:"",options:{cwd:"/private/work",disallowedTools:["WebFetch"],settings:{permissions:{allow:["Read"]}}}},{queryFactory:q=>{seen=q.options;},spawn:()=>null});'
               'console.log(JSON.stringify(seen));')
        seen = json.loads(subprocess.run([NODE, '--input-type=module', '-e', run, live.as_uri()], check=True, capture_output=True, text=True).stdout)
        secret = 'Read(/' + str(p.HOME) + '/operator.secret)'
        self.assertIn(secret, seen['disallowedTools']); self.assertIn(secret, seen['settings']['permissions']['deny'])
        self.assertEqual(seen['disallowedTools'][0], 'WebFetch'); self.assertEqual(seen['settings']['permissions']['allow'], ['Read'])
        # Rolling back restores the unpatched launch module byte for byte.
        with operation.switch.locked(): operation.move('before', stopped=lambda *args: None)
        self.assertEqual(live.read_text(), QUERY)
    def test_a_host_without_the_launch_anchor_or_its_pin_refuses_to_overlay(self):
        with self.assertRaisesRegex(ValueError, 'unique'): p.patch_deny_module(QUERY.replace('input.options, context', 'options, context').encode(), '/private/guard.mjs')
        with self.assertRaisesRegex(ValueError, 'already patched'): p.patch_deny_module(p.patch_deny_module(QUERY.encode(), '/private/guard.mjs'), '/private/guard.mjs')
        for deny in [{}, {'providers/claude/other.js': 'x'}]:
            operation, manifest = self.fixture(); operation.move('before', stopped=lambda *args: None)
            operation.operation.unlink()
            with self.subTest(deny=deny), self.assertRaisesRegex(ValueError, 'choke point'): operation.prepare([os.getpid()], 'next', {**self.expected, 'denyModules': deny})

if __name__ == '__main__': unittest.main()
