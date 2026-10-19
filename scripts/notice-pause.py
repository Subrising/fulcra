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
import socket
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


def paused(policy, target, read_parent=None):
    provider = target['provider'].split('/')[0]
    if provider not in policy.get('pausedProviders', []):
        return False
    exceptions = set(policy.get('exceptSessions', []))
    current, seen = target['id'], set()
    try:
        while current and current not in seen and len(seen) < 128:
            if current in exceptions:
                return False
            seen.add(current)
            if read_parent is None:
                return True
            current = read_parent(current)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        # An unavailable label must never turn a paused notice into provider input.
        return True
    return True


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
    offset = index
    rest = rest[index:]
    if rest[:2] == ['agent', 'send']:
        rest = rest[1:]
        offset += 1
    if not rest or rest[0] != 'send':
        return None
    positional, positions, text, source, message_id = [], [], [], None, None
    restrictions = {}
    check_only = False
    requires_plain = False
    index = 1
    while index < len(rest):
        token = rest[index]
        if token in ['--home', '--host']:
            if index + 1 >= len(rest): raise ValueError('Missing endpoint value')
            endpoint.extend(rest[index:index + 2])
            index += 2
        elif token in ['--image', '--format', '-o']:
            if index + 1 >= len(rest): raise ValueError('Missing send option value')
            if token == '--image': requires_plain = True
            index += 2
        elif token in ['--prompt', '--prompt-file', '--from', '--message-id', '--outbound-refusal', '--outbound-server-only']:
            if index + 1 >= len(rest):
                raise ValueError('Missing send option value')
            value = rest[index + 1]
            if token == '--prompt':
                text.append(value)
            elif token == '--prompt-file':
                text.append(Path(value).read_text(encoding='utf-8'))
            elif token == '--from':
                source = value
            elif token == '--outbound-server-only':
                restrictions['outboundServerOnly'] = value
            elif token == '--outbound-refusal':
                restrictions['refusal'] = value
            else:
                message_id = value
            index += 2
        elif token in ['--inbound-only', '--outbound-main-only', '--check-only']:
            if token == '--check-only': check_only = True
            else: restrictions['inboundOnly' if token == '--inbound-only' else 'outboundMainOnly'] = True
            index += 1
        elif token in ['--no-wait', '--wait', '--queue', '--steer', '--json', '--no-color', '--no-headers', '--quiet', '-q', '--native-queue', '--no-notify-on-finish']:
            if token == '--native-queue': requires_plain = True
            index += 1
        elif token.startswith('-'):
            raise ValueError('Unsupported notice option. No notice was sent.')
        else:
            positional.append(token)
            positions.append(offset + index)
            index += 1
    if len(positional) == 2:
        text.append(positional.pop())
    if len(positional) != 1 or len(text) != 1:
        raise ValueError('A notice needs one target and one text source')
    return endpoint, positional[0], text[0], source, message_id, positions[0], requires_plain, restrictions, check_only


class TargetUnavailableError(ValueError):
    pass


class TargetNotFoundError(TargetUnavailableError):
    pass


class Gate:
    def __init__(self, root, run=native):
        self.root = Path(root)
        self.policy = self.root / 'pause.json'
        self.store = self.root / 'paused-notices'
        self.run = run

    def route_hint(self, identifier):
        policy = read_policy(self.policy)
        roles = policy.get('roles', {})
        resolved = roles.get(identifier[5:]) if identifier.startswith('role:') else identifier
        routes = policy.get('noticeRoutes', {})
        if not isinstance(routes, dict):
            raise ValueError('Invalid notice routes. No notice was sent.')
        matches = [(key, value) for key, value in routes.items()
                   if resolved and key.startswith(resolved)]
        if len(matches) != 1:
            return ''
        target_id, route = matches[0]
        if not isinstance(route, dict) or any(
            not isinstance(route.get(key), str) or not route[key].strip()
            for key in ['host', 'route']
        ):
            raise ValueError('Invalid notice route. No notice was sent.')
        return f" Target {target_id} is on {route['host']}. Use {route['route']}."

    def target(self, cli, endpoint, identifier):
        result = self.run(cli, [*endpoint, 'ls', '-g', '--json'], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError('Cannot list sessions on the selected daemon (exit '
                               + str(result.returncode) + ').'
                               + self.route_hint(identifier) + ' No notice was sent.')
        rows = json.loads(result.stdout)
        if not isinstance(rows, list):
            raise ValueError('Unknown session list schema')
        if identifier.startswith('role:'):
            role = read_policy(self.policy).get('roles', {}).get(identifier[5:])
            matches = [row for row in rows if row['id'] == role]
        else:
            matches = [row for row in rows if row['id'].startswith(identifier)]
        if len(matches) != 1:
            if not matches:
                raise TargetNotFoundError('The target is absent from the selected daemon on ' + socket.gethostname() + '.'
                                             + self.route_hint(identifier) + ' No notice was sent.')
            raise TargetUnavailableError('The notice target is ambiguous. Use its full session ID. No notice was sent.')
        row = matches[0]
        if not isinstance(row.get('provider'), str):
            raise ValueError('Unknown notice provider')
        if row.get('archivedAt') or row.get('archived'):
            raise TargetUnavailableError('The receiver is archived. Restore it first.')
        if row.get('status') == 'closed':
            raise TargetUnavailableError('session closed: reload it or start a new worker')
        return row

    def parent_reader(self, cli, endpoint):
        cache = {}
        def read(identifier):
            if identifier not in cache:
                cache[identifier] = None
                result = self.run(cli, [*endpoint, 'inspect', identifier, '--json'],
                                  capture_output=True, text=True, timeout=60)
                if result.returncode:
                    raise ValueError('Cannot read session labels')
                value = json.loads(result.stdout)
                if not isinstance(value, dict) or value.get('Id', value.get('id')) != identifier:
                    raise ValueError('Unknown session inspection schema')
                if 'ParentAgentId' in value:
                    parent = value['ParentAgentId']
                elif isinstance(value.get('labels'), dict):
                    labels = value['labels']
                    parent = labels.get('paseo.parent-agent-id', labels.get('parent'))
                else:
                    raise ValueError('Session inspection has no parent labels')
                if parent is not None and (not isinstance(parent, str) or not parent.strip()):
                    raise ValueError('Invalid session parent label')
                cache[identifier] = (parent,)
            if cache[identifier] is None:
                raise ValueError('Cannot read session labels')
            return cache[identifier][0]
        return read

    def send(self, cli, args, require_delivery=False):
        cli = shutil.which(cli) or cli
        parsed = parse_send(args)
        if parsed is None:
            return self.run(cli, args).returncode
        endpoint, identifier, text, source, message_id, target_index, requires_plain, restrictions, check_only = parsed
        supplied_endpoint = bool(endpoint)
        if not endpoint:
            home = os.environ.get('PASEO_HOME') or read_policy(self.policy).get('defaultHome')
            if home: endpoint = ['--home', home]
        # Read-only target discovery never starts a provider or sends input.
        try:
            target = self.target(cli, endpoint, identifier)
        except TargetNotFoundError:
            # Only the native CLI validates sender provenance and dispatches SSH routes.
            # Display-only noticeRoutes never grant an automatic remote send.
            policy = read_policy(self.policy)
            if require_delivery:
                raise ValueError('A required notice needs an explicit destination endpoint. No remote send was attempted.')
            key = policy.get('roles', {}).get(identifier[5:]) if identifier.startswith('role:') else identifier
            routes = policy.get('sshRoutes', {})
            if not isinstance(routes, dict):
                raise ValueError('Invalid SSH send routes. No notice was sent.')
            if any(not isinstance(item, str) or len(item) != 36 or str(uuid.UUID(item)) != item.lower() for item in routes):
                raise ValueError('SSH route keys must be complete session UUIDs. No notice was sent.')
            matches = [key] if key in routes else [item for item in routes if key and item.startswith(key)]
            if len(matches) != 1:
                raise
            bound = list(args)
            bound[target_index] = matches[0]
            if not supplied_endpoint: bound = [*endpoint, *bound]
            return self.run(cli, bound).returncode
        bound = list(args)
        bound[target_index] = target['id']
        if not supplied_endpoint: bound = [*endpoint, *bound]
        if check_only: return self.run(cli, bound).returncode
        if restrictions:
            # A restricted cross-host message must pass the destination check before a Python hold.
            checked = self.run(cli, [*bound, '--check-only', '--json'], capture_output=True, text=True, timeout=60)
            if checked.returncode:
                if checked.stdout: print(checked.stdout, end='')
                if checked.stderr: print(checked.stderr, end='', file=sys.stderr)
                return checked.returncode
            if json.loads(checked.stdout).get('status') != 'allowed':
                raise ValueError('The destination did not confirm the reporting-line check. No notice was sent.')
        with locked(self.store):
            if paused(read_policy(self.policy), target, self.parent_reader(cli, endpoint)):
                if requires_plain or text.lstrip().startswith('/'):
                    raise ValueError('Paused notices require plain text. The original command was not sent or stored.')
                if require_delivery:
                    raise ValueError('Provider paused. The required notice was not delivered.')
                return self.hold(cli, endpoint, target, text, source, message_id,
                                 notify_on_finish='--no-notify-on-finish' not in args, restrictions=restrictions)
        bound = list(args)
        bound[target_index] = target['id']
        if not supplied_endpoint: bound = [*endpoint, *bound]
        return self.run(cli, bound).returncode

    def hold(self, cli, endpoint, target, text, source, message_id, notify_on_finish=True, restrictions=None):
        identity = {'endpoint': endpoint, 'agentId': target['id']}
        # All launcher paths for this endpoint share one session record.
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        path = self.store / (key + '.json')
        sender = {'from': source, 'agent': os.environ.get('PASEO_AGENT_ID')}
        if not notify_on_finish: sender['notifyOnFinish'] = False
        if restrictions: sender.update(restrictions)
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
        errors = []
        readers = {}
        # Transport never holds the storage lock. A completion can always save its notice.
        with locked(self.store):
            paths = sorted(self.store.glob('*.json'))
        for path in paths:
            with locked(self.store):
                snapshot = json.loads(path.read_text())
                batch_ids = [batch['batchId'] for batch in snapshot['batches'] if batch['state'] == 'held']
            for batch_id in batch_ids:
                cli = read_policy(self.policy).get('deliveryCli') or snapshot['cli']
                try:
                    target = self.target(cli, snapshot['endpoint'], snapshot['agentId'])
                except TargetUnavailableError as error:
                    with locked(self.store):
                        record = json.loads(path.read_text())
                        batch = next(batch for batch in record['batches'] if batch['batchId'] == batch_id)
                        if batch['state'] == 'held':
                            batch.update(state='refused', reason=str(error))
                            atomic(path, record)
                    continue
                except Exception:
                    errors.append(batch_id)
                    continue
                reader_key = (cli, tuple(snapshot['endpoint']))
                if reader_key not in readers:
                    readers[reader_key] = self.parent_reader(cli, snapshot['endpoint'])
                with locked(self.store):
                    record = json.loads(path.read_text())
                    batch = next(batch for batch in record['batches'] if batch['batchId'] == batch_id)
                    if batch['state'] != 'held' or paused(read_policy(self.policy), target, readers[reader_key]):
                        continue
                    if target.get('status') == 'closed' or target.get('archivedAt') or target.get('archived'):
                        batch.update(state='refused', reason='Receiver closed or archived')
                        atomic(path, record)
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
                    if batch['sender'].get('notifyOnFinish') is False: args.append('--no-notify-on-finish')
                    if batch['sender'].get('inboundOnly'): args.append('--inbound-only')
                    if batch['sender'].get('outboundMainOnly'): args.append('--outbound-main-only')
                    if batch['sender'].get('outboundServerOnly'): args.extend(['--outbound-server-only', batch['sender']['outboundServerOnly']])
                    if batch['sender'].get('refusal'): args.extend(['--outbound-refusal', batch['sender']['refusal']])
                    env = dict(os.environ)
                    env.pop('PASEO_AGENT_ID', None)
                    endpoint = record['endpoint']
                    if '--home' in endpoint: env['PASEO_HOME'] = endpoint[endpoint.index('--home') + 1]
                    if batch['sender']['agent']: env['PASEO_AGENT_ID'] = batch['sender']['agent']
                try:
                    result = self.run(cli, args, env=env, capture_output=True, text=True, timeout=60)
                except (OSError, subprocess.SubprocessError) as error:
                    result = subprocess.CompletedProcess(args, 1, '', type(error).__name__)
                with locked(self.store):
                    record = json.loads(path.read_text())
                    batch = next(batch for batch in record['batches'] if batch['batchId'] == batch_id)
                    batch.update(state='delivered' if result.returncode == 0 else 'uncertain',
                                 receipt={'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
                    atomic(path, record)
                if result.returncode: errors.append(batch_id)
        if errors:
            raise RuntimeError('Notice delivery failed. Retained all receipts. No automatic retry.')


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


def cli_main():
    try:
        return main()
    except TargetNotFoundError as error:
        print(json.dumps({'error': {'code': 'AGENT_NOT_FOUND', 'message': str(error)}}), file=sys.stderr)
        return 1
    except (OSError, subprocess.SubprocessError):
        print('Notice gate: File or transport operation failed. Check the saved receipts.', file=sys.stderr)
        return 1
    except Exception as error:
        print('Notice gate: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(cli_main())
