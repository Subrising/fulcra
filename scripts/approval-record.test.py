import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('approval-record.py')
spec = importlib.util.spec_from_file_location('approval_record', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ApprovalRecordTests(unittest.TestCase):
    def invoke(self, output, code=0, log=None, payload=None):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        path = log or Path(self.temp.name)/'audit.jsonl'
        child = 'import sys;sys.stdout.write(' + repr(output) + ');sys.exit(' + str(code) + ')'
        result = subprocess.run([sys.executable, str(SCRIPT), '--rule', 'test-policy', '--log', str(path), '--', sys.executable, '-c', child],
                                input=json.dumps(payload or {'session_id':'native-test','tool_name':'Bash','tool_input':{'command':'echo secret-marker'},'cwd':'/fixture'}),
                                capture_output=True, text=True)
        return result, path

    def test_allow_and_deny_preserve_protocol_and_record(self):
        for answer in ['allow', 'deny']:
            output = json.dumps({'hookSpecificOutput': {'decision': {'behavior': answer}}})
            result, path = self.invoke(output)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, output)
            record = json.loads(path.read_text())
            self.assertEqual(record['decision'], answer)
            self.assertEqual(record['rule'], 'test-policy')
            self.assertEqual(record['sessionId'], 'native-test')
            self.assertNotIn('secret-marker', path.read_text())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_hook_error_cannot_be_an_unrecorded_allow(self):
        result, path = self.invoke('', 1)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(path.read_text())['decision'], 'error')

    def test_scalar_output_cannot_allow(self):
        result, path = self.invoke('1')
        self.assertEqual(result.returncode, 2)

    def test_stop_and_ask_records_preserve_protocol(self):
        for output, expected in [('{"continue":false}', 'deny'), ('{"hookSpecificOutput":{"permissionDecision":"ask"}}', 'defer')]:
            result, path = self.invoke(output)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, output)
            self.assertEqual(json.loads(path.read_text())['decision'], expected)

    def test_updated_input_has_the_effective_digest(self):
        updated = {'command':'pwd'}
        output = json.dumps({'hookSpecificOutput':{'permissionDecision':'allow','updatedInput':updated}})
        result, path = self.invoke(output)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(path.read_text())['target']['inputSha256'], hashlib.sha256(json.dumps(updated,sort_keys=True,separators=(',', ':')).encode()).hexdigest())
        self.assertEqual(result.stdout, output)

    def test_exit_deny(self):
        result, path = self.invoke('', 2)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(path.read_text())['decision'], 'deny')

    def test_no_veto_is_not_an_approval(self):
        result, path = self.invoke('')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(path.read_text())['decision'], 'pass')

    def test_bad_output_does_not_allow(self):
        result, path = self.invoke('invalid')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(path.read_text())['decision'], 'invalid')

    def test_log_failure_does_not_release_allow_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'link'
            path.symlink_to(Path(directory)/'other')
            result, _ = self.invoke('{"decision":"approve"}', log=path)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, '')

    def test_env_assignment_is_not_logged_as_a_program(self):
        result, path = self.invoke('', payload={'tool_input':{'command':'API_KEY=secret-marker echo ok'}})
        self.assertEqual(result.returncode, 0)
        self.assertNotIn('secret-marker', path.read_text())


if __name__ == '__main__':
    unittest.main()
