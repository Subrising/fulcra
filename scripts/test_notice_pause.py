import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import queue
import threading
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('notice_pause', Path(__file__).with_name('notice-pause.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NoticePauseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.calls = []
        self.rows = [{'id': 'claude-owner', 'provider': 'claude/model', 'status': 'idle'},
                     {'id': 'codex-owner', 'provider': 'codex/model', 'status': 'idle'}]
        self.transport_fail = False
        self.gate = m.Gate(self.root, self.run_native)
        self.policy(['claude'])
        self.env = patch.dict(os.environ, {'PASEO_HOME': '', 'PASEO_AGENT_ID': ''})
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_native(self, cli, args, **kwargs):
        self.calls.append((cli, args, kwargs))
        if 'ls' in args:
            return subprocess.CompletedProcess(args, 0, json.dumps(self.rows), '')
        return subprocess.CompletedProcess(args, int(self.transport_fail), 'receipt', '')

    def policy(self, providers, **extra):
        m.atomic(self.root / 'pause.json', {'pausedProviders': providers, **extra})

    def send(self, owner='claude-owner', text='job ended', **options):
        args = ['send', owner, '--no-wait', '--prompt', text]
        for key, value in options.items():
            args.extend(['--' + key.replace('_', '-'), value])
        return self.gate.send('/native/cli', args)

    def records(self):
        return [batch for p in self.gate.store.glob('*.json') for batch in json.loads(p.read_text())['batches']]

    def sends(self):
        return [call for call in self.calls if 'send' in call[1]]

    def test_claude_is_held_without_a_send(self):
        self.send()
        self.assertEqual(self.sends(), [])
        self.assertEqual(self.records()[0]['state'], 'held')

    def test_restart_warning_cannot_be_deferred(self):
        with self.assertRaises(ValueError):
            self.gate.send('/native/cli', ['send', 'claude-owner', '--prompt', 'restart warning'], require_delivery=True)
        self.assertEqual(self.sends(), [])
        self.assertEqual(self.records(), [])

    def test_codex_still_receives_notice(self):
        self.send('codex-owner')
        self.assertEqual(len(self.sends()), 1)

    def test_complete_id_exception(self):
        self.policy(['claude'], exceptSessions=['claude-owner'])
        self.send()
        self.assertEqual(len(self.sends()), 1)

    def test_prefix_is_not_an_exception(self):
        self.policy(['claude'], exceptSessions=['claude'])
        self.send()
        self.assertEqual(self.sends(), [])

    def test_resume_combines_once(self):
        self.send(text='one')
        self.send(text='two')
        self.gate.drain()
        self.assertEqual(self.sends(), [])
        self.policy([])
        self.gate.drain()
        self.gate.drain()
        self.assertEqual(len(self.sends()), 1)
        prompt = Path(self.sends()[0][1][-1]).read_text()
        self.assertIn('one\n\ntwo', prompt)

    def test_new_pause_after_delivery_has_a_new_batch(self):
        self.send()
        self.policy([])
        self.gate.drain()
        batch = self.records()[0]['batchId']
        self.policy(['claude'])
        self.send(text='new pause')
        self.assertNotEqual(self.records()[-1]['batchId'], batch)
        self.assertEqual(len(self.records()[-1]['notices']), 1)

    def test_transport_failure_is_retained_without_replay(self):
        self.send()
        self.policy([])
        self.transport_fail = True
        with self.assertRaises(RuntimeError):
            self.gate.drain()
        self.gate.drain()
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(self.records()[0]['state'], 'uncertain')

    def test_duplicate_id_has_one_record(self):
        self.send(message_id='job-1')
        self.send(message_id='job-1')
        self.assertEqual(len(self.records()[0]['notices']), 1)

    def test_malformed_policy_fails_closed(self):
        (self.root / 'pause.json').write_text('{')
        with self.assertRaises(ValueError):
            self.send()
        self.assertEqual(self.sends(), [])

    def test_launchers_share_one_owner_record(self):
        self.send()
        self.gate.send('/other/cli', ['send', 'claude-owner', '--prompt', 'second'])
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(len(self.records()[0]['notices']), 2)

    def test_sender_identity_is_restored(self):
        with patch.dict(os.environ, {'PASEO_AGENT_ID': 'source'}):
            self.send()
        self.policy([])
        self.gate.drain()
        self.assertEqual(self.sends()[0][2]['env']['PASEO_AGENT_ID'], 'source')

    def test_different_senders_are_retained_with_their_source(self):
        with patch.dict(os.environ, {'PASEO_AGENT_ID': 'source-a'}): self.send(text='one')
        with patch.dict(os.environ, {'PASEO_AGENT_ID': 'source-b'}): self.send(text='two')
        self.assertEqual(len(self.records()), 2)
        self.assertEqual(len(list(self.gate.store.glob('*.json'))), 1)
        self.policy([])
        self.gate.drain()
        self.assertEqual([item[2]['env']['PASEO_AGENT_ID'] for item in self.sends()], ['source-a', 'source-b'])

    def test_codex_image_notices_keep_native_options(self):
        args = ['send', 'codex-owner', '--prompt', 'image receipt', '--image', 'fixture.png']
        self.gate.send('/native/cli', args)
        self.assertEqual(self.sends()[0][1], args)

    def test_codex_native_queue_keeps_its_native_admission(self):
        args = ['send', 'codex-owner', '--prompt', 'receipt', '--native-queue', '--message-id', 'native-id']
        self.gate.send('/native/cli', args)
        self.assertEqual(self.sends()[0][1], args)

    def test_paused_capabilities_are_not_converted_to_plain_input(self):
        with self.assertRaises(ValueError):
            self.gate.send('/native/cli', ['send', 'claude-owner', '--prompt', 'receipt', '--native-queue', '--message-id', 'native-id'])
        self.assertEqual(self.records(), [])
        self.assertEqual(self.sends(), [])

    def test_resume_uses_the_current_stable_cli(self):
        self.send()
        self.policy([], deliveryCli='/current/cli')
        self.gate.drain()
        self.assertEqual(self.sends()[0][0], '/current/cli')

    def test_an_archived_owner_does_not_block_another_owner(self):
        self.rows.append({'id': 'second-owner', 'provider': 'claude/model', 'status': 'idle'})
        self.send()
        self.send('second-owner')
        self.rows = [row for row in self.rows if row['id'] != 'claude-owner']
        self.policy([])
        self.gate.drain()
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(self.sends()[0][1][1], 'second-owner')
        self.assertEqual(sorted(batch['state'] for batch in self.records()), ['delivered', 'refused'])

    def test_native_cli_output_stays_live(self):
        child_code = "import sys; print('ready', flush=True); sys.stdin.readline(); print('done', flush=True)"
        flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        env = dict(os.environ, FULCRA_NOTICE_CONFIG=str(self.root))
        child = subprocess.Popen([sys.executable, str(Path(m.__file__)), '--cli', sys.executable,
                                  '-u', '-c', child_code], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, **flags)
        ready = queue.Queue()
        reader = threading.Thread(target=lambda: ready.put(child.stdout.readline()), daemon=True)
        reader.start()
        try:
            self.assertEqual(ready.get(timeout=10).strip(), 'ready')
            out, err = child.communicate('continue\n', timeout=10)
            self.assertEqual(child.returncode, 0, err)
            self.assertEqual(out.strip(), 'done')
        finally:
            if child.poll() is None: child.kill()
            child.wait()

    def test_unknown_target_fails_closed(self):
        with self.assertRaises(ValueError):
            self.send('missing')
        self.assertEqual(self.sends(), [])

    def test_target_binding_preserves_an_identical_endpoint_value(self):
        self.gate.send('/native/cli', ['--home', 'codex', 'send', 'codex', '--prompt', 'receipt'])
        self.assertEqual(self.sends()[0][1][1], 'codex')
        self.assertEqual(self.sends()[0][1][3], 'codex-owner')

    def test_role_delivery_is_bound_to_checked_id(self):
        self.policy([], roles={'main-assistant': 'claude-owner'})
        self.send('role:main-assistant')
        self.assertEqual(self.sends()[0][1][1], 'claude-owner')

    def test_prompt_file_is_frozen_before_hold(self):
        path = self.root / 'input.txt'
        path.write_text('original')
        self.gate.send('/native/cli', ['send', 'claude-owner', '--prompt-file', str(path)])
        path.unlink()
        self.assertEqual(self.records()[0]['notices'][0]['text'], 'original')


if __name__ == '__main__':
    unittest.main()
