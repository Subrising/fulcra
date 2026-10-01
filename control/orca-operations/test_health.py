from contextlib import closing
import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('health', Path(__file__).with_name('health.py'))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / 'state.sqlite'
        self.config = {'accountId': 'default', 'conversationId': '123'}
        self.sent = []
        self.send = lambda config, body: self.sent.append(body) or {'id': 'receipt'}

    def tearDown(self):
        self.tmp.cleanup()

    def tick(self, at, healthy, sender=None):
        with closing(sqlite3.connect(self.file)) as db, db:
            return health.tick(db, self.config, {'healthy': healthy, 'reason': 'fixture'}, sender or self.send, now=at)

    def test_persistent_failure_and_recovery_emit_once_across_restarts(self):
        self.tick(0, True)
        self.tick(10000, False)
        self.tick(69999, False)
        self.assertEqual(self.sent, [])
        self.tick(70000, False)
        self.tick(100000, False)
        self.assertEqual(len(self.sent), 1)
        self.tick(110000, True)
        self.tick(120000, True)
        self.assertEqual(len(self.sent), 2)
        with closing(sqlite3.connect(self.file)) as db, db:
            self.assertEqual(db.execute('SELECT COUNT(DISTINCT incident) FROM notices').fetchone()[0], 1)

    def test_transient_and_clock_reversal_do_not_page(self):
        for at, healthy in [(100000, False), (110000, True), (120000, False), (1000, False), (10000, False)]:
            self.tick(at, healthy)
        self.assertEqual(self.sent, [])

    def test_lost_send_response_is_not_retried(self):
        def lost(*args):
            self.sent.append('accepted externally')
            raise TimeoutError('response lost')
        self.tick(0, False)
        self.tick(60000, False, lost)
        self.tick(120000, False)
        self.assertEqual(len(self.sent), 1)
        with closing(sqlite3.connect(self.file)) as db, db:
            self.assertEqual(db.execute('SELECT state FROM notices').fetchone()[0], 'uncertain')

    def test_death_after_committed_intent_never_replays(self):
        self.tick(0, False)
        def die(*args):
            raise SystemExit('simulated death before transport')
        with self.assertRaises(SystemExit):
            self.tick(60000, False, die)
        self.tick(120000, False)
        self.assertEqual(self.sent, [])
        with closing(sqlite3.connect(self.file)) as db, db:
            self.assertEqual(db.execute('SELECT state FROM notices').fetchone()[0], 'dispatch-intent')

    def test_probe_reads_actual_private_database_and_rejects_staleness(self):
        file = Path(self.tmp.name) / 'queue.sqlite'
        with closing(sqlite3.connect(file)) as db, db:
            db.execute('CREATE TABLE health(id INTEGER,seen INTEGER,pid INTEGER)')
            db.execute('INSERT INTO health VALUES(1,?,?)', (10000, os.getpid()))
        file.chmod(0o600)
        config = {'queue': str(file)}
        self.assertTrue(health.probe(config, 20000)['healthy'])
        self.assertFalse(health.probe(config, 70000)['healthy'])
        self.assertFalse(health.probe(config, -30000)['healthy'])
        link = Path(self.tmp.name) / 'link'
        link.symlink_to(file)
        self.assertFalse(health.probe({'queue': str(link)}, 20000)['healthy'])
        file.chmod(0o644)
        self.assertFalse(health.probe(config, 20000)['healthy'])

    def test_real_sigkill_after_intent_is_durable(self):
        import subprocess
        import sys
        script = "import sys,sqlite3,os,signal; sys.path.insert(0,sys.argv[1]); import health; db=sqlite3.connect(sys.argv[2]); c={}; o={'healthy':False,'reason':'fixture'}; health.tick(db,c,o,now=0); health.tick(db,c,o,lambda *a: os.kill(os.getpid(),signal.SIGKILL),now=60000)"
        result = subprocess.run([sys.executable, '-c', script, str(Path(__file__).parent), str(self.file)], capture_output=True)
        self.assertEqual(result.returncode, -9)
        self.tick(120000, False)
        self.assertEqual(self.sent, [])
        with closing(sqlite3.connect(self.file)) as db:
            self.assertEqual(db.execute('SELECT state FROM notices').fetchone()[0], 'dispatch-intent')

    def test_transport_pins_owner_route_and_requires_actual_receipt(self):
        import json
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.object(health.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='{"channel":"discord","messageId":"12345"}')) as command:
            health.deliver(self.config, 'same incident body')
            first = command.call_args.args[0]
            health.deliver(self.config, 'same incident body')
            self.assertEqual(command.call_args.args[0], first)
            params = json.loads(first[first.index('--params') + 1])
            self.assertEqual((params['agentId'], params['to']), ('main', 'channel:123'))
            command.return_value.stdout = '{"ok":true}'
            with self.assertRaises(RuntimeError): health.deliver(self.config, 'no receipt')


if __name__ == '__main__':
    unittest.main()
