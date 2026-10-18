#!/usr/bin/env python3
"""Run one existing hook and record its result. Do not execute the requested tool."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys


def append_record(path, record):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise OSError('Audit symlink refused')
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        if os.name == 'nt':
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (hasattr(os, 'getuid') and info.st_uid != os.getuid()):
            raise OSError('Private regular audit file required')
        if os.name != 'nt' and info.st_mode & 0o077:
            raise OSError('Private audit file permissions required')
        data = (json.dumps(record, separators=(',', ':')) + '\n').encode()
        os.lseek(fd, 0, os.SEEK_END)
        if os.write(fd, data) != len(data):
            raise OSError('Incomplete audit record')
        os.fsync(fd)
    finally:
        os.close(fd)


def identity(data):
    agent_id = os.environ.get('PASEO_AGENT_ID', '')
    name = data.get('session_name')
    home = os.environ.get('PASEO_HOME')
    identity_source = 'hook-input' if name else 'unavailable'
    if home and agent_id and all(c in '0123456789abcdef-' for c in agent_id):
        # Read only the current session's public record. Never read its credentials.
        for p in (Path(home) / 'agents').glob('*/' + agent_id + '.json'):
            try:
                saved = json.loads(p.read_text())
                if saved.get('id') == agent_id:
                    name = saved.get('title')
                    identity_source = 'host-record'
                    break
            except (OSError, ValueError):
                pass
    return {'sessionId': data.get('session_id') or os.environ.get('CODEX_THREAD_ID'), 'agentId': agent_id or None,
            'sessionName': name, 'identitySource': identity_source}


def decision(result):
    if result.returncode != 0:
        return ('deny', 'hook-exit') if result.returncode == 2 else ('error', 'hook-error')
    try:
        value = json.loads(result.stdout or '{}')
    except ValueError:
        # A malformed response must not become an audit claim that permission was granted.
        return 'invalid', 'invalid-hook-output'
    if not isinstance(value, dict):
        return 'invalid', 'invalid-hook-output'
    specific = value.get('hookSpecificOutput') or {}
    if not isinstance(specific, dict):
        return 'invalid', 'invalid-hook-output'
    nested = specific.get('decision') or {}
    if not isinstance(nested, dict):
        return 'invalid', 'invalid-hook-output'
    if value.get('continue') is False:
        return 'deny', 'hook-stop'
    answer = specific.get('permissionDecision') or nested.get('behavior')
    answer = answer or value.get('decision')
    if answer in ('deny', 'block'):
        return 'deny', 'hook-decision'
    if answer == 'ask':
        return 'defer', 'hook-ask'
    if answer in ('allow', 'approve'):
        return 'allow', 'hook-decision'
    return 'pass', 'hook-no-veto'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rule', required=True)
    parser.add_argument('--kind', choices=['hook', 'git'], default='hook')
    parser.add_argument('--log', type=Path, default=Path.home()/'.fulcra-guards/approval-records.jsonl')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    raw = sys.stdin.buffer.read()
    try:
        data = json.loads(raw) if args.kind == 'hook' else {'session_id': None, 'tool_name': 'git', 'cwd': os.getcwd(), 'tool_input': {'stdinSha256': hashlib.sha256(raw).hexdigest()}}
        if not isinstance(data, dict):
            raise ValueError('Object required')
        result = subprocess.run(command, input=raw, capture_output=True, timeout=135)
        outcome, basis = decision(result) if args.kind == 'hook' else ('pass' if result.returncode == 0 else 'deny', 'git-hook-exit')
        tool_input = data.get('tool_input') or {}
        if args.kind == 'hook' and outcome == 'allow':
            updated = (json.loads(result.stdout or '{}').get('hookSpecificOutput') or {}).get('updatedInput')
            if updated is not None:
                if not isinstance(updated, dict):
                    raise ValueError('Object input required')
                tool_input = updated
        # The digest and tool-use ID identify the exact private input without copying secrets.
        target = {'inputSha256': hashlib.sha256(json.dumps(tool_input, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                  'cwd': data.get('cwd'), 'toolUseId': data.get('tool_use_id')}
        if isinstance(tool_input, dict) and isinstance(tool_input.get('command'), str):
            try:
                words = shlex.split(tool_input['command'])
                program = Path(words[0]).name if words else None
                if program in {'git', 'gh', 'python', 'python3', 'node', 'bash', 'sh', 'zsh', 'fulcra', 'paseo', 'cat', 'ls', 'pwd', 'echo', 'ffmpeg', 'npm', 'npx'}:
                    target['program'] = program
            except ValueError:
                pass
        record = {'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  **identity(data), 'tool': data.get('tool_name'), 'target': target,
                  'rule': args.rule, 'decision': outcome, 'basis': basis,
                  'exitCode': result.returncode}
        append_record(args.log, record)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print('Approval record failed: ' + type(error).__name__, file=sys.stderr)
        return 2
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    return 2 if outcome in ['invalid', 'error'] else result.returncode


if __name__ == '__main__':
    sys.exit(main())
