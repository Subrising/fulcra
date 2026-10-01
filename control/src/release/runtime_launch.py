"""Verify the complete immutable runtime inventory before the existing service launcher."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def owned(path, directory=False, system=False):
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not path.is_absolute() or path.resolve() != path or not expected(info.st_mode):
        raise ValueError('Canonical regular artifact required')
    if info.st_uid not in ({os.getuid(), 0} if system else {os.getuid()}) or info.st_mode & 0o022:
        raise ValueError('Artifact owner or write permissions changed')


def inventory(root):
    owned(root, directory=True)
    files, links, directories = {}, {}, []
    for base, dirs, names in os.walk(root, followlinks=False):
        for name in sorted(dirs + names):
            p = Path(base) / name
            relative = str(p.relative_to(root))
            info = p.lstat()
            if info.st_uid != os.getuid():
                raise ValueError('Foreign artifact owner')
            if stat.S_ISLNK(info.st_mode):
                target = p.resolve(strict=True)
                if not target.is_relative_to(root):
                    raise ValueError('External runtime symlink')
                links[relative] = os.readlink(p)
            elif stat.S_ISDIR(info.st_mode):
                owned(p, directory=True)
                directories.append(relative)
            elif stat.S_ISREG(info.st_mode):
                owned(p)
                if info.st_nlink != 1:
                    raise ValueError('Aliased runtime file')
                files[relative] = digest(p)
            else:
                raise ValueError('Special runtime file')
    return {'files': files, 'links': links, 'directories': sorted(directories)}


def validate(manifest, expected, role):
    owned(manifest)
    if manifest.stat().st_size > 16777216 or digest(manifest) != expected:
        raise ValueError('Runtime manifest changed')
    data = json.loads(manifest.read_text())
    if data.get('version') != 1 or role not in ('paseo', 'controller'):
        raise ValueError('Unknown runtime manifest or service')
    roots = data['roots']
    if not isinstance(roots, dict) or not 1 <= len(roots) <= 4:
        raise ValueError('Bounded artifact roots required')
    for name, recorded in roots.items():
        if inventory(Path(name)) != recorded:
            raise ValueError('Runtime inventory changed')
    for name, pin in data['externalPins'].items():
        resolved = Path(name).resolve(strict=True)
        if str(resolved) != pin['resolved']:
            raise ValueError('External release target changed')
        owned(resolved, system=True)
        if digest(resolved) != pin['sha256']:
            raise ValueError('External release pin changed')
    argv = data['roles'][role]
    if not isinstance(argv, list) or len(argv) != 5 or not all(isinstance(x, str) for x in argv):
        raise ValueError('Expected existing service launcher arguments')
    if argv[4] != role or argv[0] not in data['externalPins'] or not os.access(argv[0], os.X_OK):
        raise ValueError('Pinned executable and matching role required')
    for arg in argv[1:3]:
        if not any(Path(arg).is_relative_to(Path(root)) and str(Path(arg).relative_to(root)) in record['files'] for root, record in roots.items()):
            raise ValueError('Launcher and profile must belong to verified inventory')
    if digest(Path(argv[2])) != argv[3]:
        raise ValueError('Service profile hash mismatch')
    return argv


def main(args):
    if len(args) not in (3, 4) or (len(args) == 4 and args[3] != '--check'):
        raise ValueError('Expected manifest, hash, role and optional --check')
    start = time.monotonic()
    argv = validate(Path(args[0]), args[1], args[2])
    print(json.dumps({'runtimeVerified': True, 'role': args[2], 'validationMs': round((time.monotonic() - start) * 1000)}), flush=True)
    if len(args) == 3:
        env = {k: v for k, v in os.environ.items() if k not in ('NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME')}
        os.execve(argv[0], argv, env)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, KeyError, TypeError, RuntimeError):
        print(json.dumps({'runtimeVerified': False, 'error': 'Pinned runtime validation failed'}), file=sys.stderr)
        sys.exit(78)
