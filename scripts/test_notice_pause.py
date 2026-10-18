import importlib.util
import contextlib
import io
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
        self.parents = {}
        self.inspect_error = False
        self.transport_fail = False
        self.gate = m.Gate(self.root, self.run_native)
        self.policy(['claude'])
        self.env = patch.dict(os.environ, {'PASEO_HOME': '', 'PASEO_AGENT_ID': ''})
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_native(self, cli, args, **kwargs):
        self.calls.append((cli, args, kwargs))
        if '--check-only' in args:
            return subprocess.CompletedProcess(args, 0, json.dumps({'status': 'allowed'}), '')
        if 'inspect' in args:
            if self.inspect_error:
                return subprocess.CompletedProcess(args, 1, '', 'read error')
            identifier = args[args.index('inspect') + 1]
            return subprocess.CompletedProcess(args, 0, json.dumps({
                'Id': identifier, 'ParentAgentId': self.parents.get(identifier)}), '')
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

    def test_excepted_leads_child_is_delivered(self):
        self.policy(['claude'], exceptSessions=['lead'])
        self.parents['claude-owner'] = 'lead'
        self.send()
        self.assertEqual(len(self.sends()), 1)

    def test_excepted_leads_grandchild_is_delivered(self):
        self.policy(['claude'], exceptSessions=['lead'])
        self.parents.update({'claude-owner': 'child', 'child': 'lead'})
        self.send()
        self.assertEqual(len(self.sends()), 1)

    def test_label_read_error_is_held(self):
        self.policy(['claude'], exceptSessions=['lead'])
        self.inspect_error = True
        self.send()
        self.assertEqual(self.sends(), [])
        self.assertEqual(self.records()[0]['state'], 'held')

    def test_cycle_is_held(self):
        self.policy(['claude'], exceptSessions=['lead'])
        self.parents.update({'claude-owner': 'child', 'child': 'claude-owner'})
        self.send()
        self.assertEqual(self.sends(), [])
        inspected = [call[1] for call in self.calls if 'inspect' in call[1]]
        self.assertEqual(len(inspected), 2)

    def test_inspect_schema_and_transport_errors_stay_held(self):
        for output in ['[]', '{}', '{', '{"Id":"wrong","ParentAgentId":"lead"}',
                       '{"Id":"claude-owner","ParentAgentId":42}']:
            with self.subTest(output=output):
                original = self.gate.run
                def run(cli, args, **kwargs):
                    if 'inspect' in args:
                        return subprocess.CompletedProcess(args, 0, output, '')
                    return original(cli, args, **kwargs)
                self.gate.run = run
                try:
                    self.send()
                    self.assertEqual(self.sends(), [])
                finally:
                    self.gate.run = original

    def test_drain_caches_ancestors_for_one_call_only(self):
        with patch.dict(os.environ, {'PASEO_AGENT_ID': 'source-a'}): self.send(text='one')
        with patch.dict(os.environ, {'PASEO_AGENT_ID': 'source-b'}): self.send(text='two')
        self.policy(['claude'], exceptSessions=['lead'])
        self.parents['claude-owner'] = 'lead'
        self.calls.clear()
        self.gate.drain()
        self.assertEqual(len(self.sends()), 2)
        self.assertEqual(len([c for c in self.calls if 'inspect' in c[1]]), 1)
        self.parents.clear()
        self.send(text='new')
        self.assertEqual(len(self.sends()), 2)
        self.assertEqual(self.records()[-1]['state'], 'held')

    def test_closed_paused_session_refuses_before_hold(self):
        self.rows[0]['status'] = 'closed'
        with self.assertRaisesRegex(ValueError, 'session closed: reload it or start a new worker'):
            self.send()
        self.assertEqual(self.records(), [])
        self.assertEqual(self.sends(), [])

    def test_closed_held_session_is_refused_during_pause(self):
        self.send()
        self.rows[0]['status'] = 'closed'
        self.gate.drain()
        self.assertEqual(self.records()[0]['state'], 'refused')
        self.assertEqual(self.sends(), [])

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

    def test_cli_target_miss_is_machine_readable_for_the_ssh_sender(self):
        self.rows = []
        output = io.StringIO()
        with patch.object(m, 'Gate', return_value=self.gate), patch.object(sys, 'argv', [
                'notice-pause.py', '--cli', '/native/cli', 'send', 'missing', '--prompt', 'marker']), contextlib.redirect_stderr(output):
            code = m.cli_main()
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue())['error']['code'], 'AGENT_NOT_FOUND')
        self.assertEqual(self.sends(), [])

    def test_structured_route_defers_a_local_miss_to_native_sender_checks(self):
        self.policy([], sshRoutes={'11111111-1111-4111-8111-111111111111': {
            'host': 'remote host', 'sshTarget': 'remote',
            'cli': '/opt/fulcra/bin/fulcra', 'home': '/srv/fulcra'}})
        self.send('11111111-1111-4111-8111-111111111111')
        self.assertEqual(len(self.sends()), 1)
        self.assertIn('11111111-1111-4111-8111-111111111111', self.sends()[0][1])

    def test_structured_route_never_replaces_a_local_hit(self):
        self.policy([], sshRoutes={'codex-owner': {
            'host': 'remote host', 'sshTarget': 'remote',
            'cli': '/opt/fulcra/bin/fulcra', 'home': '/srv/fulcra'}})
        self.send('codex-owner')
        self.assertEqual(len(self.sends()), 1)
        self.assertIn('codex-owner', self.sends()[0][1])

    def test_required_notice_cannot_defer_through_a_route(self):
        self.policy([], sshRoutes={'11111111-1111-4111-8111-111111111111': {
            'host': 'remote host', 'sshTarget': 'remote',
            'cli': '/opt/fulcra/bin/fulcra', 'home': '/srv/fulcra'}})
        with self.assertRaisesRegex(ValueError, 'explicit destination'):
            self.gate.send('/native/cli', ['send', '11111111-1111-4111-8111-111111111111', '--prompt', 'warning'], require_delivery=True)
        self.assertEqual(self.sends(), [])

    def test_invalid_route_key_is_refused(self):
        for key in ['-oProxyCommand=wrong', '11111111']:
            self.policy([], sshRoutes={key: {'host': 'remote'}})
            with self.assertRaisesRegex(ValueError, 'complete session UUIDs'):
                self.send("missing")
        self.assertEqual(self.sends(), [])

    def test_restricted_refusal_cannot_be_saved_as_a_pause_hold(self):
        original = self.gate.run
        def run(cli, args, **kwargs):
            if '--check-only' in args:
                return subprocess.CompletedProcess(args, 1, '', json.dumps({'error': {'code': 'SEND_REFUSED', 'message': 'Send this to your lead.'}}))
            return original(cli, args, **kwargs)
        self.gate.run = run
        error = io.StringIO()
        with contextlib.redirect_stderr(error):
            code = self.gate.send('/native/cli', ['send', 'claude-owner', '--prompt', 'private', '--from', 'worker@source', '--inbound-only', '--outbound-refusal', 'Send this to your lead.'])
        self.assertEqual(code, 1)
        self.assertIn('Send this to your lead.', error.getvalue())
        self.assertEqual(self.records(), [])
        self.assertEqual(self.sends(), [])

    def test_restricted_hold_preserves_source_policy_until_drain(self):
        self.gate.send('/native/cli', ['send', 'claude-owner', '--prompt', 'private', '--from', 'worker@source', '--inbound-only', '--outbound-refusal', 'Send this to your lead.'])
        self.assertTrue(self.records()[0]['sender']['inboundOnly'])
        self.policy([])
        self.gate.drain()
        actual = [call for call in self.sends() if '--check-only' not in call[1]]
        self.assertEqual(len(actual), 1)
        self.assertIn('--inbound-only', actual[0][1])
        self.assertIn('Send this to your lead.', actual[0][1])

    def test_remote_opt_out_reaches_the_native_sender_check(self):
        self.policy([])
        self.gate.send('/native/cli', ['send', 'codex-owner', '--prompt', 'quiet', '--no-notify-on-finish'])
        self.assertIn('--no-notify-on-finish', self.sends()[0][1])

    def test_paused_remote_opt_out_survives_resume(self):
        self.gate.send('/native/cli', ['send', 'claude-owner', '--prompt', 'quiet', '--no-notify-on-finish'])
        self.policy([])
        self.gate.drain()
        self.assertIn('--no-notify-on-finish', self.sends()[0][1])

    def test_target_binding_preserves_an_identical_endpoint_value(self):
        self.gate.send('/native/cli', ['--home', 'codex', 'send', 'codex', '--prompt', 'receipt'])
        self.assertEqual(self.sends()[0][1][1], 'codex')
        self.assertEqual(self.sends()[0][1][3], 'codex-owner')

    def test_role_delivery_is_bound_to_checked_id(self):
        self.policy([], roles={'main-assistant': 'claude-owner'})
        self.send('role:main-assistant')
        self.assertEqual(self.sends()[0][1][1], 'claude-owner')

    def test_remote_target_names_the_host_and_route_without_sending(self):
        self.policy([], roles={'main-assistant': '11111111-1111-4111-8111-111111111111', 'fulcra-lead': 'remote-lead'},
                    noticeRoutes={key: {'host': 'Mac mini', 'route': 'ssh mini using ~/.local/bin/fulcra'}
                                  for key in ['11111111-1111-4111-8111-111111111111', 'remote-lead']})
        for identifier in ['role:main-assistant', 'role:fulcra-lead', '11111111', 'remote-lead']:
            with self.assertRaisesRegex(m.TargetUnavailableError, 'Mac mini.*ssh mini'):
                self.send(identifier)
        self.assertEqual(self.sends(), [])

    def test_failed_discovery_names_the_route_without_exposing_transport_output(self):
        self.policy([], roles={'main-assistant': '11111111-1111-4111-8111-111111111111'}, noticeRoutes={
            '11111111-1111-4111-8111-111111111111': {'host': 'Mac mini', 'route': 'ssh mini using ~/.local/bin/fulcra'}})
        self.gate.run = lambda *args, **kw: subprocess.CompletedProcess(args, 7, '', 'private transport output')
        with self.assertRaisesRegex(RuntimeError, 'selected daemon.*exit 7.*Mac mini.*ssh mini') as error:
            self.send('role:main-assistant')
        self.assertNotIn('private transport output', str(error.exception))
        self.assertEqual(self.sends(), [])

    def test_configured_route_does_not_override_an_explicit_local_target(self):
        self.policy([], roles={'fulcra-lead': 'codex-owner'}, noticeRoutes={
            'codex-owner': {'host': 'other host', 'route': 'ssh other'}})
        self.gate.send('/native/cli', ['--host', 'selected', 'send', 'role:fulcra-lead', '--prompt', 'test'])
        self.assertEqual(self.sends()[0][1][:4], ['--host', 'selected', 'send', 'codex-owner'])

    def test_prompt_file_is_frozen_before_hold(self):
        path = self.root / 'input.txt'
        path.write_text('original')
        self.gate.send('/native/cli', ['send', 'claude-owner', '--prompt-file', str(path)])
        path.unlink()
        self.assertEqual(self.records()[0]['notices'][0]['text'], 'original')


if __name__ == '__main__':
    unittest.main()
