"""One recoverable provider patch; reuse the existing stopped dependency boundary."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import uuid

SOURCE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dependency_switch', SOURCE.parent / 'src/dependency-switch.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
RELATIVE = '@getpaseo/server/dist/server/server/agent/providers/codex-app-server-agent.js'


class ProviderPatch:
    def __init__(self, root=m.ROOT):
        self.root = Path(root)
        self.switch = m.Switch(root)
        self.operation = self.root / 'empty-provider-operation.json'

    def prepare(self, owners, head):
        if os.path.lexists(self.operation): raise ValueError('Provider operation already exists')
        record_bytes = m.regular(self.root / 'dependency-operation.json')
        record = json.loads(record_bytes)
        self.switch.metadata(self.root, 'after')
        live = self.root / 'node_modules'
        if record['phase'] != 'complete' or record.get('providerOverlay') or m.identity(live) != record['after']['identity']:
            raise ValueError('Complete current dependency side required')
        inventory = m.inventory(live)
        if m.sha(json.dumps(inventory, sort_keys=True).encode()) != record['after']['treeDigest']:
            raise ValueError('Dependency tree changed')
        original = m.regular(live / RELATIVE)
        script = "import fs from 'node:fs'; import {patchEmptySession} from './provider-patches/empty-session.mjs'; process.stdout.write(patchEmptySession(fs.readFileSync(0,'utf8')));"
        patched = subprocess.run(['/opt/homebrew/opt/node@24/bin/node', '--input-type=module', '-e', script], input=original, cwd=SOURCE.parent, capture_output=True, check=True).stdout
        subprocess.run(['/opt/homebrew/opt/node@24/bin/node', '--input-type=module', '--check'], input=patched, capture_output=True, check=True)
        operation_id = str(uuid.uuid4()); directory = self.root / ('empty-provider-' + operation_id); directory.mkdir(mode=0o700)
        changed = json.loads(json.dumps(inventory)); changed[RELATIVE]['sha256'] = m.sha(patched)
        after = json.loads(record_bytes); after['after']['treeDigest'] = m.sha(json.dumps(changed, sort_keys=True).encode()); after['providerOverlay'] = operation_id
        blobs = {'provider-before.js': original, 'provider-after.js': patched, 'dependency-before.json': record_bytes, 'dependency-after.json': json.dumps(after).encode()}
        for name, data in blobs.items(): m.atomic(directory / name, data, 0o400)
        manifest = {'id': operation_id, 'head': head, 'captured': m.capture(owners), 'watched': m.required_watched(self.root), 'files': {name: m.sha(data) for name, data in blobs.items()}, 'mode': inventory[RELATIVE]['mode'], 'tree': {'before': record['after']['treeDigest'], 'after': after['after']['treeDigest']}, 'identity': m.identity(live)}
        m.atomic(directory / 'manifest.json', json.dumps(manifest).encode(), 0o400)
        m.atomic(self.operation, json.dumps({'id': operation_id, 'manifest': m.sha(m.regular(directory / 'manifest.json')), 'phase': 'prepared', 'target': 'before'}).encode())
        return manifest

    def load(self):
        state = json.loads(m.regular(self.operation))
        if str(uuid.UUID(state['id'])) != state['id']: raise ValueError('Invalid operation ID')
        directory = self.root / ('empty-provider-' + state['id']); m.identity(directory)
        raw = m.regular(directory / 'manifest.json')
        if m.sha(raw) != state['manifest']: raise ValueError('Provider manifest changed')
        manifest = json.loads(raw)
        if manifest['id'] != state['id'] or state['phase'] not in ('prepared', 'switching', 'complete') or state['target'] not in ('before', 'after'):
            raise ValueError('Invalid provider operation')
        for name, digest in manifest['files'].items():
            if name not in ('provider-before.js', 'provider-after.js', 'dependency-before.json', 'dependency-after.json') or m.sha(m.regular(directory / name)) != digest:
                raise ValueError('Provider backup changed')
        return state, manifest, directory

    def move(self, target, stopped=m.assert_stopped, checkpoint=lambda name: None):
        if target not in ('before', 'after'): raise ValueError('Invalid provider side')
        state, manifest, directory = self.load(); live = self.root / 'node_modules'
        m.validate_watched(self.root, manifest['watched']); self.switch.metadata(self.root, 'after')
        if self.root == m.ROOT:
            for role in ('controller', 'paseo'):
                result = subprocess.run(['/bin/launchctl', 'print', f'gui/{os.getuid()}/ai.orca.{role}'], capture_output=True)
                if result.returncode == 0: raise ValueError('Bootout owned LaunchAgents before modifying dependencies')
        stopped(manifest['captured'], manifest['watched'])
        if m.identity(live) != manifest['identity']: raise ValueError('Dependency directory changed')
        inventory = m.inventory(live); actual = inventory[RELATIVE]
        if actual not in [{'mode': manifest['mode'], 'sha256': manifest['files']['provider-' + side + '.js']} for side in ('before', 'after')]:
            raise ValueError('Unknown provider bytes')
        inventory[RELATIVE] = {'mode': manifest['mode'], 'sha256': manifest['files']['provider-before.js']}
        if m.sha(json.dumps(inventory, sort_keys=True).encode()) != manifest['tree']['before']: raise ValueError('Unrelated dependency changed')
        before = json.loads(m.regular(directory / 'dependency-before.json')); after = json.loads(m.regular(directory / 'dependency-after.json'))
        switching = {**after, 'phase': 'switching'}
        if json.loads(m.regular(self.root / 'dependency-operation.json')) not in (before, after, switching): raise ValueError('Dependency operation changed')
        state.update(phase='switching', target=target); m.atomic(self.operation, json.dumps(state).encode())
        m.atomic(self.root / 'dependency-operation.json', json.dumps(switching).encode()); checkpoint('intent')
        stopped(manifest['captured'], manifest['watched'])
        # Stage outside node_modules so a crash cannot add an unrecognized dependency file.
        temporary = directory / ('pending-' + str(uuid.uuid4()))
        m.atomic(temporary, m.regular(directory / ('provider-' + target + '.js')), manifest['mode'])
        os.replace(temporary, live / RELATIVE); m.sync((live / RELATIVE).parent); checkpoint('provider')
        if m.fingerprint(live) != manifest['tree'][target]: raise ValueError('Provider tree did not converge')
        stopped(manifest['captured'], manifest['watched'])
        m.atomic(self.root / 'dependency-operation.json', m.regular(directory / ('dependency-' + target + '.json'))); checkpoint('dependency')
        state['phase'] = 'complete'; m.atomic(self.operation, json.dumps(state).encode())
        return manifest


if __name__ == '__main__':
    import sys
    patch = ProviderPatch()
    with patch.switch.locked():
        if len(sys.argv) == 4 and sys.argv[1] == 'prepare':
            if subprocess.check_output(['git', 'status', '--porcelain', '--', 'provider-patches'], cwd=SOURCE.parent, text=True).strip(): raise SystemExit('Commit the provider patch before preparing installation')
            result = patch.prepare([int(sys.argv[2]), int(sys.argv[3])], subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE.parent, text=True).strip())
        elif len(sys.argv) == 2 and sys.argv[1] in ('before', 'after'): result = patch.move(sys.argv[1])
        else: raise SystemExit('Use deploy.py prepare CONTROLLER_PID PASEO_SUPERVISOR_PID | before | after')
    print(json.dumps({'id': result['id'], 'tree': result['tree'], 'head': result['head']}))
