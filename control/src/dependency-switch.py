"""Stopped, recoverable dependency-directory switch. Never starts or kills a process."""
import contextlib, fcntl, hashlib, json, os, re, stat, subprocess, uuid
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

ROOT = Path(local_machine("legacyProductRoot"))
# Host process titles: Paseo releases up to H2 and Fulcra-titled releases after the rename both count as owned host.
HOST_TITLES = ['Paseo Daemon', 'Paseo Supervisor', 'Fulcra Daemon', 'Fulcra Supervisor']
SIDES_FILE = Path(__file__).resolve().parents[2] / 'local' / 'dependency-sides.json'
SIDES = json.loads(SIDES_FILE.read_text()) if SIDES_FILE.is_file() else {}

def sha(data): return hashlib.sha256(data).hexdigest()
def regular(p):
    p = Path(p)
    if p.resolve(strict=True) != p: raise ValueError('symlink path refused')
    with os.fdopen(os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise ValueError('regular file required')
        return f.read()
def identity(p):
    p = Path(p)
    if p.resolve(strict=True) != p or not p.is_dir(): raise ValueError('real directory required')
    s = p.stat(); return {'dev': s.st_dev, 'ino': s.st_ino}
def sync(p):
    fd = os.open(p, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
def atomic(p, data, mode=0o600):
    temporary = p.parent / ('.dependency-' + str(uuid.uuid4()))
    with temporary.open('xb') as f:
        os.chmod(temporary, mode); f.write(data); f.flush(); os.fsync(f.fileno())
    os.replace(temporary, p); sync(p.parent)
def inventory(root):
    root = Path(root); identity(root); result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            p = Path(directory) / name; info = p.lstat(); value = {'mode': stat.S_IMODE(info.st_mode)}
            if p.is_symlink():
                if not p.resolve(strict=True).is_relative_to(root): raise ValueError('escaping tree symlink')
                value['link'] = os.readlink(p)
            elif p.is_dir(): value['directory'] = True
            elif p.is_file(): value['sha256'] = sha(regular(p))
            else: raise ValueError('unexpected tree entry')
            result[str(p.relative_to(root))] = value
    return result

def fingerprint(root): return sha(json.dumps(inventory(root), sort_keys=True).encode())

def processes():
    raw = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,lstart=,command='], text=True)
    result = {}
    for line in raw.splitlines():
        fields = line.split(None, 7)
        if len(fields) == 8:
            pid, parent = map(int, fields[:2]); result[pid] = {'pid': pid, 'parent': parent, 'started': ' '.join(fields[2:7]), 'commandHash': sha(fields[7].strip().encode()), 'command': fields[7].strip()}
    return result

def capture(owners):
    rows = processes(); selected = set(owners)
    if not selected or not selected.issubset(rows): raise ValueError('owner process missing')
    while True:
        expanded = selected | {pid for pid, row in rows.items() if row['parent'] in selected}
        if expanded == selected: break
        selected = expanded
    return [{k: v for k, v in rows[pid].items() if k != 'command'} for pid in sorted(selected)]

def required_watched(root):
    root = Path(root)
    paths = [root / name for name in ['node_modules', 'home', 'tasks']]
    if root == ROOT:
        paths += [Path(local_machine("watchedControlReleases")), Path(local_machine("legacyControllerHome")), Path(local_machine("watchedEvents")), Path(local_machine("watchedControllerSource"))]
    return sorted(str(p) for p in paths)

def validate_watched(root, watched):
    if not isinstance(watched, list) or any(not isinstance(p, str) or not Path(p).is_absolute() or str(Path(p).resolve()) != p for p in watched) or not set(required_watched(root)).issubset(watched): raise ValueError('required canonical owned watch paths missing')

def assert_stopped(captured, watched):
    rows = processes(); active = []
    for old in captured:
        now = rows.get(old['pid'])
        if now and now['started'] == old['started']: active.append(old['pid'])
    if str(ROOT / 'home') in watched:
        active += [pid for pid, row in rows.items() if row['command'] in HOST_TITLES]
        listening = subprocess.run(['/usr/sbin/lsof', '-nP', '-iTCP:6791', '-sTCP:LISTEN', '-Fp'], capture_output=True, text=True, timeout=10)
        if listening.returncode not in (0, 1) or listening.stderr.strip(): raise ValueError('listener scan incomplete')
        active += [int(line[1:]) for line in listening.stdout.splitlines() if line.startswith('p')]
    # Include new/reparented consumers, even if they were absent from the original tree.
    for pid, row in rows.items():
        if pid != os.getpid() and any(p in row['command'] for p in watched): active.append(pid)
    result = subprocess.run(['/usr/sbin/lsof', '-nP', '-Fpn'], capture_output=True, text=True, timeout=30)
    if result.returncode not in (0, 1) or result.stderr.strip(): raise ValueError('process open-file scan incomplete: ' + result.stderr[:200])
    pid = None
    for line in result.stdout.splitlines():
        if line.startswith('p'): pid = int(line[1:])
        if line.startswith('n') and pid != os.getpid() and any(line[1:] == p or line[1:].startswith(p + '/') for p in watched): active.append(pid)
    if active: raise ValueError('owned dependency consumers remain: ' + str(sorted(set(active))))

class Switch:
    def __init__(self, root, sides=SIDES):
        self.root, self.sides = Path(root), sides
        identity(self.root)
    @contextlib.contextmanager
    def locked(self):
        fd = os.open(self.root / '.dependency-switch.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError('regular lock required')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); yield
        finally: os.close(fd)
    def save(self, record):
        encoded = json.dumps(record).encode()
        if len(encoded) > 8192: raise ValueError('operation record exceeds the launcher 8192-byte limit')
        atomic(self.root / 'dependency-operation.json', encoded)
    def load(self):
        record = json.loads(regular(self.root / 'dependency-operation.json'))
        if record.get('schema') != 1 or str(uuid.UUID(record['id'])) != record['id'] or record.get('phase') not in ['ready', 'switching', 'complete']: raise ValueError('invalid operation')
        validate_watched(self.root, record.get('watched'))
        if not isinstance(record.get('captured'), list) or not record['captured'] or any(not isinstance(p.get('pid'), int) or p['pid'] <= 1 or not isinstance(p.get('started'), str) or not p['started'] for p in record['captured']): raise ValueError('invalid captured process identities')
        for side in self.sides:
            if any(record[side].get(k) != v for k, v in self.sides[side].items()): raise ValueError('operation binding changed')
            directory = self.directory(record, side); self.metadata(directory, side)
            modes = record[side].get('metadataModes', {})
            if set(modes) != {'package', 'lock'} or any(mode not in [0o600, 0o644] for mode in modes.values()): raise ValueError('invalid metadata modes')
        return record
    def directory(self, record, side):
        p = self.root / ('dependency-' + ('original' if side == 'before' else 'prepared') + '-' + record['id'])
        identity(p); return p
    def metadata(self, directory, side):
        values = {key: regular(directory / name) for key, name in [('package', 'package.json'), ('lock', 'package-lock.json')]}
        if any(sha(data) != self.sides[side][key] for key, data in values.items()): raise ValueError('unrecognized metadata')
        return values
    def initialize(self, operation_id, captured, watched):
        if os.path.lexists(self.root / 'dependency-operation.json'): raise ValueError('operation already exists')
        if str(uuid.UUID(operation_id)) != operation_id: raise ValueError('invalid operation id')
        validate_watched(self.root, watched)
        if not isinstance(captured, list) or not captured or any(not isinstance(p.get('pid'), int) or p['pid'] <= 1 or not isinstance(p.get('started'), str) or not p['started'] for p in captured): raise ValueError('invalid captured process identities')
        record = {'schema': 1, 'id': operation_id, 'phase': 'ready', 'captured': [{'pid': p['pid'], 'started': p['started']} for p in captured], 'watched': watched}
        self.metadata(self.root, 'before')
        for side in self.sides:
            directory = self.directory(record, side); self.metadata(directory, side)
            tree = self.root / 'node_modules' if side == 'before' else directory / 'node_modules'
            record[side] = {**self.sides[side], 'identity': identity(tree), 'treeDigest': fingerprint(tree), 'metadataModes': {key: stat.S_IMODE((directory / name).stat().st_mode) for key, name in [('package', 'package.json'), ('lock', 'package-lock.json')]}}
        preparation = json.loads(regular(self.directory(record, 'after') / 'preparation.json'))
        if preparation.get('id') != operation_id or any(preparation.get(side + 'Digest') != record[side]['treeDigest'] for side in self.sides): raise ValueError('prepared release changed')
        if not captured or not watched: raise ValueError('owned process snapshot and watched paths required')
        self.save(record); return record
    def move(self, target, stopped=assert_stopped, checkpoint=lambda name: None):
        if target not in self.sides: raise ValueError('unknown target')
        record = self.load(); live = self.root / 'node_modules'
        if record.get('nativeOverlay'): raise ValueError('Roll back the native permission overlay before switching dependency sides')
        locations = [live] + [self.directory(record, s) / 'node_modules' for s in self.sides]
        known = {}; destinations = {s: self.directory(record, s) / 'node_modules' for s in self.sides}
        for p in locations:
            if p.exists() or p.is_symlink():
                actual = identity(p); side = next((s for s in self.sides if record[s]['identity'] == actual), None)
                if side is None or side in known: raise ValueError('unknown or duplicate tree identity')
                known[side] = p
        if set(known) != set(self.sides): raise ValueError('recorded dependency tree missing')
        for side, location in known.items():
            if fingerprint(location) != record[side].get('treeDigest'): raise ValueError('recorded tree contents changed')
        # Neither a crash nor recovery authorizes overwriting unknown root metadata.
        for key, name in [('package', 'package.json'), ('lock', 'package-lock.json')]:
            if sha(regular(self.root / name)) not in [v[key] for v in self.sides.values()]: raise ValueError('unrecognized installed metadata')
        metadata = self.metadata(self.directory(record, target), target)
        stopped(record['captured'], record['watched'])
        record['phase'] = 'switching'; self.save(record); checkpoint('intent')
        if known[target] != live:
            other = next(s for s in self.sides if s != target)
            if known[other] == live:
                stopped(record['captured'], record['watched']); os.rename(live, destinations[other]); sync(destinations[other].parent); sync(self.root); checkpoint('park')
            stopped(record['captured'], record['watched']); os.rename(known[target], live); sync(known[target].parent); sync(self.root); checkpoint('activate')
        for key, name in [('package', 'package.json'), ('lock', 'package-lock.json')]:
            mode = record[target]['metadataModes'][key]
            if mode not in [0o600, 0o644] or stat.S_IMODE((self.directory(record, target) / name).stat().st_mode) != mode: raise ValueError('metadata mode changed')
            stopped(record['captured'], record['watched']); atomic(self.root / name, metadata[key], mode); checkpoint(key)
        if identity(live) != record[target]['identity']: raise ValueError('tree changed during switch')
        self.metadata(self.root, target); record['phase'] = 'complete'; self.save(record); checkpoint('complete')
        return record

if __name__ == '__main__':
    import sys
    if len(sys.argv) != 2 or sys.argv[1] not in ['before', 'after']: raise SystemExit('Use dependency-switch.py before|after after preparing and capturing owned processes')
    operation = Switch(ROOT)
    with operation.locked(): operation.move(sys.argv[1])
    print(json.dumps({'side': sys.argv[1], 'phase': 'complete'}))
