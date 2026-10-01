"""Meaningful release refusal and real exec-boundary checks using owned private artifacts."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('runtime_launch', Path(__file__).with_name('runtime_launch.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RuntimeLaunchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / 'runtime'
        self.root.mkdir(mode=0o700)
        (self.root / 'sub').mkdir()
        (self.root / 'sub/file').write_text('pinned')
        (self.root / 'alias').symlink_to('sub/file')
        self.launch = self.root / 'launch.py'
        self.launch.write_text("from pathlib import Path; import sys; Path(sys.argv[1]).with_suffix('.executed').write_text(sys.argv[3])")
        self.profile = self.root / 'profile.json'
        self.profile.write_text('{}')
        self.python = Path(os.sys.executable).resolve()
        self.data = {'version': 1, 'roots': {str(self.root): m.inventory(self.root)}, 'externalPins': {str(self.python): {'resolved': str(self.python), 'sha256': m.digest(self.python)}}, 'roles': {'paseo': [str(self.python), str(self.launch), str(self.profile), m.digest(self.profile), 'paseo']}}
        self.manifest = self.base / 'manifest.json'

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, data=None, role='paseo'):
        self.manifest.write_text(json.dumps(data or self.data))
        return m.validate(self.manifest, m.digest(self.manifest), role)

    def test_matching_inventory_and_internal_link(self):
        self.assertEqual(self.check(), self.data['roles']['paseo'])

    def test_changed_missing_and_extra_code_refuse(self):
        p = self.root / 'sub/file'
        p.write_text('tampered')
        with self.assertRaises(ValueError): self.check()
        p.unlink()
        with self.assertRaises((OSError, ValueError)): self.check()
        p.write_text('pinned')
        (self.root / 'unexpected.js').write_text('override')
        with self.assertRaises(ValueError): self.check()

    def test_external_link_and_hardlink_refuse(self):
        p = self.root / 'alias'
        p.unlink(); p.symlink_to(self.manifest)
        self.manifest.write_text('{}')
        with self.assertRaises(ValueError): self.check()
        p.unlink(); os.link(self.root / 'sub/file', p)
        with self.assertRaises(ValueError): m.inventory(self.root)

    def test_changed_directory_and_permission_refuse(self):
        (self.root / 'new-directory').mkdir()
        with self.assertRaises(ValueError): self.check()
        (self.root / 'new-directory').rmdir()
        (self.root / 'sub/file').chmod(0o666)
        with self.assertRaises(ValueError): self.check()

    def test_manifest_pin_role_and_external_target_refuse(self):
        self.check()
        with self.assertRaises(ValueError): m.validate(self.manifest, '0' * 64, 'paseo')
        with self.assertRaises(ValueError): self.check(role='watch')
        d = copy.deepcopy(self.data); d['roles']['paseo'][4] = 'controller'
        with self.assertRaises(ValueError): self.check(d)
        d = copy.deepcopy(self.data); d['externalPins'][str(self.python)]['resolved'] = '/other'
        with self.assertRaises(ValueError): self.check(d)
        d = copy.deepcopy(self.data); d['externalPins'][str(self.python)]['sha256'] = '0' * 64
        with self.assertRaises(ValueError): self.check(d)

    def test_manifest_cannot_select_uninventoried_launcher(self):
        d = copy.deepcopy(self.data); d['roles']['paseo'][1] = '/tmp/unreviewed.py'
        with self.assertRaises(ValueError): self.check(d)
        d = copy.deepcopy(self.data); d['roles']['paseo'][3] = '0' * 64
        with self.assertRaises(ValueError): self.check(d)

    def test_check_does_not_exec_but_normal_launch_does(self):
        self.check()
        args = [str(self.python), str(Path(m.__file__)), str(self.manifest), m.digest(self.manifest), 'paseo']
        first = subprocess.run(args + ['--check'], capture_output=True, text=True, check=True)
        self.assertTrue(json.loads(first.stdout)['runtimeVerified'])
        output = self.profile.with_suffix('.executed')
        self.assertFalse(output.exists())
        subprocess.run(args, capture_output=True, text=True, check=True)
        self.assertEqual(output.read_text(), 'paseo')


if __name__ == '__main__':
    unittest.main()
