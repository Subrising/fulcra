#!/usr/bin/env python3
"""Hold native CLI notices while a provider is paused. Python standard library only."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil
import tempfile
import uuid


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.notice-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextlib.contextmanager
def locked(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / 'lock').open('a+b') as stream:
        if os.name == 'nt':
            import msvcrt
            if stream.tell() == 0:
                stream.write(b'0')
                stream.flush()
            stream.seek(0)
            import ctypes
            from ctypes import wintypes
            class Overlapped(ctypes.Structure):
                _fields_ = [('internal', ctypes.c_size_t), ('internal_high', ctypes.c_size_t),
                            ('offset', wintypes.DWORD), ('offset_high', wintypes.DWORD), ('event', wintypes.HANDLE)]
            overlap = Overlapped()
            handle = wintypes.HANDLE(msvcrt.get_osfhandle(stream.fileno()))
            lock = ctypes.windll.kernel32.LockFileEx
            lock.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                             wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
            if not lock(handle, 2, 0, 1, 0, ctypes.byref(overlap)):
                raise ctypes.WinError()
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == 'nt':
                stream.seek(0)
                unlock = ctypes.windll.kernel32.UnlockFileEx
                unlock.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.DWORD, ctypes.POINTER(Overlapped)]
                if not unlock(handle, 0, 1, 0, ctypes.byref(overlap)):
                    raise ctypes.WinError()
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def read_policy(path):
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {'pausedProviders': [], 'exceptSessions': []}
    if not isinstance(value, dict) or any(
        not isinstance(value.get(key, []), list)
        or any(not isinstance(item, str) for item in value.get(key, []))
        for key in ['pausedProviders', 'exceptSessions']
    ):
        raise ValueError('Invalid pause policy. No notice was sent.')
    return value


def paused(policy, target):
    provider = target['provider'].split('/')[0]
    return provider in policy.get('pausedProviders', []) and target['id'] not in policy.get('exceptSessions', [])


def native(cli, args, **kwargs):
    flags = {}
    if os.name == 'nt':
        flags['creationflags'] = subprocess.CREATE_NO_WINDOW
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        flags['startupinfo'] = startup
    if os.name == 'nt' and not any(key in kwargs for key in ['capture_output', 'stdout', 'stderr']):
        import threading
        child = subprocess.Popen([cli, *args], **flags, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
        def relay(stream, sink):
            while True:
                chunk = os.read(stream.fileno(), 4096)
                if not chunk: break
                if hasattr(sink, 'buffer'): sink.buffer.write(chunk)
                else: sink.write(chunk.decode('utf-8', errors='replace'))
                sink.flush()
        threads = [threading.Thread(target=relay, args=(child.stdout, sys.stdout)),
                   threading.Thread(target=relay, args=(child.stderr, sys.stderr))]
        for thread in threads: thread.start()
        code = child.wait()
        for thread in threads: thread.join()
        return subprocess.CompletedProcess([cli, *args], code)
    if kwargs.get('text'): kwargs.setdefault('encoding', 'utf-8')
    return subprocess.run([cli, *args], **flags, **kwargs)


def parse_send(args):
    """Keep endpoint options separate. Refuse unsupported paused sends without dispatch."""
    endpoint = []
    rest = list(args)
    index = 0
    while index < len(rest):
        token = rest[index]
        if token in ['send', 'agent']:
            break
        if token in ['--home', '--host', '-o', '--format']:
            if index + 1 >= len(rest):
                raise ValueError('Missing global option value')
            if token in ['--home', '--host']:
                endpoint.extend(rest[index:index + 2])
            index += 2
        elif token.startswith(('--home=', '--host=')):
            name, value = token.split('=', 1)
            endpoint.extend([name, value])
            index += 1
        elif token in ['--json', '--no-color', '--no-headers', '--quiet', '-q']:
            index += 1
        else:
            return None
    rest = rest[index:]
    if rest[:2] == ['agent', 'send']:
        rest = rest[1:]
    if not rest or rest[0] != 'send':
        return None
    positional, text, source, message_id = [], [], None, None
    index = 1
    while index < len(rest):
        token = rest[index]
        if token in ['--home', '--host']:
            if index + 1 >= len(rest): raise ValueError('Missing endpoint value')
            endpoint.extend(rest[index:index + 2])
            index += 2
        elif token in ['--prompt', '--prompt-file', '--from', '--message-id']:
            if index + 1 >= len(rest):
                raise ValueError('Missing send option value')
            value = rest[index + 1]
            if token == '--prompt':
                text.append(value)
            elif token == '--prompt-file':
                text.append(Path(value).read_text(encoding='utf-8'))
            elif token == '--from':
                source = value
            else:
                message_id = value
            index += 2
        elif token in ['--no-wait', '--queue', '--steer', '--json', '--no-color']:
            index += 1
        elif token.startswith('-'):
            raise ValueError('Unsupported notice option. No notice was sent.')
        else:
            positional.append(token)
            index += 1
    if len(positional) == 2:
        text.append(positional.pop())
    if len(positional) != 1 or len(text) != 1:
        raise ValueError('A notice needs one target and one text source')
    return endpoint, positional[0], text[0], source, message_id


class Gate:
    def __init__(self, root, run=native):
        self.root = Path(root)
        self.policy = self.root / 'pause.json'
        self.store = self.root / 'paused-notices'
        self.run = run

    def target(self, cli, endpoint, identifier):
        result = self.run(cli, [*endpoint, 'ls', '--json'], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError('Cannot resolve the notice target. No notice was sent.')
        rows = json.loads(result.stdout)
        if not isinstance(rows, list):
            raise ValueError('Unknown session list schema')
        if identifier == 'role:main-assistant':
            role = read_policy(self.policy).get('roles', {}).get('main-assistant')
            matches = [row for row in rows if row['id'] == role]
        else:
            matches = [row for row in rows if row['id'].startswith(identifier)]
        if len(matches) != 1:
            raise ValueError('The notice target must resolve to one session')
        row = matches[0]
        if not isinstance(row.get('provider'), str):
            raise ValueError('Unknown notice provider')
        return row

    def send(self, cli, args, require_delivery=False):
        cli = shutil.which(cli) or cli
        parsed = parse_send(args)
        if parsed is None:
            return self.run(cli, args).returncode
        endpoint, identifier, text, source, message_id = parsed
        supplied_endpoint = bool(endpoint)
        if not endpoint:
            home = os.environ.get('PASEO_HOME') or read_policy(self.policy).get('defaultHome')
            if home: endpoint = ['--home', home]
        # Read-only target discovery never starts a provider or sends input.
        target = self.target(cli, endpoint, identifier)
        with locked(self.store):
            if paused(read_policy(self.policy), target):
                if require_delivery:
                    raise ValueError('Provider paused. The required notice was not delivered.')
                return self.hold(cli, endpoint, target, text, source, message_id)
        bound = list(args)
        bound[bound.index(identifier)] = target['id']
        if not supplied_endpoint: bound = [*endpoint, *bound]
        return self.run(cli, bound).returncode

    def hold(self, cli, endpoint, target, text, source, message_id):
        identity = {'endpoint': endpoint, 'agentId': target['id']}
        # All launcher paths for this endpoint share one session record.
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        path = self.store / (key + '.json')
        sender = {'from': source, 'agent': os.environ.get('PASEO_AGENT_ID')}
        record = json.loads(path.read_text()) if path.exists() else {
            **identity, 'cli': str(Path(cli).absolute()), 'batches': []}
        if sum(len(batch['notices']) for batch in record['batches'] if batch['state'] == 'held') >= 1000:
            raise ValueError('Held notice limit reached. No notice was sent.')
        batch = next((batch for batch in record['batches']
                      if batch['state'] == 'held' and batch['sender'] == sender), None)
        if batch is None:
            batch = {'state': 'held', 'sender': sender, 'notices': [], 'batchId': str(uuid.uuid4())}
            record['batches'].append(batch)
        if len(batch['notices']) >= 1000 or len(text.encode()) > 256 * 1024:
            raise ValueError('Held notice limit reached. No notice was sent.')
        duplicate = next((item for batch in record['batches'] for item in batch['notices']
                          if message_id and item['id'] == message_id), None)
        if duplicate and duplicate['text'] != text:
            raise ValueError('Message ID content changed. No notice was sent.')
        if not duplicate:
            batch['notices'].append({'id': message_id or str(uuid.uuid4()), 'text': text})
            if len(json.dumps(record).encode()) > 16 * 1024 * 1024:
                raise ValueError('Held record exceeds 16 MiB. No notice was sent.')
            atomic(path, record)
        count = sum(len(batch['notices']) for batch in record['batches'] if batch['state'] == 'held')
        print(json.dumps({'agentId': target['id'], 'status': 'held', 'pendingCount': count,
                          'message': 'Provider paused. Notice saved. No turn was started.'}))
        return 0

    def drain(self):
        # Transport never holds the storage lock. A completion can always save its notice.
        with locked(self.store):
            paths = sorted(self.store.glob('*.json'))
        for path in paths:
            with locked(self.store):
                snapshot = json.loads(path.read_text())
                batch_ids = [batch['batchId'] for batch in snapshot['batches'] if batch['state'] == 'held']
            for batch_id in batch_ids:
                target = self.target(snapshot['cli'], snapshot['endpoint'], snapshot['agentId'])
                with locked(self.store):
                    record = json.loads(path.read_text())
                    batch = next(batch for batch in record['batches'] if batch['batchId'] == batch_id)
                    if batch['state'] != 'held' or paused(read_policy(self.policy), target):
                        continue
                    if target.get('status') == 'closed' or target.get('archivedAt') or target.get('archived'):
                        continue
                    text = 'Job notices held during the provider pause:\n\n' + '\n\n'.join(
                        item['text'] for item in batch['notices'])
                    prompt = path.with_name(batch_id + '.txt')
                    prompt.write_text(text, encoding='utf-8')
                    if os.name != 'nt': prompt.chmod(0o600)
                    batch['state'] = 'attempted'
                    atomic(path, record)
                    args = [*record['endpoint'], 'send', record['agentId'], '--queue', '--no-wait', '--json', '--prompt-file', str(prompt)]
                    if batch['sender']['from']: args.extend(['--from', batch['sender']['from']])
                    env = dict(os.environ)
                    env.pop('PASEO_AGENT_ID', None)
                    if batch['sender']['agent']: env['PASEO_AGENT_ID'] = batch['sender']['agent']
                result = self.run(record['cli'], args, env=env, capture_output=True, text=True, timeout=60)
                with locked(self.store):
                    record = json.loads(path.read_text())
                    batch = next(batch for batch in record['batches'] if batch['batchId'] == batch_id)
                    batch.update(state='delivered' if result.returncode == 0 else 'uncertain',
                                 receipt={'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
                    atomic(path, record)
                if result.returncode:
                    raise RuntimeError('Notice delivery failed. Retained the record. No automatic retry.')


def main():
    root = Path(os.environ.get('FULCRA_NOTICE_CONFIG', str(Path.home() / '.config/fulcra')))
    gate = Gate(root)
    require_delivery = len(sys.argv) > 1 and sys.argv[1] == '--require-delivery'
    if require_delivery:
        sys.argv.pop(1)
        if len(sys.argv) < 4 or sys.argv[1] != '--cli':
            raise ValueError('--require-delivery needs a native CLI notice')
    if sys.argv[1:] in [['--resume'], ['--pause']]:
        with locked(gate.store):
            value = read_policy(gate.policy)
            providers = [provider for provider in value.get('pausedProviders', []) if provider != 'claude']
            if sys.argv[1] == '--pause': providers.append('claude')
            value['pausedProviders'] = providers
            atomic(gate.policy, value)
            for file in value.get('daemonPauseFiles', []): atomic(Path(file), value)
        if sys.argv[1] == '--resume' and not value.get('daemonWatch'): gate.drain()
        return 0
    if sys.argv[1:] == ['--drain']:
        gate.drain()
        return 0
    if len(sys.argv) < 4 or sys.argv[1] != '--cli':
        raise ValueError('Usage: notice-pause.py --cli <native-cli> <native-arguments...> | --resume | --drain')
    return gate.send(sys.argv[2], sys.argv[3:], require_delivery=require_delivery)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('Notice gate: ' + str(error), file=sys.stderr)
        sys.exit(1)
