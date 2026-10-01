"""Install only the Orca conversation release and newly owned watcher service."""
import hashlib
import json
import os
import re
from pathlib import Path

# Machine-specific legacy deployment inputs live outside the tracked tree.
def local_machine(key):
    config = Path(__file__).resolve().parents[2] / 'local' / 'machine-values.json'
    if not config.is_file():
        raise ValueError('Populate local/machine-values.json before running this legacy deployment tool')
    value = json.loads(config.read_text()).get(key)
    if not isinstance(value, str) or not value.startswith('/'):
        raise ValueError('Missing canonical local machine path: ' + key)
    return value
import plistlib
import shutil
import subprocess
import time

root = Path(__file__).resolve().parent.parent
base = Path(local_machine("conversationInstallHome"))
previous = (base / 'current').resolve(strict=True)
old = json.loads((previous / 'manifest.json').read_text())
skill = Path(local_machine("conversationSkill"))
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(skill) == old['files']['orca-conversation/SKILL.md'], 'Installed skill diverged'
for name, digest in old['files'].items():
    assert sha(previous / name) == digest, 'Previous immutable release diverged'
plist = Path(local_machine("watchLaunchAgent"))
prior_profile = plist.read_bytes() if plist.exists() else None
prior_receipt = root / 'runtime/installed.json'
if prior_profile:
    prior = json.loads(prior_receipt.read_text())
    assert prior['release'] == str(previous) and prior['plistSha256'] == sha(plist), 'Watcher ownership diverged'
target = f'gui/{os.getuid()}/ai.orca.watch'

def service_pid():
    shown = subprocess.run(['launchctl', 'print', target], text=True, capture_output=True)
    match = re.search(r'^\s*pid = (\d+)$', shown.stdout, re.MULTILINE)
    return int(match[1]) if match else None

def unload():
    pid = service_pid()
    stopped = subprocess.run(['launchctl', 'bootout', target], capture_output=True)
    if stopped.returncode and pid:
        raise RuntimeError('Owned service did not unload')
    for _ in range(50):
        try:
            if pid:
                os.kill(pid, 0)
            else:
                break
        except ProcessLookupError:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Owned service process still exiting; do not bootstrap over it')
if not prior_profile:
    assert subprocess.run(['launchctl', 'print', target], capture_output=True).returncode != 0, 'Existing watcher service'
names = sorted(set(old['files']) | {'orca-conversation/group.mjs', 'orca-conversation/hosts.mjs', 'orca-conversation/queue.mjs', 'orca-conversation/service.mjs', 'orca-conversation/install.py', 'orca-conversation/gateway-wake.mjs'})
files = {name: sha(root / name) for name in names}
digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
release = Path(local_machine("conversationReleaseRoot")) / digest[:16]
release.mkdir(exist_ok=False)
for name in names:
    dest = release / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / name, dest)
    dest.chmod(0o444)
(release / 'manifest.json').write_text(json.dumps({'sha256': digest, 'files': files}, indent=2))
(release / 'manifest.json').chmod(0o444)
for directory in sorted((p for p in release.rglob('*') if p.is_dir()), reverse=True):
    directory.chmod(0o555)
release.chmod(0o555)
config = Path(local_machine("openclawConfig"))
config_hash = sha(config)
# OpenClaw stages SQLite snapshots: use David's existing external cache/temp volume.
for directory in [local_machine("openclawCache"), local_machine("openclawTmp")]:
    assert Path(directory).is_dir() and os.access(directory, os.W_OK), 'Writable external OpenClaw staging directory required'
profile = {'Label': 'ai.orca.watch', 'ProgramArguments': [local_machine("nodeExecutable"), str(release / 'orca-conversation/service.mjs')], 'EnvironmentVariables': {'XDG_CACHE_HOME': local_machine("openclawCache"), 'TMPDIR': local_machine("openclawTmp"), 'PATH': local_machine("watchPath")}, 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30, 'ExitTimeOut': 45, 'ProcessType': 'Background', 'Umask': 63, 'WorkingDirectory': str(release), 'StandardOutPath': local_machine("watchLog"), 'StandardErrorPath': local_machine("watchErrorLog")}
try:
    if prior_profile:
        assert plist.read_bytes() == prior_profile
        unload()
    temp = plist.with_suffix('.next')
    with temp.open('xb') as stream:
        stream.write(plistlib.dumps(profile))
    temp.chmod(0o600)
    os.replace(temp, plist)
    subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], check=True, timeout=20)
    for _ in range(10):
        result = subprocess.run([local_machine("nodeExecutable"), str(release / 'orca-conversation/client.mjs')], input='{"action":"watches"}', text=True, capture_output=True, check=True, timeout=10)
        health = json.loads(result.stdout)
        if health['service']['recentlySeen'] and health['service']['pid'] == service_pid():
            break
        time.sleep(1)
    else:
        raise RuntimeError('No watcher service heartbeat')
    assert (base / 'current').resolve() == previous and sha(skill) == old['files']['orca-conversation/SKILL.md']
    os.symlink(release, base / 'next')
    os.replace(base / 'next', base / 'current')
    shutil.copyfile(release / 'orca-conversation/SKILL.md', skill)
    assert sha(config) == config_hash, 'Gateway config changed concurrently'
except BaseException:
    unload()
    if (base / 'current').resolve() == release:
        os.symlink(previous, base / 'rollback')
        os.replace(base / 'rollback', base / 'current')
        shutil.copyfile(previous / 'orca-conversation/SKILL.md', skill)
    if plist.exists() and plist.read_bytes() == plistlib.dumps(profile):
        plist.unlink()
    if prior_profile and not plist.exists():
        plist.write_bytes(prior_profile)
        plist.chmod(0o600)
        subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], capture_output=True, timeout=20)
    raise
receipt = {'release': str(release), 'previous': str(previous), 'sha256': digest, 'files': files, 'plist': str(plist), 'plistSha256': sha(plist), 'gatewayConfigSha256': config_hash, 'service': health['service']}
if prior_receipt.exists():
    (root / ('runtime/installed-' + previous.name + '.json')).write_bytes(prior_receipt.read_bytes())
prior_receipt.write_text(json.dumps(receipt, indent=2))
print(json.dumps({k: receipt[k] for k in ['release', 'sha256', 'service', 'gatewayConfigSha256']}))
