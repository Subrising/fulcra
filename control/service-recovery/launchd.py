"""Render two user LaunchAgents; installation and ownership transfer are explicit."""
import argparse
import hashlib
from pathlib import Path
import plistlib


def configuration(role, release, logs):
    if role not in ('controller', 'paseo'):
        raise ValueError('Unknown service')
    release, logs = Path(release).resolve(), Path(logs).resolve()
    profile = release / 'profiles.json'
    return {
        'Label': 'ai.orca.' + role,
        'ProgramArguments': ['/opt/homebrew/bin/python3', str(release / 'launch.py'),
                             str(profile), hashlib.sha256(profile.read_bytes()).hexdigest(), role],
        'WorkingDirectory': str(release),
        'RunAtLoad': True,
        'KeepAlive': True,
        'ThrottleInterval': 30,
        'ExitTimeOut': 30,
        'ProcessType': 'Background',
        'Umask': 0o077,
        'StandardOutPath': str(logs / (role + '.log')),
        'StandardErrorPath': str(logs / (role + '-error.log')),
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('release')
    parser.add_argument('logs')
    parser.add_argument('output')
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    for role in ('controller', 'paseo'):
        target = output / ('ai.orca.' + role + '.plist')
        with target.open('xb') as stream:
            plistlib.dump(configuration(role, args.release, args.logs), stream)
