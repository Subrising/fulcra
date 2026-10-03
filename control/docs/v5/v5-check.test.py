"""Bounded offline checker regressions; no app, daemon, auth or trial is launched."""
import ast
import copy
import ctypes
import os
import pathlib
import runpy
import shutil
import signal
import subprocess
import sys
from types import SimpleNamespace

control = pathlib.Path(__file__).resolve().parents[2]
# Retain the existing full positive/refusal fixture suite, without editing it.
suite = runpy.run_path(str(control / 'tools/v5-check.test.py'))
obs, write, run, extra = [suite[k] for k in ['obs', 'write', 'run', 'extra']]
exe, state = suite['exe'], suite['state']

# C2 E4 run 3 observed title, selected port 16997 and extra 57914. The fixture
# uses those ports, confined test paths, a real-shape bridge refusal and actual
# executable/environment observation fields instead of the hidden ps fields.
packaged = copy.deepcopy(obs)
suite['common'][suite['common'].index('--port') + 1] = '16997'
# Baseline identity includes the selected port; regenerate only fixture baseline.
baseline = suite['home'] / 'baseline.json'
data = __import__('json').loads(baseline.read_text())
data['port'] = 16997
baseline.write_text(__import__('json').dumps(data))
packaged['processes'][0]['command'] = 'Fulcra Daemon'
packaged.pop('daemon_environment')
packaged.update(daemon_executable=str(exe), daemon_paseo_home=str(state),
                listeners='n127.0.0.1:57914\nn127.0.0.1:16997\n',
                opencode_bridge={'port': 57914, 'status': 401, 'body': {'error': 'Unauthorized'}})
write(packaged)
run('captured-retitled-two-loopbacks', extra, 0)

cases = [
    ('title-only-refused', lambda o: o.pop('daemon_executable')),
    ('wrong-runtime', lambda o: o.update(daemon_executable='/usr/bin/node')),
    ('runtime-suffix', lambda o: o.update(daemon_executable=str(exe)+'.old')),
    ('missing-runtime', lambda o: o.update(daemon_executable=None)),
    ('duplicate-daemon-pid', lambda o: o['processes'].append(copy.deepcopy(o['processes'][0]))),
    ('retitled-wrong-owner', lambda o: o['processes'][0].update(uid=999999)),
    ('missing-home', lambda o: o.pop('daemon_paseo_home')),
    ('wrong-kernel-home', lambda o: o.update(daemon_paseo_home='/wrong')),
    ('selected-port-missing', lambda o: o.update(listeners='n127.0.0.1:57914\n')),
    ('external-bridge', lambda o: o.update(listeners='n192.0.2.1:57914\nn127.0.0.1:16997\n')),
    ('wildcard-bridge', lambda o: o.update(listeners='n*:57914\nn127.0.0.1:16997\n')),
    ('ipv6-bridge', lambda o: o.update(listeners='n[::1]:57914\nn127.0.0.1:16997\n')),
    ('multiple-extra-ports', lambda o: o.update(listeners=o['listeners']+'n127.0.0.1:57915\n')),
    ('wrong-listener-pid', lambda o: o.update(listeners='p9000\n'+o['listeners'])),
    ('ambiguous-listener-pids', lambda o: o.update(listeners='p1001\np1001\n'+o['listeners'])),
    ('malformed-listener-observation', lambda o: o.update(listeners=o['listeners']+'unknown\n')),
    ('privileged-bridge', lambda o: o.update(listeners='n127.0.0.1:80\nn127.0.0.1:16997\n')),
    ('protected-bridge-6767', lambda o: o.update(listeners='n127.0.0.1:6767\nn127.0.0.1:16997\n')),
    ('protected-bridge-6791', lambda o: o.update(listeners='n127.0.0.1:6791\nn127.0.0.1:16997\n')),
    ('bridge-unavailable', lambda o: o.pop('opencode_bridge')),
    ('bridge-wrong-port', lambda o: o['opencode_bridge'].update(port=57915)),
    ('bridge-success-not-refusal', lambda o: o['opencode_bridge'].update(status=200)),
    ('bridge-redirect', lambda o: o['opencode_bridge'].update(status=302)),
    ('bridge-generic-error', lambda o: o['opencode_bridge'].update(body={'error':'forbidden'})),
    ('bridge-extra-response-fields', lambda o: o['opencode_bridge']['body'].update(other=True)),
]
for name, mutate in cases:
    value = copy.deepcopy(packaged)
    mutate(value)
    write(value)
    run(name, extra, 1, 'daemon')
for name, check, mutate in [
    ('retitled-child-parent', 'controller-child', lambda o: o['processes'][1].update(ppid=9000)),
    ('retitled-child-owner', 'controller-child', lambda o: o['processes'][1].update(uid=999999)),
    ('retitled-duplicate-controller', 'controller-child', lambda o: o['processes'].append(dict(o['processes'][1],pid=1003))),
    ('retitled-protected-home', 'open-paths-and-ports', lambda o: o.update(open_files='n'+str(suite['root']/'protected-home/private-file')+'\n')),
    ('retitled-protected-connection', 'open-paths-and-ports', lambda o: o.update(open_files='n127.0.0.1:50000->127.0.0.1:6791\n')),
]:
    value = copy.deepcopy(packaged)
    mutate(value)
    write(value)
    run(name, extra, 1, check)
write(packaged)
suite['config'].chmod(0o644)
run('retitled-private-state-refusal', extra, 1, 'state-modes')
suite['config'].chmod(0o600)
value = copy.deepcopy(packaged)
value['listeners'] = 'n127.0.0.1:16997\nn[::1]:16997\n'
value.pop('opencode_bridge')
write(value)
run('selected-dual-stack-no-bridge', extra, 0)
value = copy.deepcopy(packaged)
value['listeners'] = 'n127.0.0.1:16997\n'
write(value)
run('bridge-without-listener-refused', extra, 1, 'daemon')

# Exercise the actual observation helpers by extracting functions from the shell
# heredoc, never executing its CLI or observing a user's existing processes.
source = (control / 'docs/v5/v5-check.sh').read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
tree = ast.parse(source)
helpers = {'require','selected_home_from_procargs','process_paseo_home','executable_path','listener_ports','bridge_refusal','observe'}
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in helpers]
import http.client
import json
ns = dict(ctypes=ctypes, os=os, sys=sys, a=SimpleNamespace(port=16997,daemon_pid=1001,fixture=True),
          re=__import__('re'), http=__import__('http'), json=json, pathlib=pathlib, signal=signal)
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(control/'docs/v5/v5-check.sh'), 'exec'), ns)
parse = ns['selected_home_from_procargs']
header = (3).to_bytes(4, sys.byteorder, signed=True) + b'/bundle/Fulcra\0\0'
retitled = header + b'Fulcra Daemon\0\0\0\0PATH=/fixture\0PASEO_HOME=/fixture/state\0\0'
assert parse(retitled) == '/fixture/state'
ordinary = header + b'/bundle/Fulcra\0-e\0script\0PATH=/fixture\0PASEO_HOME=/fixture/state\0\0'
assert parse(ordinary) == '/fixture/state'
for bad in [b'', retitled.replace(b'PASEO_HOME=', b'OTHER_HOME='),
            retitled.replace(b'PASEO_HOME=/fixture/state', b'PASEO_HOME='),
            retitled.replace(b'PASEO_HOME=/fixture/state', b'PASEO_HOME=/one\0PASEO_HOME=/two'),
            header+b'PASEO_HOME=/spoof\0-e\0script\0PATH=/fixture\0\0',
            ordinary[:-2]]:
    try: parse(bad)
    except ValueError: pass
    else: raise AssertionError('invalid kernel process-argument data accepted')

# Probe only a child started here with an explicit sanitized environment. It is
# a titled Node process with no sockets, providers, app or credential variables.
if sys.platform == 'darwin':
    child = subprocess.Popen(['node', '-e', 'process.title="Fulcra Daemon"; console.log("ready"); setTimeout(()=>{},5000)'],
                             env={'PATH':os.environ['PATH'], 'PASEO_HOME':'/fixture/v5-state'},
                             stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == 'ready'
        assert ns['process_paseo_home'](child.pid) == '/fixture/v5-state'
        assert pathlib.Path(ns['executable_path'](child.pid)).resolve() == pathlib.Path(shutil.which('node')).resolve()
    finally:
        child.terminate()
        child.wait(timeout=3)
    print('PASS: native proc_pidpath + KERN_PROCARGS2 on sanitized retitled child')

# Simulate the LIVE collector through its real function to verify owner checks,
# refusal probing and process continuity ordering. All observation calls are
# replaced; no existing process, environment or listener is inspected.
collector = dict(ns)
collector.update(a=SimpleNamespace(fixture=None, capture_baseline=False, daemon_pid=1001,
                                  daemon_entry='Contents/MacOS/Fulcra', port=16997),
                 sys=SimpleNamespace(platform='darwin', byteorder=sys.byteorder),
                 launch_inventory=lambda home: {}, entry=lambda relative: str(exe))
collector_nodes = [n for n in nodes if n.name in {'observe', 'listener_ports'}]
exec(compile(ast.Module(body=collector_nodes, type_ignores=[]), '<collector>', 'exec'), collector)
anchor = f'{os.getuid()} 1 Mon Oct 3 01:02:03 2026\n'
for case in ['valid', 'foreign-owner', 'wrong-executable', 'missing-executable', 'missing-home', 'pid-replaced']:
    calls, anchors = [], []
    def command(args, allow_empty=False):
        if args[:3] == ['/bin/ps', '-axo', 'pid=,ppid=,uid=,command=']:
            uid = 999999 if case == 'foreign-owner' else os.getuid()
            return f'1001 1 {uid} Fulcra Daemon\n'
        if args[:2] == ['/bin/ps', '-p']:
            anchors.append(True)
            return anchor+'changed' if case == 'pid-replaced' and len(anchors) > 1 else anchor
        if '-iTCP' in args: return 'p1001\nn127.0.0.1:16997\nn127.0.0.1:57914\n'
        return 'p1001\nn'+str(state)+'\n'
    def get_executable(pid):
        calls.append('executable')
        if case == 'missing-executable': raise ValueError('unavailable')
        return '/usr/bin/node' if case == 'wrong-executable' else str(exe)
    def get_home(pid):
        calls.append('home')
        if case == 'missing-home': raise ValueError('unavailable')
        return str(state)
    def get_refusal(port):
        calls.append('bridge')
        return {'port':port, 'status':401, 'body':{'error':'Unauthorized'}}
    collector.update(command=command, executable_path=get_executable,
                     process_paseo_home=get_home, bridge_refusal=get_refusal)
    try: data = collector['observe']()
    except ValueError:
        assert case != 'valid', case
    else:
        assert case == 'valid', case
        assert data['daemon_paseo_home'] == str(state) and 'daemon_environment' not in data
    if case == 'foreign-owner': assert not calls
    if case in ['wrong-executable', 'missing-executable']: assert 'home' not in calls

# Ensure the bridge request is bounded, credential-free and never follows a
# redirect. HTTPConnection is mocked, so the tests make no network requests.
requests = []
class Response:
    status = 401
    body = b'{"error":"Unauthorized"}'
    def read(self, limit):
        assert limit == 1025
        return self.body[:limit]
class Connection:
    def __init__(self, host, port, timeout):
        assert (host,port,timeout) == ('127.0.0.1',57914,3)
    def request(self, method, route, headers): requests.append((method,route,headers))
    def getresponse(self): return response
    def close(self): pass
bridge_ns = dict(ns, http=SimpleNamespace(client=SimpleNamespace(HTTPConnection=Connection)))
exec(compile(ast.Module(body=[n for n in nodes if n.name == 'bridge_refusal'], type_ignores=[]), '<bridge>', 'exec'), bridge_ns)
for status, body, passes in [(401,b'{"error":"Unauthorized"}',True), (302,b'{}',False),
                             (200,b'{}',False), (401,b'x'*1025,False), (401,b'bad-json',False)]:
    response = Response()
    response.status, response.body = status, body
    try: bridge_ns['bridge_refusal'](57914)
    except (ValueError, json.JSONDecodeError): assert not passes
    else: assert passes
assert requests == [('GET','/_internal/opencode/tools',{'Accept':'application/json'})]*5

class StalledResponse(Response):
    def read(self, limit): signal.pause()
response = StalledResponse()
try: bridge_ns['bridge_refusal'](57914)
except ValueError as error: assert 'timed out' in str(error)
else: raise AssertionError('stalled bridge observation did not time out')
assert signal.getitimer(signal.ITIMER_REAL) == (0.0,0.0)

print(f'PASS: {len(suite["logs"])} checker fixture cases + 8 kernel-parser + 6 collector + 6 bridge cases; no live trial')
