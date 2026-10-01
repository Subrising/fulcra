import atexit, copy, json, os, pathlib, plistlib, shutil, subprocess, tempfile
repo = pathlib.Path(__file__).resolve().parent.parent
root = pathlib.Path(tempfile.mkdtemp(prefix='v5-check-')).resolve()
atexit.register(lambda: shutil.rmtree(root))
home = root / 'fake-home'
if home.exists(): shutil.rmtree(home)
home.mkdir(mode=0o700)
(home/'Applications').mkdir()
app = home/'Applications/Fulcra.app'
state = home/'state'
state.mkdir(mode=0o700)
script = repo/'docs/v5/v5-check.sh'
scanner = repo/'tools/v5-exact-audit.mjs'
reviews = home/'reviews.json'
reviews.write_text('[]')
obs = dict(uid=os.getuid(), home=str(home), launch={'files':{},'labels':['system.fixture']})
snapshot = root/'observations.json'
snapshot.write_text(json.dumps(obs))
common = ['sh',str(script),'--app',str(app),'--paseo-home',str(state),'--port','16767',
          '--protected-home',str(root/'protected-home'),'--fixture',str(snapshot)]
logs=[]
def run(name, extra, expected, check=None):
    report=home/(name+'.json')
    proc=subprocess.run(common+extra+['--report',str(report)],capture_output=True,text=True)
    logs.append(f'CASE {name} expected_exit={expected} actual_exit={proc.returncode}\n'+proc.stdout+proc.stderr)
    assert proc.returncode==expected, logs[-1]
    if not report.exists():
        assert expected == 1 and 'FAIL isolation-inputs:' in proc.stdout
        return None
    data=json.loads(report.read_text())
    assert report.stat().st_mode & 0o777 == 0o600
    if check: assert any(c['check']==check and c['status']=='FAIL' for c in data['checks']), logs[-1]
    return data
run('baseline',['--capture-baseline'],0)
(app/'Contents/MacOS').mkdir(parents=True)
exe=app/'Contents/MacOS/Fulcra'
exe.write_text('fixture executable\n'); exe.chmod(0o700)
(app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'Fulcra'}))
controller=app/'Contents/controller.mjs'; controller.write_text('// fixture controller\n')
cc=state/'command-centre'; cc.mkdir(mode=0o700)
config=cc/'config.json'; config.write_text('{}'); config.chmod(0o600)
obs.update(processes=[dict(pid=1001,ppid=1,uid=os.getuid(),command=str(exe)),
                      dict(pid=1002,ppid=1001,uid=os.getuid(),command='node '+str(controller))],
           daemon_environment='PASEO_HOME='+str(state)+' TEST=1',
           listeners='n127.0.0.1:16767\n',open_files='p1001\nn'+str(config)+'\n')
extra=['--baseline',str(home/'baseline.json'),'--daemon-pid','1001','--controller-pid','1002',
       '--daemon-entry','Contents/MacOS/Fulcra','--controller-entry','Contents/controller.mjs',
       '--scanner',str(scanner),'--scan-reviews',str(reviews)]
def write(o): snapshot.write_text(json.dumps(o))
write(obs); run('passing',extra,0)
cases=[('wrong-user','isolation-inputs',lambda o:o.update(uid=0)),
       ('daemon-entry-suffix','daemon',lambda o:o['processes'][0].update(command=str(exe)+'.old')),
       ('daemon-owner','daemon',lambda o:o['processes'][0].update(uid=999999)),
       ('daemon-home','daemon',lambda o:o.update(daemon_environment='PASEO_HOME=/wrong TEST=1')),
       ('daemon-port','daemon',lambda o:o.update(listeners='n127.0.0.1:6767\n')),
       ('daemon-wildcard','daemon',lambda o:o.update(listeners='n*:16767\n')),
       ('child-parent','controller-child',lambda o:o['processes'][1].update(ppid=9000)),
       ('child-owner','controller-child',lambda o:o['processes'][1].update(uid=999999)),
       ('protected-path','open-paths-and-ports',lambda o:o.update(open_files='n'+str(root/'protected-home/private-file')+'\n')),
       ('protected-port','open-paths-and-ports',lambda o:o.update(open_files='n127.0.0.1:50000->127.0.0.1:6791\n')),
       ('launch-added','no-launchd-additions',lambda o:o['launch']['labels'].append('unexpected.agent'))]
for name,check,mutate in cases:
    altered=copy.deepcopy(obs); mutate(altered); write(altered); run(name,extra,1,check)
write(obs)
exe.chmod(0o600); run('bad-bundle',extra,1,'app-bundle'); exe.chmod(0o700)
config.chmod(0o644); run('bad-state-mode',extra,1,'state-modes'); config.chmod(0o600)
tie=app/'Contents/machine.txt'; tie.write_text('/'+'Users/'+'fixture-person/home'); run('machine-tie',extra,1,'whole-bundle-machine-ties'); tie.unlink()
tie.symlink_to(controller); run('confined-bundle-symlink',extra,0); tie.unlink()
tie.symlink_to(config); run('escaping-bundle-symlink',extra,1,'whole-bundle-machine-ties'); tie.unlink()
snapshot.write_text('{'); run('unreadable-observation',extra,1,'isolation-inputs'); write(obs)
# A rejected output path must not create a file, including on an isolation failure.
unsafe = root/'must-not-be-created.json'
proc=subprocess.run(common+extra+['--report',str(unsafe)],capture_output=True,text=True)
assert proc.returncode==1 and not unsafe.exists()
logs.append('CASE unsafe-report rejected without write\n'+proc.stdout)
# A plist cannot designate an executable outside Contents/MacOS.
info=app/'Contents/Info.plist'
original=info.read_bytes()
info.write_bytes(plistlib.dumps({'CFBundleExecutable':'../controller.mjs'}))
run('executable-traversal',extra,1,'app-bundle'); info.write_bytes(original)
# Re-running cannot overwrite evidence.
proc=subprocess.run(common+extra+['--report',str(home/'passing.json')],capture_output=True,text=True)
assert proc.returncode==1 and 'FAIL report:' in proc.stdout
logs.append('CASE refuse-overwrite actual_exit=1\n'+proc.stdout)
(root/'fixture-runs.txt').write_text('\n'.join(logs))
print('PASS: '+str(len(logs))+' fixture cases; no live observation commands invoked')
