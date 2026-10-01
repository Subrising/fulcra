"""Install only the new owner health monitor; preserve existing service ownership."""
import hashlib
import json
import os
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

root = Path(__file__).resolve().parent.parent
base = Path(local_machine("healthInstallHome"))
base.mkdir(exist_ok=True, mode=0o700)
state = base / 'state'
state.mkdir(exist_ok=True, mode=0o700)
profile_path = Path(local_machine("healthLaunchAgent"))
target = f'gui/{os.getuid()}/ai.orca.health'
assert not profile_path.exists() and subprocess.run(['launchctl', 'print', target], capture_output=True).returncode != 0, 'Existing health monitor must not be replaced implicitly'
source = root / 'orca-operations/health.py'
digest = hashlib.sha256(source.read_bytes()).hexdigest()
release = base / digest[:16]
release.mkdir(exist_ok=False, mode=0o700)
shutil.copyfile(source, release / 'health.py')
(release / 'health.py').chmod(0o400)
config_path = Path(local_machine("openclawConfig"))
config_before = config_path.read_bytes()
route = json.loads(config_before)['plugins']['entries']['orca-command']['config']
config = {'version': 1, 'queue': local_machine("conversationQueue"), 'stateDir': str(state), 'accountId': route['accountId'], 'conversationId': route['conversationId']}
raw = json.dumps(config, sort_keys=True).encode()
(release / 'config.json').write_bytes(raw)
(release / 'config.json').chmod(0o400)
config_sha = hashlib.sha256(raw).hexdigest()
node_root = Path((root / 'runtime/node-root.txt').read_text().strip())
assert node_root == Path(local_machine("nodeRoot"))
assert subprocess.check_output([node_root / 'bin/node', '--version'], text=True).strip() == 'v24.20.0'
args = ['/opt/homebrew/bin/python3', str(release / 'health.py'), str(release / 'config.json'), config_sha]
preflight = subprocess.run(args + ['--probe'], capture_output=True, text=True, timeout=10, check=True)
assert json.loads(preflight.stdout)['healthy'], 'Install only from a known healthy watcher state'
profile = {'Label': 'ai.orca.health', 'ProgramArguments': args, 'StartInterval': 30, 'RunAtLoad': True, 'ProcessType': 'Background', 'Umask': 63, 'WorkingDirectory': str(base), 'EnvironmentVariables': {'PATH': str(node_root / 'bin') + ':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'}, 'StandardOutPath': local_machine("healthLog"), 'StandardErrorPath': local_machine("healthErrorLog")}
with profile_path.open('xb') as file: file.write(plistlib.dumps(profile))
profile_path.chmod(0o600)
try:
    subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(profile_path)], check=True, timeout=20)
    assert config_path.read_bytes() == config_before
except BaseException:
    subprocess.run(['launchctl', 'bootout', target], capture_output=True)
    profile_path.unlink()
    raise
receipt = {'release': str(release), 'sourceSha256': digest, 'configSha256': config_sha, 'profileSha256': hashlib.sha256(profile_path.read_bytes()).hexdigest(), 'profile': str(profile_path), 'nodeRoot': str(node_root)}
(root / 'runtime/health-installed.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt))
