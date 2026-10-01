"""Run the single owned controller under a process-lifetime advisory lock."""
import os, fcntl, stat, socket, json
from pathlib import Path

# Machine-specific legacy deployment inputs live outside the tracked tree.
def local_machine(key):
    config = Path(__file__).resolve().parents[3] / 'local' / 'machine-values.json'
    if not config.is_file():
        raise ValueError('Populate local/machine-values.json before running this legacy deployment tool')
    value = json.loads(config.read_text()).get(key)
    if not isinstance(value, str) or not value.startswith('/'):
        raise ValueError('Missing canonical local machine path: ' + key)
    return value
home = Path(os.environ['ORCA_HOME']) / 'controller' if 'ORCA_HOME' in os.environ else Path(local_machine("legacyControllerHome"))
home.mkdir(parents=True, exist_ok=True, mode=0o700)
if home.resolve() != home: raise RuntimeError('Control home contains symlink')
os.chmod(home, 0o700)
lock = home / 'process.lock'
fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
if not stat.S_ISREG(os.fstat(fd).st_mode): raise RuntimeError('Regular process lock required')
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
endpoint = home / 'control.sock'
try:
    before = endpoint.lstat()
    if not stat.S_ISSOCK(before.st_mode): raise RuntimeError('Unexpected socket path')
    probe = socket.socket(socket.AF_UNIX); probe.settimeout(1)
    try:
        probe.connect(str(endpoint))
        raise RuntimeError('Existing controller is listening')
    except ConnectionRefusedError:
        after = endpoint.lstat()
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino): raise RuntimeError('Socket changed during recovery')
        endpoint.unlink()
    finally: probe.close()
except FileNotFoundError: pass
os.set_inheritable(fd, True)
os.environ['ORCA_PROCESS_LOCK_FD'] = str(fd)
node = os.environ.get('ORCA_NODE', '/opt/homebrew/opt/node@24/bin/node')
os.execv(node, [node, str(Path(__file__).with_name('server.mjs'))])
