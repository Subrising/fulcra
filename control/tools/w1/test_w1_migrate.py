"""Focused tests for w1_migrate.py (W1). Temp fixtures only: a fake legacy controller home (journal, grants, armed markers),
a fake PASEO_HOME and backup dir. No live path.   python3 -m unittest -v test_w1_migrate"""
import hashlib, json, os, shutil, socket, sqlite3, subprocess, sys, tempfile, unittest
from pathlib import Path
HERE = Path(__file__).resolve().parent; MIG = HERE / 'w1_migrate.py'; JN = 'journal' + '.sqlite'
def local_fixture(key):
    file = HERE.parents[2] / 'local' / 'machine-values.json'
    values = json.loads(file.read_text()) if file.is_file() else {}
    value = values.get(key, '/path/to/unconfigured/' + key)
    if not isinstance(value, str) or not value.startswith('/') or '..' in value.split('/'):
        raise ValueError('Invalid reviewed local fixture path: ' + key)
    return value
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
def run(*a): return subprocess.run([sys.executable, '-B', str(MIG), *a], capture_output=True, text=True)
class Fixture(unittest.TestCase):
    def setUp(self):
        self.t = Path(os.path.realpath(tempfile.mkdtemp(prefix='w1-mig-')))
        self.L, self.H, self.P, self.B = self.t / 'legacy', self.t / 'paseo-home', self.t / 'portable', self.t / 'backup'
        for d in (self.L, self.H, self.P, self.L / 'grants/role', self.L / 'admission/human', self.L / 'tasks'): d.mkdir(parents=True)
        db = sqlite3.connect(self.L / JN); db.execute('CREATE TABLE sessions(id TEXT, mode TEXT)'); db.execute("INSERT INTO sessions VALUES ('s1','delegated')"); db.commit(); db.close()
        (self.L / 'grants/role/x.json').write_text('{"capability":"c"}'); (self.L / 'seat-sweep.mode').write_text('on\n')
        (self.L / 'admission/human/armed-b1').write_text(''); (self.L / 'admission/human/b1.log').write_text('{}\n')
        self.cfg = {'version': 1, 'daemon': {'listen': '127.0.0.1:1', 'relay': {'enabled': False}}, 'plugins': {'orca-organization-next': {'source': 'directory', 'path': '/x', 'enabled': True}, 'other': {'enabled': False}}}
        (self.H / 'config.json').write_text(json.dumps(self.cfg)); self.cfg_sha = sha(self.H / 'config.json')
        (self.P / 'config.json').write_text(json.dumps({'version': 1, 'authority': {'companyId': 'c1', 'programmeId': 'p1'}, 'providers': {'claude': 'claude', 'codex': 'codex'}}))
        (self.P / 'tasks.json').write_text('{"version":1,"issues":[],"projects":[]}')
        self.legacy_sha = sha(self.L / JN)
    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)
    def fwd(self, *extra, portable=True):
        return run('forward', '--legacy-home', str(self.L), *(['--portable-home', str(self.P)] if portable else []), '--paseo-home', str(self.H), '--backup', str(self.B), *extra)
class Forward(Fixture):
    def test_forward_builds_command_centre_and_keeps_legacy(self):
        r = self.fwd('--legacy-argv=--relay --no-mcp --no-inject-mcp --web-ui', '--host', 'MacBook=srv_abcdefgh1234@book')
        self.assertEqual(r.returncode, 0, r.stderr); cc = self.H / 'command-centre'
        v2 = json.loads((cc / 'config.json').read_text())
        self.assertEqual(v2['version'], 2); self.assertEqual(v2['authority']['companyId'], 'c1'); self.assertEqual(v2['hosts'], [{'name': 'MacBook', 'serverId': 'srv_abcdefgh1234', 'sshTarget': 'book'}])
        self.assertEqual(sqlite3.connect(cc / JN).execute('SELECT id FROM sessions').fetchall(), [('s1',)])
        self.assertEqual(sha(self.L / JN), self.legacy_sha)   # the legacy journal is never modified
        self.assertTrue((cc / 'grants/role/x.json').exists()); self.assertEqual((cc / 'seat-sweep.mode').read_text().strip(), 'on')
        cfg = json.loads((self.H / 'config.json').read_text())
        self.assertNotIn('orca-organization-next', cfg['plugins']); self.assertIn('other', cfg['plugins'])
        self.assertEqual((cfg['daemon']['relay']['enabled'], cfg['daemon']['mcp']['enabled'], cfg['daemon']['mcp']['injectIntoAgents'], cfg['features']['webUi']['enabled']), (True, False, False, True))
        self.assertEqual(sha(self.B / 'paseo-config.json.orig'), self.cfg_sha); self.assertTrue((self.B / 'forward-receipt.json').exists())
        self.assertEqual(oct(os.stat(cc).st_mode & 0o777), '0o700')
    def test_non_portable_requires_authority(self):
        r = self.fwd(portable=False); self.assertEqual(r.returncode, 2); self.assertIn('non-portable', r.stderr)
    def test_non_portable_with_authority(self):
        r = self.fwd('--authority-company', 'c9', '--authority-programme', 'p9', '--issue-api', 'http://127.0.0.1:3200', portable=False)
        self.assertEqual(r.returncode, 0, r.stderr); v2 = json.loads((self.H / 'command-centre/config.json').read_text())
        self.assertEqual(v2['authority'], {'companyId': 'c9', 'programmeId': 'p9', 'issueApi': 'http://127.0.0.1:3200'})
        self.assertEqual(json.loads((self.H / 'command-centre/tasks.json').read_text())['issues'], [])
    def test_refuses_existing_v4_state(self):
        (self.H / 'command-centre').mkdir(); r = self.fwd(); self.assertEqual(r.returncode, 2); self.assertIn('already exists', r.stderr)
    def test_refuses_legacy_socket_present(self):
        (self.L / 'control.sock').write_text(''); r = self.fwd(); self.assertEqual(r.returncode, 2); self.assertIn('socket', r.stderr)
    def test_refuses_served_port(self):
        s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(); port = s.getsockname()[1]
        try: r = self.fwd('--port', str(port)); self.assertEqual(r.returncode, 2); self.assertIn('still served', r.stderr)
        finally: s.close()
    def test_refuses_unknown_flag(self):
        r = self.fwd('--legacy-argv=--bogus'); self.assertEqual(r.returncode, 2); self.assertIn('unknown legacy daemon flag', r.stderr)
class Rollback(Fixture):
    def test_rollback_restores_and_disarms(self):
        self.assertEqual(self.fwd('--legacy-argv=--relay').returncode, 0)
        (self.H / 'config.json').write_text('{"rewritten": true}')   # e.g. changed during the final window
        r = run('rollback', '--legacy-home', str(self.L), '--paseo-home', str(self.H), '--backup', str(self.B))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sha(self.H / 'config.json'), self.cfg_sha)                       # byte-exact
        self.assertFalse((self.H / 'command-centre').exists())
        kept = [p for p in self.B.iterdir() if p.name.startswith('command-centre-after-final-')]; self.assertEqual(len(kept), 1)   # kept, not deleted
        self.assertFalse((self.L / 'admission/human/armed-b1').exists()); self.assertTrue((self.L / 'admission/human/b1.log').exists())   # markers only
        self.assertEqual(sha(self.L / JN), self.legacy_sha)
    def test_rollback_without_forward_refused(self):
        r = run('rollback', '--legacy-home', str(self.L), '--paseo-home', str(self.H), '--backup', str(self.B)); self.assertEqual(r.returncode, 2)
class X2Defaults(Fixture):
    """The legacy installation defaults (session-defaults.json) carried into V4 config.json `defaults` (post-cutover fix)."""
    X2 = {'version': 1, 'defaults': {'thinkingOptionId': 'medium', 'modes': {'claude': 'auto', 'codex': 'auto-review'}}}
    WANT = {'thinkingOptionId': 'medium', 'modes': {'claude': 'auto', 'codex': 'auto-review'}}
    def legacy(self, doc=None):
        (self.L / 'session-defaults.json').write_text(json.dumps(doc or self.X2)); return sha(self.L / 'session-defaults.json')
    def defaults(self): return json.loads((self.H / 'command-centre/config.json').read_text())['defaults']
    def test_forward_carries_and_rollback_leaves_the_legacy_file_and_rerun_is_identical(self):
        legacy_sha = self.legacy()
        r = self.fwd(); self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(self.defaults(), self.WANT)
        steps = [s for s in json.loads((self.B / 'forward-receipt.json').read_text())['steps'] if s['step'].startswith('installation defaults carried')]
        self.assertEqual((steps[0]['thinkingOptionId'], steps[0]['modes'], steps[0]['sourceSha256']), ('medium', self.WANT['modes'], legacy_sha))
        r = run('rollback', '--legacy-home', str(self.L), '--paseo-home', str(self.H), '--backup', str(self.B)); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sha(self.L / 'session-defaults.json'), legacy_sha, 'rollback leaves the legacy file as it was')
        self.assertFalse((self.H / 'command-centre').exists())
        self.B = self.t / 'backup-2'; r = self.fwd(); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.defaults(), self.WANT, 're-running forward carries the same defaults')
        self.assertEqual(sha(self.L / 'session-defaults.json'), legacy_sha)
    def test_carry_defaults_corrects_an_already_migrated_installation_once(self):
        r = self.fwd(); self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(self.defaults(), {})   # migrated before the fix
        before = (self.H / 'command-centre/config.json').read_bytes(); legacy_sha = self.legacy()
        c = lambda b: run('carry-defaults', '--legacy-home', str(self.L), '--paseo-home', str(self.H), '--backup', str(self.t / b))
        r = c('carry-1'); self.assertEqual(r.returncode, 0, r.stderr); out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertTrue(out['changed']); self.assertEqual(self.defaults(), self.WANT)
        self.assertEqual((self.t / 'carry-1/command-centre-config.json.pre-defaults').read_bytes(), before, 'the old config is backed up first')
        cfg = json.loads((self.H / 'command-centre/config.json').read_text()); self.assertEqual(cfg['version'], 2); self.assertIn('authority', cfg)
        after = sha(self.H / 'command-centre/config.json')
        r = c('carry-2'); self.assertEqual(r.returncode, 0, r.stderr); out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertFalse(out['changed']); self.assertEqual(sha(self.H / 'command-centre/config.json'), after, 'idempotent: nothing rewritten')
        self.assertEqual(sorted(os.listdir(self.t / 'carry-2')), ['carry-defaults-receipt.json'], 'no backup written, only the receipt')
        self.assertEqual(json.loads((self.t / 'carry-2/carry-defaults-receipt.json').read_text())['outcome'], 'unchanged')
        self.assertEqual(json.loads((self.t / 'carry-1/carry-defaults-receipt.json').read_text())['outcome'], 'changed')
        self.assertEqual(sha(self.L / 'session-defaults.json'), legacy_sha)
    def test_a_read_back_refusal_restores_the_pre_step_config_and_leaves_a_receipt(self):
        # Review W1-REBUILD finding 5(b)/(c): the config is written wrong, the read-back refuses, the pre-step bytes return.
        import importlib.util, argparse
        r = self.fwd(); self.assertEqual(r.returncode, 0, r.stderr); self.legacy()
        cfg = self.H / 'command-centre/config.json'; before = cfg.read_bytes()
        spec = importlib.util.spec_from_file_location('w1m', str(MIG)); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        real = m.write_private
        def faulty(path, data):
            if Path(path) == cfg and data != before: data = json.dumps({**json.loads(data), 'defaults': {}}) + '\n'   # a torn/wrong write
            return real(path, data)
        m.write_private = faulty
        a = argparse.Namespace(legacy_home=str(self.L), paseo_home=str(self.H), backup=str(self.t / 'carry-bad'))
        with self.assertRaises(m.Refused) as e: m.carry_defaults(a)
        self.assertIn('restored from', str(e.exception))
        self.assertEqual(cfg.read_bytes(), before, 'the pre-step config bytes are back')
        rec = json.loads((self.t / 'carry-bad/carry-defaults-receipt.json').read_text())
        self.assertEqual((rec['outcome'], rec['restored']), ('refused', True)); self.assertTrue(rec['backup'].endswith('command-centre-config.json.pre-defaults'))
        self.assertEqual(oct(os.stat(self.t / 'carry-bad/carry-defaults-receipt.json').st_mode & 0o777), '0o600')
    def test_a_mode_v4_refuses_is_refused_before_any_write(self):
        self.legacy({'version': 1, 'defaults': {'modes': {'codex': 'full-access'}}})
        r = self.fwd(); self.assertEqual(r.returncode, 2); self.assertIn('not selectable', r.stderr); self.assertFalse((self.H / 'command-centre').exists())
class CarryMemory(Fixture):
    """W1 E3 (29 Sep): V4 serves <ORCA_HOME>/memory; the live corpus was the legacy native memory's root. carry-memory and
    forward --memory-source copy it exactly (0600/0700, no symlinks, digest-verified) and V4's core then sees the same corpus."""
    CORE = HERE.parent.parent / 'src/portable-memory/core.mjs'
    def corpus(self, name='decisions'):
        src = self.t / name; (src / 'history').mkdir(parents=True)
        (src / 'orca-leadership-policy.md').write_text('# Leadership\nOrca leadership policy: the prime decides.\n')
        (src / 'orca-platform-state.md').write_text('# Platform\nOrca platform operating state and memory.\n')
        (src / 'notes.txt').write_text('not markdown')
        (src / 'history' / 'orca-2025.md').write_text('# Old\nOrca history entry.\n')
        for f in src.rglob('*'): os.chmod(f, 0o644 if f.is_file() else 0o755)
        return src
    def carry(self, src, backup='carry-m1', *extra):
        return run('carry-memory', '--paseo-home', str(self.H), '--memory-source', str(src), '--backup', str(self.t / backup), *extra)
    def search(self, root, scope):
        js = ("const {createMemory}=await import(process.argv[1]); const m=createMemory(process.argv[2]);"
              "const r=m.search({query:'orca', scope:process.argv[3], maxResults:8});"
              "console.log(JSON.stringify({coverage:r.coverage, totalMatches:r.totalMatches, hits:r.matches.map(h=>[h.corpus, h.path.slice(process.argv[2].length)]).sort()}))")
        r = subprocess.run([shutil.which('node') or '/opt/homebrew/opt/node@24/bin/node', '--input-type=module', '-e', js, str(self.CORE), str(root), scope], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr); d = json.loads(r.stdout); d['coverage'].pop('bytes', None); return d
    def test_carry_memory_copies_the_corpus_exactly_and_v4_core_sees_the_same_counts(self):
        src = self.corpus(); self.assertEqual(self.fwd().returncode, 0)
        before = {p.name: sha(p) for p in src.rglob('*') if p.is_file()}
        r = self.carry(src); self.assertEqual(r.returncode, 0, r.stderr); out = json.loads(r.stdout.strip().splitlines()[-1])
        mem = self.H / 'command-centre/memory'; self.assertTrue(out['changed']); self.assertEqual(out['files'], 4)
        self.assertEqual({p.name: sha(p) for p in mem.rglob('*') if p.is_file()}, before, 'byte-exact copy')
        self.assertTrue(all(oct(os.stat(p).st_mode & 0o777) == ('0o600' if p.is_file() else '0o700') for p in [mem, *mem.rglob('*')]), 'private modes')
        self.assertEqual({p.name: sha(p) for p in src.rglob('*') if p.is_file()}, before, 'the source is only read')
        self.assertEqual(json.loads((self.t / 'carry-m1/carry-memory-receipt.json').read_text())['outcome'], 'changed')
        for scope in ('current', 'history', 'all'):
            self.assertEqual(self.search(mem, scope), self.search(src, scope), f'V4 core: same coverage and hits ({scope})')
        self.assertEqual(self.search(mem, 'current')['coverage']['complete'], True)
    def test_rerun_is_a_no_op_and_a_changed_source_needs_refresh(self):
        src = self.corpus(); self.assertEqual(self.fwd().returncode, 0); self.assertEqual(self.carry(src).returncode, 0)
        r = self.carry(src, 'carry-m2'); self.assertEqual(r.returncode, 0, r.stderr); self.assertFalse(json.loads(r.stdout.strip().splitlines()[-1])['changed'])
        (src / 'orca-new-decision.md').write_text('# New\nOrca new decision.\n')
        r = self.carry(src, 'carry-m3'); self.assertEqual(r.returncode, 2); self.assertIn('--refresh', r.stderr)
        self.assertEqual(json.loads((self.t / 'carry-m3/carry-memory-receipt.json').read_text())['outcome'], 'refused')
        r = self.carry(src, 'carry-m4', '--refresh'); self.assertEqual(r.returncode, 0, r.stderr); out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertTrue((self.H / 'command-centre/memory/orca-new-decision.md').exists()); self.assertTrue(Path(out['previousMovedTo']).is_dir(), 'the old tree is kept in the backup')
    def test_symlinks_non_canonical_sources_and_unmigrated_homes_are_refused_before_any_write(self):
        src = self.corpus(); os.symlink(src / 'notes.txt', src / 'link.md')
        self.assertEqual(self.fwd().returncode, 0); r = self.carry(src); self.assertEqual(r.returncode, 2); self.assertIn('symlink', r.stderr)
        self.assertFalse((self.H / 'command-centre/memory').exists())
        os.unlink(src / 'link.md'); alias = self.t / 'alias'; os.symlink(src, alias)
        r = self.carry(alias); self.assertEqual(r.returncode, 2); self.assertIn('canonical', r.stderr)
        shutil.rmtree(self.H / 'command-centre'); r = self.carry(src); self.assertEqual(r.returncode, 2); self.assertIn('not a migrated V4 home', r.stderr)
    def test_forward_memory_source_carries_the_corpus_and_refuses_two_sources(self):
        src = self.corpus()
        r = run('forward', '--legacy-home', str(self.L), '--paseo-home', str(self.H), '--backup', str(self.B), '--authority-company', 'c9', '--authority-programme', 'p9',
                '--issue-api', 'http://127.0.0.1:3200', '--memory-source', str(src))
        self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(self.search(self.H / 'command-centre/memory', 'all'), self.search(src, 'all'))
        steps = [x['step'] for x in json.loads((self.B / 'forward-receipt.json').read_text())['steps']]; self.assertIn('canonical shared memory carried into command-centre/memory', steps)
        shutil.rmtree(self.H / 'command-centre'); (self.P / 'memory').mkdir(); shutil.rmtree(self.B)
        (self.H / 'config.json').write_text(json.dumps(self.cfg))
        r = self.fwd('--memory-source', str(src)); self.assertEqual(r.returncode, 2); self.assertIn('choose one corpus', r.stderr)
class V4ChainDisarm(Fixture):
    """Review W1-1(c): every release switch (forward, rollback) breaks the V4 boot chain while the daemon is stopped."""
    boot = '0b0b0b0b-0000-4000-8000-000000000001'
    def records(self):
        (self.H / 'daemon-boot.json').write_text(json.dumps({'v': 1, 'boot': self.boot}))
        (self.H / f'daemon-boot.json.{self.boot}.tmp').write_text('{}'); (self.H / 'daemon-boot.json.keep').write_text('not ours')
    def test_forward_removes_the_succession_record(self):
        self.records(); r = self.fwd(); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((self.H / 'daemon-boot.json').exists()); self.assertFalse((self.H / f'daemon-boot.json.{self.boot}.tmp').exists())
        self.assertTrue((self.H / 'daemon-boot.json.keep').exists(), 'only the record and its own .tmp siblings')
        step = [s for s in json.loads((self.B / 'forward-receipt.json').read_text())['steps'] if s['step'].startswith('V4 boot chain disarmed')]
        self.assertEqual(step[0]['recordsRemoved'], ['daemon-boot.json', f'daemon-boot.json.{self.boot}.tmp'])
    def test_rollback_voids_seals_before_moving_v4_state_aside(self):
        self.assertEqual(self.fwd().returncode, 0); boots = self.H / 'command-centre/boots'; boots.mkdir(mode=0o700)
        (boots / f'{self.boot}.start').write_text('{}'); (boots / f'{self.boot}.exit').write_text('{}'); self.records()
        r = run('rollback', '--legacy-home', str(self.L), '--paseo-home', str(self.H), '--backup', str(self.B)); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((self.H / 'daemon-boot.json').exists())
        kept = next(p for p in self.B.iterdir() if p.name.startswith('command-centre-after-final-')) / 'boots'
        names = sorted(os.listdir(kept)); self.assertNotIn(f'{self.boot}.exit', names); self.assertTrue(any(n.startswith(f'{self.boot}.exit.void-') for n in names), names)
        self.assertIn(f'{self.boot}.start', names)
    def test_standalone_disarm_for_any_other_release_switch(self):
        self.records(); boots = self.H / 'command-centre/boots'; boots.mkdir(parents=True, mode=0o700); (boots / f'{self.boot}.exit').write_text('{}')
        r = run('disarm-v4-chain', '--legacy-home', str(self.L), '--paseo-home', str(self.H)); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)['sealsVoided'], 1); self.assertFalse((self.H / 'daemon-boot.json').exists())
        self.assertFalse((boots / f'{self.boot}.exit').exists())
    def test_refuses_while_paseo_pid_names_a_live_daemon(self):
        self.records(); (self.H / 'paseo.pid').write_text(json.dumps({'pid': os.getpid(), 'hostname': 'x'}))
        r = self.fwd(); self.assertEqual(r.returncode, 2); self.assertIn('names live pid', r.stderr)
        self.assertTrue((self.H / 'daemon-boot.json').exists(), 'nothing touched while the daemon runs')
        (self.H / 'paseo.pid').write_text('not json'); r = self.fwd(); self.assertEqual(r.returncode, 2); self.assertIn('unreadable', r.stderr)
    def test_a_stale_paseo_pid_does_not_block(self):
        p = subprocess.Popen([sys.executable, '-c', 'pass']); p.wait()
        (self.H / 'paseo.pid').write_text(json.dumps({'pid': p.pid})); r = self.fwd(); self.assertEqual(r.returncode, 0, r.stderr)
    def test_refuses_a_symlinked_boots_directory(self):
        self.assertEqual(self.fwd().returncode, 0); elsewhere = self.t / 'elsewhere'; elsewhere.mkdir(); (elsewhere / 'x.exit').write_text('{}')
        (self.H / 'command-centre/boots').symlink_to(elsewhere)
        r = run('disarm-v4-chain', '--legacy-home', str(self.L), '--paseo-home', str(self.H)); self.assertEqual(r.returncode, 2); self.assertIn('symlink', r.stderr)
        self.assertTrue((elsewhere / 'x.exit').exists(), 'nothing renamed through the link')
    def test_disarm_refused_while_the_daemon_is_served(self):
        self.records(); s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(); port = s.getsockname()[1]
        try: r = self.fwd('--port', str(port)); self.assertEqual(r.returncode, 2)
        finally: s.close()
        self.assertTrue((self.H / 'daemon-boot.json').exists(), 'nothing touched while the daemon runs')
class LiveParity(Fixture):
    """A1/A3/outcomes and the live host labels (prime's decisions on the MIG-CONTENT-GATE inventory)."""
    def book(self, target='owner@book.example', mode=0o400, key_mode=0o600):
        key = self.t / 'keys' / 'transport.secret'; key.parent.mkdir(exist_ok=True); key.write_text('k' * 43); os.chmod(key, key_mode)
        p = self.t / 'book-transport.json'
        if p.exists(): os.chmod(p, 0o600); p.unlink()
        p.write_text(json.dumps({'host': 'macbook', 'sshTarget': target, 'controller': 'ctl', 'keyFile': str(key), 'command': ['/a', '/b', '/c']})); os.chmod(p, mode)
        return p
    def test_live_labels_task_roots_and_defaults(self):
        (self.H / 'server-id').write_text('srv_minifixture01\n')
        r = self.fwd(); self.assertEqual(r.returncode, 0, r.stderr); cc = self.H / 'command-centre'
        v2 = json.loads((cc / 'config.json').read_text())
        self.assertEqual(v2['localHost'], {'name': 'mini', 'serverId': 'srv_minifixture01'}); self.assertNotIn('outcomesRoot', v2)
        self.assertEqual(json.loads((cc / 'task-roots.json').read_text()), {'version': 1, 'roots': [str(self.L / 'tasks')]})
        self.assertEqual(oct(os.stat(cc / 'task-roots.json').st_mode & 0o777), '0o600')
        self.assertFalse((cc / 'book-transport.json').exists())
    def test_book_profile_pinned_byte_exact_and_receipt_names_only(self):
        p = self.book(); raw = p.read_bytes()
        r = self.fwd('--host', 'macbook=srv_bookfixture01@owner@book.example', '--book-profile', str(p))
        self.assertEqual(r.returncode, 0, r.stderr); cc = self.H / 'command-centre'
        self.assertEqual((cc / 'book-transport.json').read_bytes(), raw); self.assertEqual(oct(os.stat(cc / 'book-transport.json').st_mode & 0o777), '0o600')
        self.assertEqual(json.loads((cc / 'config.json').read_text())['hosts'], [{'name': 'macbook', 'serverId': 'srv_bookfixture01', 'sshTarget': 'owner@book.example'}])
        receipt = (self.B / 'forward-receipt.json').read_text()
        self.assertIn('book-transport.json', receipt); self.assertIn('transport.secret', receipt)
        self.assertNotIn('k' * 43, receipt); self.assertNotIn(str(self.t / 'keys'), receipt)
    def test_book_profile_refusals_write_nothing(self):
        cases = [(dict(target='other@book.example'), 'must equal'), (dict(mode=0o644), 'private regular file'), (dict(key_mode=0o644), 'Book key file')]
        for kw, msg in cases:
            p = self.book(**kw)
            r = self.fwd('--host', 'macbook=srv_bookfixture01@owner@book.example', '--book-profile', str(p))
            self.assertEqual(r.returncode, 2, kw); self.assertIn(msg, r.stderr); self.assertFalse((self.H / 'command-centre').exists(), kw)
        p = self.book(); r = self.fwd('--book-profile', str(p)); self.assertEqual(r.returncode, 2); self.assertIn('must equal', r.stderr)
    def test_outcomes_root_and_legacy_tasks_must_be_canonical(self):
        vault = self.t / 'vault' / 'decisions'; vault.mkdir(parents=True); link = self.t / 'vault-link'; link.symlink_to(self.t / 'vault')
        r = self.fwd('--outcomes-root', str(link / 'decisions')); self.assertEqual(r.returncode, 2); self.assertFalse((self.H / 'command-centre').exists())
        tl = self.t / 'tasks-link'; tl.symlink_to(self.L / 'tasks')
        r = self.fwd('--legacy-tasks', str(tl)); self.assertEqual(r.returncode, 2); self.assertIn('legacy tasks', r.stderr); self.assertFalse((self.H / 'command-centre').exists())
        r = self.fwd('--outcomes-root', str(vault)); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads((self.H / 'command-centre/config.json').read_text())['outcomesRoot'], str(vault))

class BookKey(LiveParity):
    def test_book_key_moved_under_denied_grants(self):
        p = self.book(); src = json.loads(p.read_text())['keyFile']; key_before = Path(src).read_bytes()
        r = self.fwd('--host', 'macbook=srv_bookfixture01@owner@book.example', '--book-profile', str(p), '--book-key-into-home')
        self.assertEqual(r.returncode, 0, r.stderr); cc = self.H / 'command-centre'
        k = cc / 'grants/book/transport.secret'
        self.assertEqual(k.read_bytes(), key_before); self.assertEqual(oct(os.stat(k).st_mode & 0o777), '0o600'); self.assertEqual(oct(os.stat(k.parent).st_mode & 0o777), '0o700')
        prof, orig = json.loads((cc / 'book-transport.json').read_text()), json.loads(p.read_text())
        self.assertEqual(prof['keyFile'], str(k)); self.assertEqual({x: y for x, y in prof.items() if x != 'keyFile'}, {x: y for x, y in orig.items() if x != 'keyFile'})
        self.assertEqual(Path(src).read_bytes(), key_before, 'source key unchanged')
        receipt = (self.B / 'forward-receipt.json').read_text(); self.assertNotIn('k' * 43, receipt)
class MemoryRoot(Fixture):
    """DESIGN-NEXT-BUILD B1: set-memory-root points V4's shared memory at an existing canonical folder. The write is gated on
    the INSTALLED bundle accepting the key (an older bundle would refuse to start), backed up, read back, and reversible."""
    NODE = shutil.which('node') or '/opt/homebrew/opt/node@24/bin/node'
    ENTRY = HERE.parent.parent / 'src/portable-memory/entry.mjs'
    CONFIG = HERE.parent.parent / 'orca-organization/server/config.mjs'
    # A REAL released reader from before memoryRoot and roles (C2's conversation release, read-only). The current
    # reader can no longer stand in for one: since L44 it ignores keys it does not know.
    OLD_READER = Path(local_fixture("legacyOldConfigReader"))
    def old_bundle(self, name='old-bundle'):
        """A bundle from before memoryRoot: an entry that loads config through the real old reader."""
        d = self.t / name; d.mkdir()
        (d / 'entry.mjs').write_text(f"import {{ loadConfig }} from {json.dumps(self.OLD_READER.as_uri())}; loadConfig(); process.stdout.write(JSON.stringify({{ jsonrpc: '2.0', id: 1, result: {{}} }}) + '\\n');\n")
        return d / 'entry.mjs'
    def vault(self):
        v = self.t / 'vault' / 'decisions'; v.mkdir(parents=True); (v / 'orca-decision.md').write_text('# D\nOrca decision.\n'); return v
    def setroot(self, root, backup, entry=None, *extra):
        return run('set-memory-root', '--paseo-home', str(self.H), *(['--root', str(root)] if root else []), '--backup', str(self.t / backup),
                   '--bundle-exe', self.NODE, '--bundle-entry', str(entry or self.ENTRY), *extra)
    def v4cfg(self): return self.H / 'command-centre/config.json'
    def migrated(self):
        """A forward-migrated V4 home whose config the real JS validator accepts (the fixture's short authority ids are
        replaced by UUIDs, as a live installation has)."""
        self.assertEqual(self.fwd().returncode, 0); c = json.loads(self.v4cfg().read_text())
        c['authority'].update(companyId='00000000-0000-4000-8000-000000000901', programmeId='00000000-0000-4000-8000-000000000902')
        self.v4cfg().write_text(json.dumps(c, indent=2) + '\n'); os.chmod(self.v4cfg(), 0o600)
    def test_set_is_gated_backed_up_read_back_idempotent_and_clearable(self):
        self.migrated(); v = self.vault(); before = self.v4cfg().read_bytes()
        r = self.setroot(v, 'mr1'); self.assertEqual(r.returncode, 0, r.stderr); out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertTrue(out['changed']); self.assertEqual(json.loads(self.v4cfg().read_text())['memoryRoot'], str(v))
        self.assertEqual({k: x for k, x in json.loads(self.v4cfg().read_text()).items() if k != 'memoryRoot'}, json.loads(before), 'every other key kept')
        self.assertEqual((self.t / 'mr1/command-centre-config.json.pre-memory-root').read_bytes(), before)
        rc = json.loads((self.t / 'mr1/set-memory-root-receipt.json').read_text()); self.assertEqual(rc['outcome'], 'changed'); self.assertTrue(rc['bundleGate']['accepted'])
        r = self.setroot(v, 'mr2'); self.assertEqual(r.returncode, 0, r.stderr); self.assertFalse(json.loads(r.stdout.strip().splitlines()[-1])['changed'])
        r = self.setroot(None, 'mr3', None, '--clear'); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn('memoryRoot', json.loads(self.v4cfg().read_text())); self.assertEqual(json.loads(self.v4cfg().read_text()), json.loads(before))
        self.assertEqual(json.loads((self.t / 'mr3/set-memory-root-clear-receipt.json').read_text())['outcome'], 'changed')
    def test_a_bundle_that_does_not_know_the_key_is_never_given_it(self):
        self.migrated(); v = self.vault(); before = self.v4cfg().read_bytes()
        r = self.setroot(v, 'mr4', self.old_bundle()); self.assertEqual(r.returncode, 2); self.assertIn('does not accept', r.stderr); self.assertIn('Unknown setting config.memoryRoot', r.stderr)
        self.assertEqual(self.v4cfg().read_bytes(), before, 'config untouched'); self.assertFalse((self.t / 'mr4/command-centre-config.json.pre-memory-root').exists())
        rc = json.loads((self.t / 'mr4/set-memory-root-receipt.json').read_text()); self.assertEqual(rc['outcome'], 'refused'); self.assertFalse(rc['bundleGate']['accepted'])
    def test_non_canonical_or_missing_roots_and_unmigrated_homes_are_refused_before_any_write(self):
        self.migrated(); v = self.vault(); alias = self.t / 'alias'; os.symlink(v, alias); before = self.v4cfg().read_bytes()
        for i, bad in enumerate((str(alias), str(self.t / 'missing'), str(v) + '/')):
            r = self.setroot(bad, f'mr-bad{i}'); self.assertEqual(r.returncode, 2, bad); self.assertIn('canonical', r.stderr)
        self.assertEqual(self.v4cfg().read_bytes(), before)
        shutil.rmtree(self.H / 'command-centre'); r = self.setroot(v, 'mr5'); self.assertEqual(r.returncode, 2); self.assertIn('not a migrated V4 home', r.stderr)
class RoleDefaults(Fixture):
    """DESIGN-NEXT-BUILD A5: carry-role-defaults writes exactly the approved table into defaults.roles, gated on the
    INSTALLED bundle accepting it (the hazard: an older bundle refuses defaults.roles and the controller would not start)."""
    NODE, ENTRY, CONFIG = MemoryRoot.NODE, MemoryRoot.ENTRY, MemoryRoot.CONFIG
    migrated, v4cfg, vault = MemoryRoot.migrated, MemoryRoot.v4cfg, MemoryRoot.vault
    APPROVED = {'planning': {'claude': {'model': 'claude/claude-opus-5-5', 'thinkingOptionId': 'high'}},
                'orchestration': {'claude': {'model': 'claude/claude-opus-5-5', 'thinkingOptionId': 'medium'}},
                'implementation': {'provider': 'claude', 'claude': {'model': 'claude/claude-sonnet-5-5', 'thinkingOptionId': 'high'}}}
    def roles(self, backup, *extra, entry=None):
        return run('carry-role-defaults', '--paseo-home', str(self.H), '--backup', str(self.t / backup), '--bundle-exe', self.NODE, '--bundle-entry', str(entry or self.ENTRY), *extra)
    def pre_roles_bundle(self):
        """A bundle from before roles: the real old reader (see MemoryRoot.OLD_READER)."""
        return MemoryRoot.old_bundle(self, 'pre-roles-bundle')
    OLD_READER = MemoryRoot.OLD_READER
    def test_carry_writes_exact_values_idempotent(self):
        self.migrated(); before = self.v4cfg().read_bytes()
        r = self.roles('rd1'); self.assertEqual(r.returncode, 0, r.stderr); out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertTrue(out['changed']); self.assertEqual(json.loads(self.v4cfg().read_text())['defaults']['roles'], self.APPROVED)
        self.assertEqual((self.t / 'rd1/command-centre-config.json.pre-roles').read_bytes(), before)
        rc = json.loads((self.t / 'rd1/carry-role-defaults-receipt.json').read_text()); self.assertEqual(rc['outcome'], 'changed'); self.assertTrue(rc['bundleGate']['accepted'])
        r = self.roles('rd2'); self.assertEqual(r.returncode, 0, r.stderr); self.assertFalse(json.loads(r.stdout.strip().splitlines()[-1])['changed'])
        self.assertFalse((self.t / 'rd2/command-centre-config.json.pre-roles').exists(), 'nothing to back up when unchanged')
        # The restore path: --clear returns the config to exactly its pre-step value.
        r = self.roles('rd3', '--clear'); self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(json.loads(self.v4cfg().read_text()), json.loads(before))
        self.assertEqual(json.loads((self.t / 'rd3/carry-role-defaults-clear-receipt.json').read_text())['outcome'], 'changed')
    def test_refused_when_bundle_validator_rejects(self):
        self.migrated(); before = self.v4cfg().read_bytes()
        r = self.roles('rd4', entry=self.pre_roles_bundle()); self.assertEqual(r.returncode, 2); self.assertIn('does not accept', r.stderr); self.assertIn('Unknown setting defaults.roles', r.stderr)
        self.assertEqual(self.v4cfg().read_bytes(), before, 'config untouched'); self.assertFalse((self.t / 'rd4/command-centre-config.json.pre-roles').exists())
        rc = json.loads((self.t / 'rd4/carry-role-defaults-receipt.json').read_text())
        self.assertEqual([rc['outcome'], rc['refusedCode'], rc['bundleGate']['accepted']], ['refused', 'bundle-does-not-accept-roles', False])
    def test_readback_mismatch_restores(self):
        self.migrated(); before = self.v4cfg().read_bytes()
        # In-process, with the config write corrupted after the backup: the step must put the pre-step bytes back.
        import importlib.util
        spec = importlib.util.spec_from_file_location('w1m_rb', MIG); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        real = m.write_private
        def lossy(path, data):
            if Path(path) == self.v4cfg() and 'roles' in (data if isinstance(data, str) else data.decode()):
                data = data.replace('"high"', '"low"') if isinstance(data, str) else data
            return real(path, data)
        m.write_private = lossy
        with self.assertRaises(m.Refused) as e: m.main(['carry-role-defaults', '--paseo-home', str(self.H), '--backup', str(self.t / 'rd5'), '--bundle-exe', self.NODE, '--bundle-entry', str(self.ENTRY)])
        self.assertIn('restored', str(e.exception)); self.assertEqual(self.v4cfg().read_bytes(), before)
        rc = json.loads((self.t / 'rd5/carry-role-defaults-receipt.json').read_text()); self.assertEqual([rc['outcome'], rc['restored']], ['refused', True])
    def test_other_keys_preserved(self):
        self.migrated(); c = json.loads(self.v4cfg().read_text())
        c['defaults'].update(thinkingOptionId='medium', modes={'claude': 'auto'}); c['memoryRoot'] = str(self.vault())
        self.v4cfg().write_text(json.dumps(c, indent=2) + '\n'); os.chmod(self.v4cfg(), 0o600)
        r = self.roles('rd6'); self.assertEqual(r.returncode, 0, r.stderr); after = json.loads(self.v4cfg().read_text())
        self.assertEqual(after['defaults'].pop('roles'), self.APPROVED); self.assertEqual(after, c, 'every other key, in and outside defaults, kept')
    def test_a_different_table_is_replaced_only_with_refresh(self):
        self.migrated(); c = json.loads(self.v4cfg().read_text()); mine = {'planning': {'claude': {'thinkingOptionId': 'max'}}}
        c['defaults']['roles'] = mine; self.v4cfg().write_text(json.dumps(c, indent=2) + '\n'); os.chmod(self.v4cfg(), 0o600); before = self.v4cfg().read_bytes()
        r = self.roles('rd7'); self.assertEqual(r.returncode, 2); self.assertIn('--refresh', r.stderr); self.assertEqual(self.v4cfg().read_bytes(), before)
        r = self.roles('rd8', '--refresh'); self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(json.loads(self.v4cfg().read_text())['defaults']['roles'], self.APPROVED)
        self.assertEqual(json.loads((self.t / 'rd8/carry-role-defaults-receipt.json').read_text())['previous'], mine)
    def test_forward_writes_given_role_defaults_only_and_validates_them(self):
        r = self.fwd('--role-defaults', json.dumps({'planning': {'claude': {'model': 'codex/gpt-6-astra'}}})); self.assertEqual(r.returncode, 2); self.assertIn('not a claude model selection', r.stderr)
        self.assertFalse((self.H / 'command-centre').exists(), 'refused before any write')
        r = self.fwd('--role-defaults', json.dumps(self.APPROVED)); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(self.v4cfg().read_text())['defaults']['roles'], self.APPROVED)
    def test_the_python_mirror_refuses_what_the_controller_refuses(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('w1m_v', MIG); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        self.assertIs(m.validate_roles(self.APPROVED), self.APPROVED)
        for bad in ({'reviewer': {}}, {'planning': {'gemini': {}}}, {'planning': {'provider': 'gemini'}}, {'planning': {'claude': {'effort': 'high'}}},
                    {'planning': {'claude': {'thinkingOptionId': 'extreme'}}}, {'planning': {'claude': {'model': 'claude/x; rm -rf /'}}},
                    {'planning': {'claude': {'model': 'codex/gpt-6-astra'}}}, {'planning': {'claude': {'modeId': 'bypassPermissions'}}}, {'planning': {'codex': {'modeId': 'full-access'}}}, []):
            with self.assertRaises(m.Refused, msg=repr(bad)): m.validate_roles(bad)
class FleetGate(Fixture):
    """L44: a new setting is written only when EVERY running reader of this config -- each with its own code and
    executable -- loads it. Driven with the REAL old bundles (read-only; each probe runs in a scratch home)."""
    NODE, ENTRY, CONFIG = MemoryRoot.NODE, MemoryRoot.ENTRY, MemoryRoot.CONFIG
    migrated, v4cfg, vault = MemoryRoot.migrated, MemoryRoot.v4cfg, MemoryRoot.vault
    C2 = Path(local_fixture("legacyOperatorJob"))
    OFFICIAL = os.path.expanduser('~/.local/share/orca-node/node-v24.20.0-darwin-arm64/bin/node')
    def old(self):
        app = lambda d: str(self.C2 / d / 'app/Fulcra.app')
        plug = lambda d: app(d) + '/Contents/Resources/bundled-plugins/orca-organization-next'
        return [{'kind': 'mcp', 'exe': app('live-candidate-2') + '/Contents/MacOS/Fulcra', 'code': plug('live-candidate-2') + '/src/control/inbox.mjs', 'scripts': [], 'holders': [{'pid': 1, 'cli': 'claude', 'nativeSession': 'b236e663-old-session'}]},
                {'kind': 'mcp', 'exe': app('live-candidate-2') + '/Contents/MacOS/Fulcra', 'code': plug('live-candidate-2') + '/src/portable-memory/entry.mjs', 'scripts': [], 'holders': [{'pid': 2, 'agent': 'dbeb5e30'}]},
                {'kind': 'mcp', 'exe': app('live-candidate') + '/Contents/MacOS/Fulcra', 'code': plug('live-candidate') + '/src/control/inbox.mjs', 'scripts': [], 'holders': [{'pid': 3, 'nativeSession': '3519e16a'}]},
                {'kind': 'loader', 'exe': self.OFFICIAL, 'code': str(self.C2 / 'releases/orca-conversation-9576e18fa7a6a433/src/config.mjs'), 'scripts': [], 'holders': [{'launcher': '/x/orca-conversation'}]}]
    def new(self):
        return [{'kind': 'mcp', 'exe': self.NODE, 'code': str(self.ENTRY), 'scripts': [], 'holders': [{'pid': 4}]},
                {'kind': 'loader', 'exe': self.NODE, 'code': str(HERE.parent.parent / 'src/config.mjs'), 'scripts': [], 'holders': [{'launcher': '/x/orca-conversation'}]}]
    def readers(self, rs):
        f = self.t / f'readers-{len(list(self.t.glob("readers-*")))}.json'; f.write_text(json.dumps(rs)); return str(f)
    def setroot(self, root, backup, rs, *extra):
        return run('set-memory-root', '--paseo-home', str(self.H), *(['--root', str(root)] if root else []), '--backup', str(self.t / backup),
                   '--bundle-exe', self.NODE, '--bundle-entry', str(self.ENTRY), '--fleet-readers', self.readers(rs), *extra)
    def test_today_the_old_readers_refuse_and_nothing_is_written(self):
        self.migrated(); v = self.vault(); before = self.v4cfg().read_bytes()
        r = self.setroot(v, 'fg1', self.old()); self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn('4 running reader(s) of this config would refuse it; nothing written', r.stderr)
        self.assertIn('Unknown setting config.memoryRoot', r.stderr); self.assertIn('b236e663-old-session', r.stderr); self.assertIn('/x/orca-conversation', r.stderr)
        self.assertEqual(self.v4cfg().read_bytes(), before)
        rc = json.loads((self.t / 'fg1/set-memory-root-receipt.json').read_text())
        self.assertEqual([rc['outcome'], rc['fleetGate']['readers'], rc['fleetGate']['refused']], ['refused', 4, 4])
    def test_when_every_reader_is_new_the_setting_is_written(self):
        self.migrated(); v = self.vault()
        r = self.setroot(v, 'fg2', self.new()); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(self.v4cfg().read_text())['memoryRoot'], str(v))
        rc = json.loads((self.t / 'fg2/set-memory-root-receipt.json').read_text()); self.assertEqual([rc['fleetGate']['readers'], rc['fleetGate']['refused']], [2, 0])
    def test_one_old_reader_among_new_ones_still_refuses(self):
        self.migrated(); v = self.vault(); before = self.v4cfg().read_bytes()
        r = self.setroot(v, 'fg3', self.new() + self.old()[2:3]); self.assertEqual(r.returncode, 2)
        self.assertIn('1 running reader(s)', r.stderr); self.assertIn('3519e16a', r.stderr); self.assertEqual(self.v4cfg().read_bytes(), before)
    def test_removing_a_setting_is_never_gated(self):
        self.migrated(); v = self.vault()
        self.assertEqual(self.setroot(v, 'fg4', self.new()).returncode, 0)
        r = self.setroot(None, 'fg5', self.old(), '--clear'); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn('memoryRoot', json.loads(self.v4cfg().read_text()))
    def test_the_new_reader_loads_a_later_builds_settings(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('w1m_fg', MIG); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        self.migrated(); c = json.loads(self.v4cfg().read_text())
        later = {**c, 'memoryRoot': str(self.vault()), 'futureSetting': {'x': 1}, 'defaults': {**c['defaults'], 'futureDefault': 1}}
        ok, detail = m.probe_config(self.new()[1], later); self.assertTrue(ok, detail)
        ok, detail = m.probe_config(self.old()[3], later); self.assertFalse(ok); self.assertIn('Unknown setting config.', detail)
    def test_the_process_table_scan_finds_only_readers_of_this_config(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('w1m_ps', MIG); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        cc = '/fixture/ph/command-centre'
        table = {('-axww', '-o', 'pid=,command='): '11 /x/Fulcra /b/bundled-plugins/orca-organization-next/src/control/inbox.mjs\n12 /usr/bin/node /r/h6c1/source/src/control/inbox.mjs\n13 /usr/bin/node /other/src/control/inbox.mjs\n14 /bin/zsh -c x',
                 ('eww', '-o', 'command=', '-p', '11'): f'/x/Fulcra inbox.mjs ORCA_HOME={cc} PASEO_AGENT_ID=agent-11',
                 ('eww', '-o', 'command=', '-p', '12'): '/usr/bin/node inbox.mjs HOME=/h',
                 ('eww', '-o', 'command=', '-p', '13'): '/usr/bin/node inbox.mjs ORCA_HOME=/another/command-centre'}
        m._ps = lambda *a: table.get(a, '')
        rs = m.config_readers(Path(cc), launcher=None)
        self.assertEqual([(r['kind'], r['code']) for r in rs], [('mcp', '/b/bundled-plugins/orca-organization-next/src/control/inbox.mjs')], 'the legacy h6c1 server (no ORCA_HOME) and another home are not readers')
        self.assertEqual(rs[0]['holders'][0]['agent'], 'agent-11')
if __name__ == '__main__': unittest.main()
