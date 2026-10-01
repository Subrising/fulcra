import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from launch import validate, guard_human_chain
from launchd import configuration


class LaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.entry = self.root / 'entry.py'
        self.entry.write_text('raise RuntimeError("Validation must not execute")')
        self.entry.chmod(0o600)
        self.state = self.root / 'journal.sqlite'
        self.state.write_bytes(b'existing-state')
        self.state.chmod(0o600)
        self.profile = self.root / 'profiles.json'
        self.data = {'version': 1, 'roles': {'controller': {
            'argv': ['/opt/homebrew/bin/python3', str(self.entry)], 'cwd': str(self.root),
            'required': [str(self.state)], 'pins': {str(self.entry): self.sha(self.entry)}, 'env': {},
        }}}
        self.publish()

    def sha(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def publish(self):
        self.profile.write_text(json.dumps(self.data))
        self.profile.chmod(0o600)
        self.digest = self.sha(self.profile)

    def check(self):
        return validate(str(self.profile), self.digest, 'controller')

    def test_existing_deployment_is_read_only(self):
        before = sorted(p.name for p in self.root.iterdir())
        self.assertEqual(self.check()['argv'][1], str(self.entry))
        self.assertEqual(self.state.read_bytes(), b'existing-state')
        self.assertEqual(before, sorted(p.name for p in self.root.iterdir()))

    def test_missing_state_is_not_recreated(self):
        self.state.unlink()
        with self.assertRaises(FileNotFoundError): self.check()
        self.assertFalse(self.state.exists())

    def test_replaced_profile_and_entry_refuse(self):
        self.profile.write_text(self.profile.read_text() + ' ')
        with self.assertRaises(ValueError): self.check()
        self.publish()
        self.entry.write_text('changed')
        with self.assertRaises(ValueError): self.check()

    def test_symlink_and_writable_entry_refuse(self):
        actual = self.entry.with_suffix('.actual')
        self.entry.rename(actual)
        self.entry.symlink_to(actual)
        with self.assertRaises(ValueError): self.check()
        self.entry.unlink(); actual.rename(self.entry)
        self.entry.chmod(0o666)
        with self.assertRaises(ValueError): self.check()

    def test_unknown_role_and_environment_refuse(self):
        with self.assertRaises(ValueError): validate(str(self.profile), self.digest, 'other-owner')
        self.data['roles']['controller']['env'] = {'NODE_OPTIONS': '--require attacker'}
        self.publish()
        with self.assertRaises(ValueError): self.check()

    def test_installation_paths_are_allowed_in_both_roles_only_when_canonical(self):
        role = self.data['roles']['controller']
        names = ('ORCA_CONTROLLER_HOME', 'ORCA_DAEMON_INSTALLATION', 'ORCA_OUTCOMES_DIR', 'ORCA_TASKS_DIR')
        role['env'] = {name: str(self.root) for name in names}
        self.data['roles']['paseo'] = role
        self.publish()
        self.assertEqual(self.check()['env'], {name: str(self.root) for name in names})
        self.assertEqual(validate(str(self.profile), self.digest, 'paseo')['env']['ORCA_TASKS_DIR'], str(self.root))
        link = self.root / 'link'
        link.symlink_to(self.root)
        for bad in ('relative/tasks', str(self.root) + '/', str(self.root / 'x' / '..'), str(link), 7):
            role['env'] = {'ORCA_TASKS_DIR': bad}
            self.publish()
            with self.assertRaises(ValueError): self.check()
        role['env'] = {'ORCA_TASKS': str(self.root)}
        self.publish()
        with self.assertRaises(ValueError): self.check()

    def test_book_transport_requires_a_pinned_controller_profile(self):
        role = self.data['roles']['controller']
        role['env']['ORCA_BOOK_TRANSPORT_PROFILE'] = str(self.state)
        self.publish()
        with self.assertRaises(ValueError): self.check()
        role['pins'][str(self.state)] = self.sha(self.state)
        self.publish()
        self.assertEqual(self.check()['env']['ORCA_BOOK_TRANSPORT_PROFILE'], str(self.state))
        self.data['roles']['paseo'] = role
        self.publish()
        with self.assertRaises(ValueError): validate(str(self.profile), self.digest, 'paseo')
        self.state.write_bytes(b'changed transport')
        with self.assertRaises(ValueError): self.check()

    def test_plist_contains_no_credential_or_shell(self):
        p = configuration('controller', self.root, self.root)
        self.assertEqual(p['ProgramArguments'][1], str(self.root / 'launch.py'))
        self.assertEqual(p['ProgramArguments'][-2], self.digest)
        self.assertEqual(p['ThrottleInterval'], 30)
        self.assertNotIn('EnvironmentVariables', p)
        self.assertNotIn('sh', p['ProgramArguments'])
        with self.assertRaises(ValueError): configuration('foreign-service', self.root, self.root)


if __name__ == '__main__':
    unittest.main()


class HumanChainTests(unittest.TestCase):
    """STAGE2 review F1: a launchd start of anything but the verified Stage 2 release breaks the chain."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        admission = self.home / 'admission'
        (admission / 'g').mkdir(parents=True)
        self.human = admission / 'human'
        self.human.mkdir(mode=0o700)
        self.guard = admission / 'g' / 'admission-guard.mjs'
        self.guard.write_bytes(b"const HUMAN_DIR = HOME + '/admission/human', X = 1;\n")
        self.module = self.home / 'mod.js'
        self.module.write_bytes(b'patched')
        self.write_active()
        (self.human / 'armed-11111111-1111-4111-8111-111111111111').write_bytes(b'')
        (self.human / '11111111-1111-4111-8111-111111111111.log').write_bytes(b'{}\n')
        self.profile = {'orcaHumanLog': {'home': str(self.home)}}

    def sha(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def write_active(self):
        active = {'base': str(self.home) + '/', 'after': {'mod.js': self.sha(self.module)},
                  'guard': {'path': str(self.guard), 'sha256': self.sha(self.guard)}}
        (self.home / 'admission' / 'active.json').write_text(json.dumps(active))

    def armed(self):
        return sorted(n for n in os.listdir(self.human) if n.startswith('armed-'))

    def test_verified_stage2_release_keeps_the_chain(self):
        self.assertIsNone(guard_human_chain(self.profile, 'paseo'))
        self.assertEqual(len(self.armed()), 1)

    def test_unpatched_module_breaks_the_chain(self):
        self.module.write_bytes(b'pristine after an update')
        self.assertEqual(len(guard_human_chain(self.profile, 'paseo')), 1)
        self.assertEqual(self.armed(), [])
        self.assertTrue((self.human / '11111111-1111-4111-8111-111111111111.log').exists(), 'logs are never touched')

    def test_old_guard_breaks_the_chain(self):
        self.guard.write_bytes(b'export function guard() {}\n')   # R-2: a guard without the log
        self.write_active()
        self.assertEqual(len(guard_human_chain(self.profile, 'paseo')), 1)
        self.assertEqual(self.armed(), [])

    def test_missing_release_record_breaks_the_chain(self):
        (self.home / 'admission' / 'active.json').unlink()
        guard_human_chain(self.profile, 'paseo')
        self.assertEqual(self.armed(), [])

    def test_controller_role_and_unconfigured_profiles_are_untouched(self):
        self.module.write_bytes(b'pristine')
        self.assertIsNone(guard_human_chain(self.profile, 'controller'))
        self.assertIsNone(guard_human_chain({}, 'paseo'))
        self.assertEqual(len(self.armed()), 1)
