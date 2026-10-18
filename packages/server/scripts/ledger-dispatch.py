#!/usr/bin/env python3
"""Atomic dispatch claim CLI. Shares the normal ledger CLI's project flock."""
import fcntl, hashlib, json, os, re, sys, tempfile, time, sqlite3

MARKER = re.compile(r"\s*\[fulcra-dispatch:[^\]]+\]")

def rows(text):
    found = []
    for line in text.splitlines():
        if not line.startswith('|') or not line.rstrip().endswith('|'):
            continue
        cells = [c.strip() for c in line.strip()[1:-1].split('|')]
        if len(cells) == 7 and re.fullmatch(r'[A-Za-z][A-Za-z0-9]*-\d+', cells[0]):
            found.append(cells)
    return found

def digest(cells):
    data = dict(brief=cells[1], id=cells[0], kind=cells[2], owner=re.sub(r' \([a-f0-9-]{36}\)$', '', cells[3]), source=MARKER.sub('', cells[6]).strip())
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()

def save(file, text):
    fd, temp = tempfile.mkstemp(dir=os.path.dirname(file))
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(text); out.flush(); os.fsync(out.fileno())
        os.chmod(temp, 0o600); os.replace(temp, file)
        directory = os.open(os.path.dirname(file), os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(temp): os.unlink(temp)

def receipt_store(root):
    file = root+'/.fulcra-dispatch-receipts.sqlite'
    database = sqlite3.connect(file)
    os.chmod(file, 0o600)
    database.execute('PRAGMA synchronous=FULL')
    database.execute("CREATE TABLE IF NOT EXISTS consumed (generation TEXT PRIMARY KEY, project TEXT NOT NULL, item TEXT NOT NULL, operationId TEXT NOT NULL DEFAULT '', sessionId TEXT NOT NULL DEFAULT '')")
    columns = {row[1] for row in database.execute('PRAGMA table_info(consumed)')}
    for column in ('operationId', 'sessionId'):
        if column not in columns: database.execute("ALTER TABLE consumed ADD COLUMN "+column+" TEXT NOT NULL DEFAULT ''")
    database.execute('CREATE INDEX IF NOT EXISTS consumed_operation ON consumed(operationId)')
    database.commit()
    return database

def main(data):
    if data['action'] not in ('inspect', 'ready', 'claim', 'receipt', 'abandon', 'archive-transfer'): raise ValueError('Unknown ledger action')
    root = os.path.realpath(data['root'])
    if '/ledger/mirror' in root or root.endswith('/mirror'): raise ValueError('Ledger mirrors cannot dispatch')
    project = data['project']
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]*', project): raise ValueError('Invalid project')
    file = os.path.join(root, project, 'OPEN-ITEMS.md')
    if os.path.realpath(file) != file or os.path.getsize(file) > 512*1024: raise ValueError('Invalid ledger path or size')
    # Global lock serializes caps and budgets across projects and daemon processes.
    with open(root+'/.fulcra-dispatch.lock', 'a') as global_lock, open(file+'.lock', 'a') as project_lock:
        fcntl.flock(global_lock, fcntl.LOCK_EX); fcntl.flock(project_lock, fcntl.LOCK_EX)
        text = open(file).read(); matches = [r for r in rows(text) if r[0] == data['item']]
        if len(matches) != 1: return dict(ok=False, reason='item identity is not unique')
        row = matches[0]
        receipts = receipt_store(root) if data['action'] in ('claim', 'receipt') else None
        if data['action'] == 'receipt':
            found = receipts.execute('SELECT sessionId, generation FROM consumed WHERE project=? AND item=? AND operationId=?', (project, row[0], data['operationId'])).fetchone()
            return dict(ok=bool(found and found[0]), sessionId=found[0] if found else None, generation=found[1] if found else None)
        if data['action'] == 'inspect': return dict(ok=True, digest=digest(row))
        if data['action'] == 'archive-transfer':
            if row[3] != data['expectedOwner'] or row[4] != data['expectedStatus'] or re.match(r'^(DONE|MOVED)\b', row[4], re.I):
                return dict(ok=False, reason='ledger ownership or status changed')
            owner, note = data['owner'], data['note']
            if not owner.strip() or any(c in owner+note for c in '|\r\n'):
                raise ValueError('Invalid transfer text')
            row[3] = owner
            row[4] += '; '+note
        elif data['action'] == 'ready':
            if digest(row) != data['digest']: return dict(ok=False, reason='item admission changed')
            row[4] = 'READY'
        elif data['action'] == 'claim':
            generation = data['generation']
            if row[4] != 'READY' or row[2] not in ('BUILD', 'FIX') or digest(row) != data['digest']:
                return dict(ok=False, reason='item admission changed')
            if receipts.execute('SELECT 1 FROM consumed WHERE generation=?', (generation,)).fetchone():
                row[4] = 'BLOCKED: dispatch approval already consumed'
                lines = text.splitlines()
                for index, line in enumerate(lines):
                    parsed = rows(line)
                    if parsed and parsed[0][0] == row[0]: lines[index] = '| '+' | '.join(row)+' |'
                save(file, '\n'.join(lines)+'\n')
                return dict(ok=False, reason='approval already consumed')
            if '[fulcra-dispatch:'+generation+':' in row[6]: return dict(ok=False, reason='approval already consumed')
            budget_file = root+'/.fulcra-dispatch-budget.json'
            budget = json.load(open(budget_file)) if os.path.exists(budget_file) else dict(day='', count=0, projects={})
            day = time.strftime('%Y-%m-%d', time.gmtime(data['now']/1000))
            if budget['day'] != day: budget.update(day=day, count=0)
            state = budget['projects'].get(project, dict(enableId=data['enableId'], total=0, limit=data['maxTotalStarts'], day=day, daily=0, last=0))
            if state['enableId'] != data['enableId']: state.update(enableId=data['enableId'], total=0, limit=data['maxTotalStarts'])
            if state['day'] != day: state.update(day=day, daily=0)
            if state['total'] >= min(state.get('limit', data['maxTotalStarts']), data['maxTotalStarts']): return dict(ok=False, reason='total start limit')
            if state['daily'] >= data['dailyStartBudget'] or budget['count'] >= 100: return dict(ok=False, reason='daily start budget')
            if state['last'] and data['now']-state['last'] < data['minStartIntervalSeconds']*1000:
                return dict(ok=False, reason='project start rate')
            active = 0; project_active = 0
            for directory in os.scandir(root):
                candidate = os.path.join(directory.path, 'OPEN-ITEMS.md')
                if not directory.is_dir(follow_symlinks=False) or not os.path.isfile(candidate): continue
                for candidate_row in rows(open(candidate).read()):
                    operation = re.fullmatch(r'IN PROGRESS: dispatch ([a-f0-9-]{36})', candidate_row[4])
                    valid = operation and receipts.execute('SELECT 1 FROM consumed WHERE operationId=? AND project=? AND item=?', (operation[1], directory.name, candidate_row[0])).fetchone()
                    if valid:
                        active += 1
                        if directory.name == project: project_active += 1
            if active >= 16 or project_active >= data['maxParallel']: return dict(ok=False, reason='active session cap')
            state.update(total=state['total']+1, daily=state['daily']+1, last=data['now'])
            budget['count'] += 1; budget['projects'][project] = state
            receipts.execute('INSERT INTO consumed(generation, project, item, operationId, sessionId) VALUES (?, ?, ?, ?, ?)', (generation, project, row[0], data['operationId'], data['sessionId']))
            receipts.commit()
            save(budget_file, json.dumps(budget))  # Reservations survive a crash before the ledger write.
            row[3] = row[3]+' ('+data['sessionId']+')'
            row[4] = 'IN PROGRESS: dispatch '+data['operationId']
            row[6] += ' [fulcra-dispatch:'+generation+':'+data['operationId']+':'+data['addedBy']+']'
        elif row[4] == 'IN PROGRESS: dispatch '+data['operationId']:
            row[3] = re.sub(r' \([a-f0-9-]{36}\)$', '', row[3])
            row[4] = 'BLOCKED: dispatch outcome needs owner review'
        else:
            return dict(ok=True)
        # Replace only the parsed row, with the project lock held against ledger set/close.
        lines = text.splitlines()
        indices = [i for i,l in enumerate(lines) if rows(l) and rows(l)[0][0] == data['item']]
        if len(indices) != 1: raise ValueError('Duplicate ledger identity')
        lines[indices[0]] = '| '+' | '.join(row)+' |'
        save(file, '\n'.join(lines)+'\n')
        return dict(ok=True)

try:
    data = json.loads(sys.stdin.readline())
    if data['action'] == 'lease':
        root = os.path.realpath(data['root'])
        if '/ledger/mirror' in root or root.endswith('/mirror'): raise ValueError('Ledger mirrors cannot dispatch')
        with open(root+'/.fulcra-dispatch-owner.lock', 'a') as lease:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(json.dumps(dict(ok=True)), flush=True)
            sys.stdin.read()  # EOF on daemon exit releases the kernel lock, including after a crash.
    else:
        print(json.dumps(main(data)), flush=True)
except Exception as error:
    print(json.dumps(dict(ok=False, reason=str(error))), flush=True); sys.exit(1)
