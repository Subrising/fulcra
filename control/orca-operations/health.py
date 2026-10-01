"""One bounded, single-owner health tick; no model calls or service repair."""
from contextlib import closing
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid
from urllib.parse import quote


def private(path, directory=False):
    p = Path(path)
    s = p.lstat()
    if p.resolve() != p or s.st_uid != os.getuid() or s.st_mode & 0o077:
        raise ValueError('Unsafe local monitor path')
    if not (p.is_dir() if directory else p.is_file()):
        raise ValueError('Unexpected monitor file type')
    return p


def probe(config, now):
    try:
        source = private(config['queue'])
        with closing(sqlite3.connect('file:' + quote(str(source)) + '?mode=ro', uri=True, timeout=2)) as db, db:
            row = db.execute('SELECT seen,pid FROM health WHERE id=1').fetchone()
        if not row or row[0] > now + 30000 or now - row[0] >= 60000:
            return {'healthy': False, 'reason': 'Watcher heartbeat missing or stale'}
        os.kill(int(row[1]), 0)
        return {'healthy': True, 'reason': 'Watcher heartbeat current', 'pid': row[1], 'seen': row[0]}
    except (OSError, ValueError, sqlite3.Error, TypeError):
        return {'healthy': False, 'reason': 'Watcher process or queue unavailable'}


def notification(config, incident, phase, observation):
    prefix = 'Fulcra service recovery' if phase == 'recovery' else 'Fulcra service alert'
    detail = 'Conversation completion tracking is healthy again.' if phase == 'recovery' else 'Conversation completion tracking needs attention. Queued results may be delayed.'
    return f'{prefix} [{incident[:8]}]: {detail} {observation["reason"]}. Existing sessions and receipts have not been replayed or restarted. Inspect Fulcra watches and the local health incident record.'


def deliver(config, text):
    # The target is installed from the owner configuration, never supplied by a worker.
    params = {'agentId': 'main', 'channel': 'discord', 'accountId': config['accountId'], 'to': 'channel:' + config['conversationId'], 'message': text, 'idempotencyKey': 'orca-health-' + hashlib.sha256(text.encode()).hexdigest()}
    result = subprocess.run(['/opt/homebrew/bin/openclaw', 'gateway', 'call', 'send', '--params', json.dumps(params), '--json', '--timeout', '20000'], capture_output=True, text=True, timeout=25)
    if result.returncode:
        raise RuntimeError('Discord transport command failed; delivery may be uncertain')
    data = json.loads(result.stdout)
    if not data.get('messageId') or data.get('channel') != 'discord':
        raise RuntimeError('No confirmed Discord delivery receipt')
    return data



def tick(db, config, observation, send=deliver, now=None):
    now = int(time.time() * 1000) if now is None else now
    db.executescript('''CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), first_bad INTEGER, incident TEXT);
      CREATE TABLE IF NOT EXISTS notices(incident TEXT, phase TEXT, state TEXT, at INTEGER, body TEXT, result TEXT, PRIMARY KEY(incident,phase));
      CREATE TABLE IF NOT EXISTS health(id INTEGER PRIMARY KEY CHECK(id=1), seen INTEGER, observation TEXT);
      INSERT OR IGNORE INTO state VALUES(1,NULL,NULL);''')
    row = db.execute('SELECT first_bad,incident FROM state WHERE id=1').fetchone()
    first, incident = row
    phase = None
    db.execute('INSERT OR REPLACE INTO health VALUES(1,?,?)', (now, json.dumps(observation)))
    if observation['healthy']:
        if incident:
            phase = 'recovery'
        db.execute('UPDATE state SET first_bad=NULL,incident=NULL WHERE id=1')
    elif first is None or first > now:
        db.execute('UPDATE state SET first_bad=? WHERE id=1', (now,))
    elif not incident and now - first >= 60000:
        incident, phase = str(uuid.uuid4()), 'failure'
        db.execute('UPDATE state SET incident=? WHERE id=1', (incident,))
    if phase:
        body = notification(config, incident, phase, observation)
        changed = db.execute("INSERT OR IGNORE INTO notices VALUES(?,?,'dispatch-intent',?,?,NULL)", (incident, phase, now, body)).rowcount
    else:
        changed = 0
    db.commit()  # Persist intent before any external side effect; never replay it.
    if changed:
        try:
            result = send(config, body)
            state = 'submitted'
        except Exception as error:
            result, state = {'error': type(error).__name__, 'note': 'Do not retry automatically; inspect actual Discord history'}, 'uncertain'
        db.execute('UPDATE notices SET state=?,result=? WHERE incident=? AND phase=?', (state, json.dumps(result), incident, phase))
        db.commit()
    return {'healthy': observation['healthy'], 'incident': incident, 'phase': phase, 'notified': bool(changed)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    parser.add_argument('sha256')
    parser.add_argument('--probe', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    raw = private(args.config).read_bytes()
    if hashlib.sha256(raw).hexdigest() != args.sha256:
        raise ValueError('Installed monitor configuration changed')
    config = json.loads(raw)
    if set(config) != {'version', 'queue', 'stateDir', 'accountId', 'conversationId'} or config['version'] != 1:
        raise ValueError('Invalid monitor configuration')
    if not config['conversationId'].isdigit() or not config['accountId'] or not isinstance(config['accountId'], str):
        raise ValueError('Invalid owner route')
    directory = private(config['stateDir'], directory=True)
    for name in ['monitor.sqlite', 'monitor.sqlite-wal', 'monitor.sqlite-shm', 'monitor.sqlite-journal', 'tick.lock']:
        p = directory / name
        if p.exists() or p.is_symlink():
            private(p)
    now = int(time.time() * 1000)
    if args.probe:
        print(json.dumps(probe(config, now)))
        return
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), args.config, args.sha256, '--probe'], capture_output=True, text=True, timeout=5, check=True)
        observation = json.loads(result.stdout)
    except (subprocess.SubprocessError, ValueError):
        observation = {'healthy': False, 'reason': 'Watcher health probe unavailable or timed out'}
    fd = os.open(directory / 'tick.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        with closing(sqlite3.connect(directory / 'monitor.sqlite', timeout=2)) as db, db:
            db.execute('PRAGMA synchronous=FULL')
            print(json.dumps(tick(db, config, observation, now=now)))
    finally:
        os.close(fd)


if __name__ == '__main__':
    main()
