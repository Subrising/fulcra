import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from deploy import ProviderPatch, RELATIVE, m


class DeploymentTests(unittest.TestCase):
    def fixture(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve(); live = root / 'node_modules'
        (live / RELATIVE).parent.mkdir(parents=True)
        for name in ('package.json', 'package-lock.json'):
            shutil.copyfile(m.ROOT / name, root / name)
        shutil.copyfile(Path(os.environ.get('ORCA_PROVIDER_BASE', m.ROOT / 'node_modules' / RELATIVE)), live / RELATIVE)
        (live / 'preserved.txt').write_text('unrelated dependency')
        record = {'phase': 'complete', 'after': {'identity': m.identity(live), 'treeDigest': m.fingerprint(live)}, 'nativeOverlay': 'previous-permission-overlay'}
        m.atomic(root / 'dependency-operation.json', json.dumps(record).encode())
        patch = ProviderPatch(root); manifest = patch.prepare([os.getpid()], 'test-head')
        return patch, manifest, root

    def test_crash_reconciliation_and_exact_rollback(self):
        for boundary in ('intent', 'provider', 'dependency'):
            with self.subTest(boundary=boundary):
                patch, manifest, root = self.fixture()
                def crash(name):
                    if name == boundary: raise RuntimeError('simulated process loss')
                with self.assertRaisesRegex(RuntimeError, 'simulated'):
                    patch.move('after', stopped=lambda *_: None, checkpoint=crash)
                patch.move('after', stopped=lambda *_: None)
                self.assertEqual(m.fingerprint(root / 'node_modules'), manifest['tree']['after'])
                patch.move('before', stopped=lambda *_: None)
                self.assertEqual(m.fingerprint(root / 'node_modules'), manifest['tree']['before'])
                self.assertEqual((root / 'node_modules/preserved.txt').read_text(), 'unrelated dependency')

    def test_active_consumers_refuse_before_writing(self):
        patch, manifest, root = self.fixture()
        def active(*_): raise ValueError('owner still active')
        with self.assertRaisesRegex(ValueError, 'active'): patch.move('after', stopped=active)
        self.assertEqual(m.fingerprint(root / 'node_modules'), manifest['tree']['before'])

    def test_unknown_dependency_and_corrupt_backup_refuse(self):
        patch, _, root = self.fixture()
        (root / 'node_modules/preserved.txt').write_text('other writer')
        with self.assertRaisesRegex(ValueError, 'Unrelated'): patch.move('after', stopped=lambda *_: None)
        _, _, directory = patch.load()
        backup = directory / 'provider-before.js'; backup.chmod(0o600); backup.write_text('corrupt')
        with self.assertRaisesRegex(ValueError, 'backup changed'): patch.move('before', stopped=lambda *_: None)


if __name__ == '__main__': unittest.main()
