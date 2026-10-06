import json
import os
import plistlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from legacy_first_cutover import (BoundedCommands, BundlePin, CommandPrefix, CommandUncertain,
                                 FilePin, HostSelection, LegacyFirstCutover, MacLegacyHost,
                                 MiniRuntimeStage, OwnerWindowRequired, runtime_inventory,
                                 CocoaAppTermination, MacProcessTable)
from upgrade_existing_mac import (Busy, FileState, NativeStatus, Plan, Selector, StopIncomplete,
                                  TopologyUnavailable, Upgrade, UpgradeRefused, digest, identity,
                                  mac_process_probe, read_state, seal_bundle)
from upgrade_space import GIB, METADATA_BUDGET, SpaceRefused, bundle_footprint

# Real native-process/CLI counterparts only. Every path/port belongs to the test's
# disposable root. They do not invoke actual launchctl/open/osascript or providers.
FIXTURE = r'''
import json,os,socket,subprocess,sys,time
from pathlib import Path
ROOT = Path(__ROOT__)
STATE = ROOT/'fixture-state.json'
CONFIG = ROOT/'fixture-config.json'
EVENTS = ROOT/'fixture-events.jsonl'
def load(path):
    return json.loads(path.read_text())
def save(data):
    temp=STATE.with_suffix('.tmp'); temp.write_text(json.dumps(data)); temp.replace(STATE)
def event(name):
    with EVENTS.open('a') as stream: stream.write(json.dumps({'action':name,'argv':sys.argv[1:]})+'\n')
def rpc(port,command):
    with socket.create_connection(('127.0.0.1',port),timeout=2) as conn:
        conn.sendall(json.dumps({'command':command}).encode()+b'\n'); out=b''
        while True:
            block=conn.recv(65536)
            if not block: break
            out+=block
        return json.loads(out)
def server(port):
    sock=socket.socket(); sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
    sock.bind(('127.0.0.1',port)); sock.listen(); return sock
if len(sys.argv)>1 and sys.argv[1] in ('--helper','--app'):
    role=sys.argv[1]; c=load(CONFIG); sock=server(c['workerPort'] if role=='--helper' else c['appPort'])
    print('ready',flush=True)
    while True:
        conn,_=sock.accept(); data=conn.recv(4096); conn.sendall(b'{}'); conn.close()
        if b'stop' in data: break
    sock.close(); sys.exit(0)
if len(sys.argv)>1 and sys.argv[1]=='--serve':
    c=load(CONFIG); helper=subprocess.Popen([sys.executable,__file__,'--helper'],stdout=subprocess.PIPE)
    assert helper.stdout.readline()==b'ready\n'
    state=load(STATE); state.update(pid=os.getpid(),workerPid=helper.pid,
                                  startedAt=str(time.time_ns()),serverId='fixture-'+str(time.time_ns()))
    save(state); sock=server(c['port']); print('ready',flush=True)
    while True:
        conn,_=sock.accept(); data=json.loads(conn.recv(4096)); command=data['command']; c=load(CONFIG)
        if command=='stop':
            conn.sendall(b'{}'); conn.close(); sock.close()
            if not c.get('surviveHelper'): rpc(c['workerPort'],'stop'); helper.wait(timeout=5)
            state=load(STATE); state['pid']=None; save(state); break
        if command=='status':
            state=load(STATE); response={'home':str(ROOT/'home'),'pid':os.getpid(),'workerPid':helper.pid,
                'startedAt':state['startedAt'],'serverId':state['serverId'],
                'desktopManaged':c['book'],'listen':'127.0.0.1:'+str(c['port']),
                'localDaemon':'running','connectedDaemon':'reachable'}
        elif command=='ls': response=[{'id':'operator'}]
        elif command=='inspect':
            response={'Id':'operator','Status':c.get('sessionStatus','idle'),
                      'PendingPermissions':[{'id':'permission'}] if c.get('permission') else []}
            if c.get('unknown'): response.pop('PendingPermissions')
        else: raise AssertionError(command)
        conn.sendall(json.dumps(response).encode()); conn.close()
    sys.exit(0)
args=sys.argv[1:]; c=load(CONFIG)
if 'status' in args:
    try: out=rpc(c['port'],'status')
    except ConnectionRefusedError: out={'home':str(ROOT/'home'),'pid':None,'localDaemon':'stopped',
                                     'connectedDaemon':'not_probed','desktopManaged':False}
elif 'ls' in args: out=rpc(c['port'],'ls')
elif 'inspect' in args: out=rpc(c['port'],'inspect')
elif 'stop' in args or args[0]=='bootout': event('stop'); out=rpc(c['port'],'stop')
elif args[0]=='--fixture-quit-pid':
    assert int(args[1])==load(STATE)['appPid']
    event('quit-pid'); out={}
    if not c.get('surviveApp'): rpc(c['appPort'],'stop')
elif args[0] in ('bootstrap','-n'):
    event('start'); out={}
    state=load(STATE)
    if args[0]=='-n':
        app=subprocess.Popen([sys.executable,__file__,'--app'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        assert app.stdout.readline()==b'ready\n'; state['appPid']=app.pid; save(state)
    daemon=subprocess.Popen([sys.executable,__file__,'--serve'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    assert daemon.stdout.readline()==b'ready\n'
else: raise AssertionError(args)
print(json.dumps(out))
'''


class Counterpart:
    def __init__(self, root, book):
        self.root, self.book = root, book
        self.config = root / 'fixture-config.json'
        self.state = root / 'fixture-state.json'
        self.config.write_text(json.dumps({'book': book, 'port': self.port(),
                                          'workerPort': self.port(), 'appPort': self.port()}))
        self.state.write_text(json.dumps({'pid': None, 'appPid': None}))
        self.script = root / 'fixture-cli.py'
        self.script.write_text(FIXTURE.replace('__ROOT__', repr(str(root))))
        self.script.chmod(0o600)
        self.owned = []
        if book:
            self.app = self.spawn('--app')
            data = self.data(); data['appPid'] = self.app.pid; self.state.write_text(json.dumps(data))
        self.daemon = self.spawn('--serve')

    @staticmethod
    def port():
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            return sock.getsockname()[1]

    def spawn(self, role):
        child = subprocess.Popen(['/usr/bin/python3', str(self.script), role],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.owned.append(child)
        if child.stdout.readline() != b'ready\n':
            raise AssertionError(child.stderr.read().decode())
        return child

    def data(self):
        return json.loads(self.state.read_text())

    def values(self):
        return json.loads(self.config.read_text())

    def set(self, **values):
        self.config.write_text(json.dumps({**self.values(), **values}))

    def prefix(self):
        paths = (Path('/usr/bin/python3'), self.script)
        return CommandPrefix(tuple(map(str, paths)), tuple(FilePin.capture(p) for p in paths))

    def app_identity(self):
        pid = self.data().get('appPid')
        return mac_process_probe(pid) if pid else None

    def rows(self, commands):
        # Typed native table counterpart scoped to ONLY the real fixture tree.
        # Kernel lifetime/path probes themselves use production macOS libproc.
        for child in self.owned:
            child.poll()  # Reap our fixture children; never signal them.
        data = self.data()
        pid, worker, app = data.get('pid'), data.get('workerPid'), data.get('appPid')
        rows = {}
        for value, parent in ((pid, 1), (worker, pid or 1), (app, 1)):
            if value and mac_process_probe(value) is not None:
                rows[value] = parent
        return rows

    def resource_users(self, commands, bundles):
        observer = CommandPrefix(('/usr/sbin/lsof',), (FilePin.capture(Path('/usr/sbin/lsof')),))
        return MacProcessTable(None, resource_command=observer).resource_users(commands, bundles)

    def roots(self):
        return tuple(mac_process_probe(pid) for pid in self.rows(None))

    def events(self):
        path = self.root / 'fixture-events.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def close(self):
        c = self.values()
        for port in (c['port'], c['workerPort'], c['appPort']):
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=1) as connection:
                    connection.sendall(b'{"command":"stop"}\n')
                    connection.recv(1024)
            except ConnectionRefusedError:
                pass
        for child in self.owned:
            child.wait(timeout=5)
            child.stdout.close(); child.stderr.close()
        deadline = time.monotonic() + 5
        for value in self.data().values():
            if type(value) is int and value > 1:
                while mac_process_probe(value) is not None:
                    if time.monotonic() > deadline:
                        raise AssertionError('Fixture process did not exit normally')
                    time.sleep(0.01)


class FixtureAppTermination:
    def __init__(self, counterpart):
        self.counterpart = counterpart

    def terminate(self, expected):
        self.counterpart.assert_app = expected
        class Application:
            def pid(self): return self.counterpart.data()['appPid']
            def executable(self): return mac_process_probe(self.pid()).executable
            def terminate(self):
                result=subprocess.run(self.counterpart.prefix().argv+
                    ('--fixture-quit-pid',str(expected.pid)),capture_output=True,check=True,timeout=5)
                return result.returncode==0
            def close(self): pass
        application=Application(); application.counterpart=self.counterpart
        CocoaAppTermination(application_for_pid=lambda pid: application).terminate(expected)


class LegacyFirstCutoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.counterpart = None
        self.available = 30 * GIB

    def tearDown(self):
        if self.counterpart is not None:
            self.counterpart.close()
        self.temp.cleanup()

    def app(self, path, content):
        (path / 'Contents/MacOS').mkdir(parents=True)
        (path / 'Contents/Resources').mkdir()
        (path / 'Contents/MacOS/Fulcra').write_bytes(b'fixture executable ' + content)
        (path / 'Contents/MacOS/Fulcra').chmod(0o755)
        (path / 'Contents/Resources/app.asar').write_bytes(content)
        (path / 'Contents/Resources/app.asar').chmod(0o644)
        (path / 'Contents/Resources/node-entrypoint-runner.js').write_bytes(b'fixture node runner')
        (path / 'Contents/Resources/node-entrypoint-runner.js').chmod(0o644)
        (path / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'com.example.FulcraFixture'}))
        (path / 'Contents/Info.plist').chmod(0o644)

    def make(self, *, book=False):
        if sys.platform != 'darwin':
            self.skipTest('Real counterpart kernel lifetime tests require macOS')
        self.home = self.root / 'home'; self.home.mkdir()
        self.history = self.home / 'history'; self.history.write_bytes(b'prior history\n')
        self.settings = self.home / 'settings.json'
        self.settings.write_bytes(b'{"commandCentreEnabled":true,"manageBuiltInDaemon":false,"keepRunningAfterQuit":false}')
        self.source = self.root / 'source.app'; self.installed = self.root / 'installed.app'
        self.app(self.source, b'new app'); self.app(self.installed, b'actual old app')
        self.counterpart = Counterpart(self.root, book)
        prefix = self.counterpart.prefix()
        self.selector = self.root / 'selected.plist'
        self.selector.write_bytes(b'prior Book selector')
        self.selector.chmod(0o640)
        runtime = None
        old_bundles = (BundlePin(self.installed, seal_bundle(self.installed)),)
        release = self.root / 'release.app'
        if not book:
            old = self.root / 'actual-current'; self.app(old / 'app/Fulcra.app', b'actual current daemon')
            service = old / 'service'; service.mkdir()
            (service / 'launch.py').write_bytes(b'# selected current fixture launcher\n')
            (service / 'runtime_launch.py').write_bytes(b'# selected current fixture inventory launcher\n')
            app = old / 'app/Fulcra.app'
            role = {'topology':'owned-child', 'argv':[str(app/'Contents/MacOS/Fulcra'),
                    str(app/'Contents/Resources/node-entrypoint-runner.js'),'node-script',
                    str(app/'Contents/Resources/app.asar/node_modules/server/supervisor.js')],
                    'cwd':str(app/'Contents/Resources'),
                    'required':[str(app/'Contents/MacOS/Fulcra'),str(app/'Contents/Resources/app.asar')],
                    'pins':{str(p):digest(p) for p in (app/'Contents/MacOS/Fulcra',app/'Contents/Resources/app.asar',
                                                     app/'Contents/Resources/node-entrypoint-runner.js')},
                    'env':{'PASEO_HOME':str(self.home),'PASEO_LISTEN':'127.0.0.1:'+str(self.counterpart.values()['port']),
                           'FULCRA_COMMAND_CENTRE':'1','ELECTRON_RUN_AS_NODE':'1','PATH':'/usr/bin:/bin'}}
            (service/'profiles.json').write_text(json.dumps({'version':1,'roles':{'paseo':role}}))
            python = FilePin.capture(Path('/usr/bin/python3'))
            manifest = {'version':1,'externalPins':{str(python.path):{'resolved':str(python.resolved),'sha256':python.sha256}},
                        'roots':{str(app):runtime_inventory(app),str(service):runtime_inventory(service)},
                        'roles':{'paseo':[str(python.path),str(service/'launch.py'),str(service/'profiles.json'),
                                          digest(service/'profiles.json'),'paseo']}}
            (old/'daemon-manifest.json').write_text(json.dumps(manifest))
            args = [str(python.path),str(service/'runtime_launch.py'),str(old/'daemon-manifest.json'),
                    digest(old/'daemon-manifest.json'),'paseo']
            self.selector.write_bytes(plistlib.dumps({'Label':'fixture.selected.job','ProgramArguments':args,
                 'KeepAlive':True,'ExitTimeOut':30,'RunAtLoad':True,'ThrottleInterval':30,
                 'StandardErrorPath':str(self.root/'legacy.stderr'),'WorkingDirectory':str(self.root)}))
            runtime = MiniRuntimeStage(old, self.root/'next-immutable', self.selector,
                        FilePin.capture(service/'launch.py'), FilePin.capture(service/'runtime_launch.py'),
                        FilePin.capture(service/'profiles.json'),FilePin.capture(old/'daemon-manifest.json'),python)
            release = runtime.new_root/'app/Fulcra.app'
            old_bundles += (BundlePin(app,seal_bundle(app)),)
        self.plan = Plan(self.source,seal_bundle(self.source),bundle_footprint(self.source),release,
                         self.root/'install-temp.app',self.installed,self.root/'rollback.app',self.root/'metadata',
                         self.home,book,(self.home,),
                         (Selector(self.selector,read_state(self.selector) if not book else FileState('file',b'new Book selector')),),
                         (self.settings,),self.source)
        new_bundles = (BundlePin(self.installed,self.plan.seal), BundlePin(release,self.plan.seal))
        selection = HostSelection('book-desktop' if book else 'mini-launchd',prefix,prefix,
                         self.counterpart.roots(),old_bundles,new_bundles,
                         ('127.0.0.1',self.counterpart.values()['port']),
                         app_process=self.counterpart.app_identity() if book else None,
                         bundle_id='com.example.FulcraFixture' if book else None,
                         open_command=prefix if book else None,
                         launchctl=None if book else prefix,launchd_label=None if book else 'fixture.selected.job',
                         plist_selector=None if book else self.selector,stop_timeout=0.5)
        image = mac_process_probe(self.counterpart.daemon.pid)
        self.host = MacLegacyHost(selection,table=self.counterpart,app_locator=self.counterpart.app_identity,
                                 app_termination=FixtureAppTermination(self.counterpart),
                                 image_validator=lambda process, bundles:
                                     (process.executable, process.file_identity) == (image.executable, image.file_identity))
        self.tx = LegacyFirstCutover(self.plan,self.host,mini_runtime=runtime,
                                     statvfs=lambda _:SimpleNamespace(f_bavail=self.available,f_frsize=1))
        return self.tx

    def test_mini_stages_current_closure_and_nonlive_plist_only(self):
        tx = self.make(); prior = read_state(self.selector); settings=self.settings.read_bytes()
        tx.prepare()
        self.assertEqual(read_state(self.selector),prior)
        self.assertEqual((self.installed/'Contents/Resources/app.asar').read_bytes(),b'actual old app')
        self.assertEqual(self.counterpart.events(),[])
        self.assertEqual(self.settings.read_bytes(),settings)
        self.assertFalse(tx.legacy_observation.global_complete)
        self.assertFalse(tx.legacy_observation.atomic)
        self.assertNotIsInstance(tx.legacy_observation,NativeStatus)
        new=plistlib.loads(read_state(tx.staged_selectors[self.selector]).data)
        old=plistlib.loads(prior.data)
        self.assertEqual({k:v for k,v in old.items() if k!='ProgramArguments'},
                         {k:v for k,v in new.items() if k!='ProgramArguments'})
        self.assertTrue(new['ProgramArguments'][1].startswith(str(tx.mini_runtime.new_root)))
        manifest=json.loads((tx.mini_runtime.new_root/'daemon-manifest.json').read_text())
        self.assertEqual(manifest['roots'][str(tx.plan.release)],runtime_inventory(tx.plan.release))
        for p in ('launch.py','runtime_launch.py'):
            self.assertEqual((tx.mini_runtime.new_root/'service'/p).read_bytes(),
                             (tx.mini_runtime.old_root/'service'/p).read_bytes())
        with self.assertRaises(OwnerWindowRequired): tx.cutover()
        self.assertEqual(self.counterpart.events(),[])

    def test_mini_real_command_cutover_and_exact_binary_selector_rollback(self):
        tx=self.make(); prior=identity(self.selector); priorapp=identity(self.installed)
        old_plist=self.selector.read_bytes(); tx.prepare(); tx.cutover(owner_window_selected=True)
        self.assertEqual([e['action'] for e in self.counterpart.events()],['stop','start'])
        self.assertEqual((self.installed/'Contents/Resources/app.asar').read_bytes(),b'new app')
        self.history.write_bytes(b'prior history\nnewer history\n')
        self.settings.write_bytes(b'newer settings')
        tx.rollback(owner_window_selected=True)
        self.assertEqual(identity(self.selector),prior); self.assertEqual(identity(self.installed),priorapp)
        self.assertEqual(self.selector.read_bytes(),old_plist)
        self.assertEqual(self.history.read_bytes(),b'prior history\nnewer history\n')
        self.assertEqual(self.settings.read_bytes(),b'newer settings')
        self.assertLessEqual(tx.used_bytes,METADATA_BUDGET)
        self.assertFalse(any('--force' in e['argv'] for e in self.counterpart.events()))

    def test_book_real_stop_quit_open_route_and_exact_rollback(self):
        tx=self.make(book=True); prior=identity(self.installed); tx.prepare()
        tx.cutover(owner_window_selected=True)
        self.assertEqual([e['action'] for e in self.counterpart.events()],['stop','quit-pid','start'])
        self.assertEqual(self.counterpart.events()[0]['argv'][:4],['--home',str(self.home),'daemon','stop'])
        self.assertEqual(self.counterpart.events()[2]['argv'],['-n','-a',str(self.installed)])
        tx.rollback(owner_window_selected=True)
        self.assertEqual(identity(self.installed),prior)

    def test_known_busy_permission_unknown_refuse_before_stop(self):
        tx=self.make(); tx.prepare()
        for flags,error in (({'sessionStatus':'running'},Busy),({'sessionStatus':'idle','permission':True},Busy),
                            ({'permission':False,'unknown':True},TopologyUnavailable)):
            self.counterpart.set(**flags)
            with self.assertRaises(error): tx.cutover(owner_window_selected=True)
            self.assertEqual(self.counterpart.events(),[])
        self.assertFalse(self.plan.rollback.exists())

    def test_surviving_helper_refuses_before_any_live_path_swap(self):
        tx=self.make(); tx.prepare(); self.counterpart.set(surviveHelper=True)
        with self.assertRaises(StopIncomplete): tx.cutover(owner_window_selected=True)
        self.assertEqual([e['action'] for e in self.counterpart.events()],['stop'])
        self.assertEqual((self.installed/'Contents/Resources/app.asar').read_bytes(),b'actual old app')
        self.assertFalse(self.plan.rollback.exists())

    def test_book_quit_with_surviving_app_refuses_swap(self):
        tx=self.make(book=True); tx.prepare(); self.counterpart.set(surviveApp=True)
        with self.assertRaises(StopIncomplete): tx.cutover(owner_window_selected=True)
        self.assertEqual((self.installed/'Contents/Resources/app.asar').read_bytes(),b'actual old app')
        self.assertFalse(self.plan.rollback.exists())

    def test_capacity_refusal_before_any_stage_or_command_callbacks(self):
        tx=self.make(); self.available=9*GIB
        with self.assertRaises(SpaceRefused): tx.prepare()
        self.assertFalse(tx.mini_runtime.new_root.exists())
        self.assertEqual(self.counterpart.events(),[])

    def test_changed_staged_bytes_selector_and_process_identity_refuse(self):
        tx=self.make(); tx.prepare()
        (tx.plan.install_stage/'Contents/Resources/app.asar').write_bytes(b'corrupt stage')
        with self.assertRaises(UpgradeRefused): tx.cutover(owner_window_selected=True)
        self.assertEqual(self.counterpart.events(),[])

    def test_changed_current_helper_byte_pin_refuses_staging(self):
        tx=self.make(); (tx.mini_runtime.launch.path).write_bytes(b'changed deployed helper')
        with self.assertRaises(UpgradeRefused): tx.prepare()
        self.assertFalse(tx.mini_runtime.new_root.exists())
        self.assertEqual(self.counterpart.events(),[])

    def test_changed_future_manifest_pin_refuses_before_service_action(self):
        tx=self.make(); tx.prepare()
        profile=tx.mini_runtime.new_root/'service/profiles.json'; profile.chmod(0o600); profile.write_bytes(b'changed future profile')
        with self.assertRaises(UpgradeRefused): tx.cutover(owner_window_selected=True)
        self.assertEqual(self.counterpart.events(),[])

    def test_changed_kernel_root_lifetime_refuses_before_stop(self):
        tx=self.make(); tx.prepare(); native=self.host.probe
        pid=tx.captured.supervisor_pid
        self.host.probe=lambda value: replace(native(value),started='different lifetime') if value==pid else native(value)
        with self.assertRaises(UpgradeRefused): tx.cutover(owner_window_selected=True)
        self.assertEqual(self.counterpart.events(),[])

    def test_external_report_has_separate_capacity_preflight_and_shared_budget(self):
        tx=self.make(); reports=self.root/'reports'; reports.mkdir(); tx.external_report=reports/'ready.json'
        tx.statvfs=lambda path: SimpleNamespace(f_bavail=1,f_frsize=1)
        with self.assertRaises(SpaceRefused): tx.prepare()
        self.assertFalse(tx.mini_runtime.new_root.exists())
        self.assertEqual(self.counterpart.events(),[])

    def test_bounded_external_report_is_an_honest_preparation_record(self):
        tx=self.make(); reports=self.root/'reports'; reports.mkdir(); tx.external_report=reports/'ready.json'
        tx.prepare(); data=json.loads(tx.external_report.read_text())
        self.assertFalse(data['globalComplete']); self.assertFalse(data['atomic'])
        self.assertEqual(tx.report_devices['metadata'],reports.stat().st_dev)
        self.assertLessEqual(tx.used_bytes,METADATA_BUDGET)
        self.assertEqual(self.counterpart.events(),[])

    def test_book_cli_byte_pins_follow_actual_app_replacement_and_rollback(self):
        tx=self.make(book=True)
        relative=Path('Contents/Resources/selected-cli.py')
        old=self.installed/relative; new=self.source/relative
        old.write_bytes(self.counterpart.script.read_bytes()); old.chmod(0o600)
        new.write_bytes(self.counterpart.script.read_bytes()+b'\n# new sealed fixture CLI\n'); new.chmod(0o600)
        python=FilePin.capture(Path('/usr/bin/python3'))
        old_cli=CommandPrefix(('/usr/bin/python3',str(old)),(python,FilePin.capture(old)))
        new_cli=CommandPrefix(('/usr/bin/python3',str(old)),(python,FilePin.planned(old,new)))
        tx.plan=replace(tx.plan,seal=seal_bundle(self.source),measured=bundle_footprint(self.source))
        self.host.selection=replace(self.host.selection,old_cli=old_cli,new_cli=new_cli,
             old_bundles=(BundlePin(self.installed,seal_bundle(self.installed)),),
             new_bundles=(BundlePin(self.installed,tx.plan.seal),BundlePin(tx.plan.release,tx.plan.seal)))
        tx.prepare().cutover(owner_window_selected=True).rollback(owner_window_selected=True)
        self.assertEqual(old.read_bytes(),self.counterpart.script.read_bytes())

    def test_cocoa_pid_binding_refuses_shared_bundle_wrong_receiver_and_preserves_voice(self):
        tx=self.make(book=True)
        voice=subprocess.Popen(['/usr/bin/python3','-u','-c',
                                'import sys; print("ready",flush=True); sys.stdin.readline()'],
                               stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.assertEqual(voice.stdout.readline(),b'ready\n')
        calls=[]
        expected=self.counterpart.app_identity()
        class WrongReceiver:
            bundle_id='dev.orca.workspace.desktop'
            def pid(self): return voice.pid
            def executable(self): return mac_process_probe(voice.pid).executable
            def terminate(self): calls.append(voice.pid); return True
            def close(self): pass
        try:
            port=CocoaAppTermination(application_for_pid=lambda pid: WrongReceiver())
            with self.assertRaises(UpgradeRefused): port.terminate(expected)
            self.assertEqual(calls,[])
            self.assertIsNotNone(mac_process_probe(expected.pid))
            self.assertIsNone(voice.poll())
            tx.prepare().cutover(owner_window_selected=True)
            self.assertIsNone(voice.poll())
            self.assertEqual(self.counterpart.events()[1]['argv'],['--fixture-quit-pid',str(expected.pid)])
        finally:
            voice.communicate(b'normal exit\n',timeout=5)

    def test_real_native_pid_parent_table_command(self):
        prefix=CommandPrefix(('/bin/ps',),(FilePin.capture(Path('/bin/ps')),))
        output=[]
        runner=BoundedCommands(lambda action: self.assertFalse(action),output.append)
        rows=MacProcessTable(prefix).rows(runner)
        self.assertEqual(rows[os.getpid()],os.getppid())
        self.assertLess(sum(output),1024*1024)

    def test_strict_future_mode_is_still_unavailable(self):
        tx=self.make(book=True)
        strict=Upgrade(tx.plan,statvfs=lambda _:SimpleNamespace(f_bavail=30*GIB,f_frsize=1))
        strict.prepare()
        with self.assertRaises(TopologyUnavailable): strict.cutover()
        self.assertEqual(self.counterpart.events(),[])

    def test_bounded_command_timeout_never_kills_or_replays(self):
        script=self.root/'slow.py'; script.write_text('import time; time.sleep(0.25); print("done")')
        prefix=CommandPrefix(('/usr/bin/python3',str(script)),
                             (FilePin.capture(Path('/usr/bin/python3')),FilePin.capture(script)))
        runner=BoundedCommands(lambda action:None,lambda count:None)
        with self.assertRaises(CommandUncertain): runner.run(prefix,(),timeout=0.05)
        self.assertEqual(len(runner.uncertain),1)
        self.assertIsNone(runner.uncertain[0].poll())
        with self.assertRaises(CommandUncertain): runner.run(prefix,())
        child=runner.uncertain[0]; child.wait(timeout=2); child.stdout.close(); child.stderr.close()
        self.assertEqual(child.returncode,0)


if __name__=='__main__':
    unittest.main()
