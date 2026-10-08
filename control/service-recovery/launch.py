"""Validate an owned deployment, then exec its existing single-owner entry point."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


def regular(name):
    path = Path(name)
    info = path.lstat()
    if not path.is_absolute() or path.resolve() != path or not stat.S_ISREG(info.st_mode):
        raise ValueError('Expected canonical regular file: ' + name)
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('File owner or write permissions differ: ' + name)
    return path


def stage2_release_on_disk(home):
    """True only when the daemon about to start will load the Stage 2 guard: active.json's guard and every
    module and file it pins hash as recorded, and that guard is one that keeps the human-input log."""
    try:
        active = json.loads(regular(str(home / 'admission' / 'active.json')).read_bytes())
        guard = regular(active['guard']['path']).read_bytes()
        if hashlib.sha256(guard).hexdigest() != active['guard']['sha256'] or b"/admission/human'" not in guard:
            return False
        pinned = {os.path.normpath(active['base'] + name): digest for name, digest in active['after'].items()}
        pinned.update(active.get('files', {}))
        return all(hashlib.sha256(regular(name).read_bytes()).hexdigest() == digest for name, digest in pinned.items())
    except (OSError, ValueError, KeyError, TypeError):
        return False


def disarm_human_chain(home):
    """STAGE2 review F1. A daemon that will not run the Stage 2 guard cannot disarm its predecessor's marker,
    so the next Stage 2 boot would chain straight over it. The launcher does it instead, before exec, so the
    sweep declines every seat whose evidence would cross this start. Deletes markers only, never logs."""
    directory = home / 'admission' / 'human'
    if not directory.is_dir():
        return []
    names = sorted(n for n in os.listdir(directory) if n.startswith('armed-'))
    for name in names:
        os.unlink(directory / name)
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return names


def guard_human_chain(profile, role):
    """Paseo role only, and only when the profile names the controller home (orcaHumanLog.home)."""
    if role != 'paseo' or 'orcaHumanLog' not in profile:
        return None
    home = Path(profile['orcaHumanLog']['home'])
    if not home.is_absolute() or home.resolve() != home or not home.is_dir():
        raise ValueError('orcaHumanLog.home must be a canonical directory')
    return None if stage2_release_on_disk(home) else disarm_human_chain(home)


def validate(profile_path, expected, role):
    raw = regular(profile_path).read_bytes()
    if len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('Deployment profile changed')
    data = json.loads(raw)
    if data.get('version') != 1 or role not in ('controller', 'paseo'):
        raise ValueError('Unsupported deployment or role')
    profile = data['roles'][role]
    for name in profile['required']:
        regular(name)
    for name, digest in profile['pins'].items():
        if hashlib.sha256(regular(name).read_bytes()).hexdigest() != digest:
            raise ValueError('Pinned file changed: ' + name)
    cwd = Path(profile['cwd'])
    if not cwd.is_absolute() or cwd.resolve() != cwd or not cwd.is_dir():
        raise ValueError('Required working directory unavailable')
    argv = profile['argv']
    if not isinstance(argv, list) or len(argv) < 2 or any(not isinstance(x, str) for x in argv):
        raise ValueError('Invalid executable arguments')
    if not Path(argv[0]).is_absolute() or argv[1] not in profile['pins']:
        raise ValueError('Entry point must be pinned')
    if not os.access(argv[0], os.X_OK):
        raise ValueError('Required executable unavailable')
    allowed = {'PATH', 'PASEO_HOME', 'PASEO_LISTEN'}
    # The SSH Book transport is retired (0.2.7) and nothing reads this variable. It stays accepted so that an
    # existing launch profile that still sets it keeps starting the controller.
    if role == 'controller': allowed.add('ORCA_BOOK_TRANSPORT_PROFILE')
    # C1 (J0 item 2): where the controller home, the daemon installation, outcomes and tasks live. Both roles; each
    # value only as an absolute canonical path (no relative, "..", trailing or symlinked components).
    installation = ('ORCA_CONTROLLER_HOME', 'ORCA_DAEMON_INSTALLATION', 'ORCA_OUTCOMES_DIR', 'ORCA_TASKS_DIR')
    allowed.update(installation)
    for name in installation:
        value = profile['env'].get(name)
        if value is not None and (not isinstance(value, str) or not Path(value).is_absolute()
                                  or str(Path(value).resolve()) != value):
            raise ValueError('Installation path must be absolute and canonical: ' + name)
    transport = profile['env'].get('ORCA_BOOK_TRANSPORT_PROFILE')
    if transport is not None and transport not in profile['pins']:
        raise ValueError('Book transport profile must be pinned')
    if set(profile['env']) - allowed:
        raise ValueError('Unsupported environment override')
    return profile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('profile')
    parser.add_argument('sha256')
    parser.add_argument('role')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        profile = validate(args.profile, args.sha256, args.role)
        if args.check:
            print(json.dumps({'valid': True, 'role': args.role}))
            return
        # Before exec, so a start that will not run the Stage 2 guard has broken the chain before it can accept
        # any input. A failure to disarm refuses the start, like every other failed check here.
        disarmed = guard_human_chain(profile, args.role)
        if disarmed:
            print(json.dumps({'service': args.role, 'status': 'human-input-chain-disarmed', 'markers': len(disarmed)}), file=sys.stderr)
        os.chdir(profile['cwd'])
        env = {k: v for k, v in os.environ.items() if k not in ('NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME')}
        env.update(profile['env'])
        # Native process.py / Paseo supervisor own the lock and recovery semantics.
        os.execve(profile['argv'][0], profile['argv'], env)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'service': args.role, 'status': 'startup-refused', 'error': str(error)}), file=sys.stderr)
        sys.exit(78)


if __name__ == '__main__':
    main()
