#!/bin/sh
# Read-only V5 snapshot checker; the only write is a new, private report file.
set -eu
exec python3 - "$@" <<'PY'
import argparse, ctypes, datetime, hashlib, http.client, json, os, pathlib, plistlib, re, signal, stat, subprocess, sys

p = argparse.ArgumentParser(description='V5 snapshot checker (Python 3 + Node required). Never run as root.')
p.add_argument('--app', required=True)
p.add_argument('--paseo-home', required=True)
p.add_argument('--port', required=True, type=int)
p.add_argument('--protected-home', required=True, help='Home directory of the existing/live user')
p.add_argument('--report', required=True, help='New JSON file; never overwritten')
p.add_argument('--baseline', help='Pre-install report produced with --capture-baseline')
p.add_argument('--capture-baseline', action='store_true')
p.add_argument('--daemon-pid', type=int)
p.add_argument('--controller-pid', type=int)
p.add_argument('--daemon-entry', help='V4-provided actual daemon executable relative to app bundle (proc_pidpath, not ps title)')
p.add_argument('--controller-entry', help='V4-provided controller entry relative to app bundle')
p.add_argument('--scanner', help='Matching control checkout tools/v5-exact-audit.mjs (Node required)')
p.add_argument('--scan-reviews', help='Exact reviewed-match JSON for this artifact; required while enabled')
p.add_argument('--fixture', help='OFFLINE TEST ONLY: JSON observation snapshot; never V5 acceptance')
a = p.parse_args()
results = []
report = {'schema': 1, 'kind': 'baseline' if a.capture_baseline else 'check',
          'mode': 'FIXTURE ONLY' if a.fixture else 'LIVE SNAPSHOT',
          'time': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': results}
def check(name, fn):
    try:
        detail = fn()
        if detail is False: raise ValueError('condition not met')
        results.append({'check': name, 'status': 'PASS', 'detail': detail or 'verified'})
    except Exception as e:
        # Do not include subprocess stdout/stderr: ps environments can contain secrets.
        results.append({'check': name, 'status': 'FAIL', 'detail': str(e)})
    print(results[-1]['status'] + ' ' + name + ': ' + str(results[-1]['detail']))
def require(ok, text):
    if not ok: raise ValueError(text)
def command(args, allow_empty=False):
    r = subprocess.run(args, capture_output=True, text=True, timeout=60)
    require(not r.stderr.strip() and (r.returncode == 0 or (allow_empty and r.returncode == 1 and not r.stdout)),
            'observation unavailable: ' + pathlib.Path(args[0]).name)
    return r.stdout

def launch_inventory(home):
    inventory = {}
    for root in [home / 'Library/LaunchAgents', pathlib.Path('/Library/LaunchAgents'),
                 pathlib.Path('/Library/LaunchDaemons')]:
        if not root.exists(): continue
        for f in sorted(root.iterdir()):
            require(not f.is_symlink() and f.is_file(), 'unreadable/symlink launch entry')
            inventory[str(f)] = hashlib.sha256(f.read_bytes()).hexdigest()
    # PIDs and exit statuses change normally; labels are the stable registration set.
    labels = sorted(line.split()[-1] for line in command(['/bin/launchctl', 'list']).splitlines()[1:] if line.strip())
    return {'files': inventory, 'labels': labels}

def executable_path(pid):
    # macOS libproc: titles and flattened argv are not executable identity.
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    lib.proc_pidpath.restype = ctypes.c_int
    buf = ctypes.create_string_buffer(4096)  # PROC_PIDPATHINFO_MAXSIZE
    size = lib.proc_pidpath(pid, buf, len(buf))
    require(0 < size < len(buf), 'daemon executable observation unavailable')
    return os.fsdecode(buf.value)

def selected_home_from_procargs(raw):
    # KERN_PROCARGS2: argc, executable path, padding, argc NUL-delimited argv,
    # environment, double NUL. Retitling leaves empty argv slots; do not discard
    # them before consuming argc, as ps does when displaying a process title.
    require(len(raw) >= 5, 'daemon process arguments unavailable')
    argc = int.from_bytes(raw[:4], sys.byteorder, signed=True)
    require(0 < argc <= 65536, 'daemon argument count invalid')
    offset = raw.find(b'\0', 4)
    require(offset > 4, 'daemon executable argument missing')
    offset += 1
    while offset < len(raw) and raw[offset] == 0: offset += 1
    for _ in range(argc):
        end = raw.find(b'\0', offset)
        require(end >= offset, 'daemon argument boundary unavailable')
        offset = end + 1
    while offset < len(raw) and raw[offset] == 0: offset += 1
    end = raw.find(b'\0\0', offset)
    require(end >= offset, 'daemon environment boundary unavailable')
    values = [token[len(b'PASEO_HOME='):] for token in raw[offset:end].split(b'\0')
              if token.startswith(b'PASEO_HOME=')]
    require(len(values) == 1 and bool(values[0]), 'daemon PASEO_HOME missing or ambiguous')
    return os.fsdecode(values[0])

def process_paseo_home(pid):
    # Observe only the already UID-checked PID. Retain only PASEO_HOME, never raw
    # arguments/environment or any credentials, in the observation or report.
    lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    lib.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                          ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                          ctypes.c_void_p, ctypes.c_size_t]
    lib.sysctl.restype = ctypes.c_int
    argmax_mib = (ctypes.c_int * 2)(1, 8)  # CTL_KERN, KERN_ARGMAX
    argmax = ctypes.c_int()
    argmax_size = ctypes.c_size_t(ctypes.sizeof(argmax))
    require(lib.sysctl(argmax_mib, 2, ctypes.byref(argmax), ctypes.byref(argmax_size), None, 0) == 0
            and 0 < argmax.value <= 2 * 1024 * 1024, 'daemon argument buffer size unavailable')
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    buf = ctypes.create_string_buffer(argmax.value)
    size = ctypes.c_size_t(len(buf))
    require(lib.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) == 0
            and 0 < size.value <= len(buf), 'daemon environment observation unavailable')
    return selected_home_from_procargs(buf.raw[:size.value])

def listener_ports(raw):
    lines = raw.splitlines()
    require(all(s.startswith('n') or re.fullmatch(r'p[0-9]+', s) for s in lines),
            'daemon listener observation malformed')
    pids = [int(s[1:]) for s in lines if s.startswith('p')]
    require(pids == [a.daemon_pid] or (a.fixture and not pids), 'daemon listener PID missing or ambiguous')
    names = [s[1:] for s in lines if s.startswith('n')]
    require(bool(names), 'daemon listeners unavailable')
    ports = set()
    for name in names:
        match = re.fullmatch(r'(127\.0\.0\.1|\[::1\]):([0-9]+)', name)
        require(match is not None, 'daemon listener must use a loopback literal')
        port = int(match.group(2))
        require(1024 <= port <= 65535 and port not in (6767, 6791), 'unsafe daemon listener port')
        ports.add(port)
        if port != a.port:
            require(match.group(1) == '127.0.0.1', 'bridge must use IPv4 loopback')
    require(a.port in ports and len(ports - {a.port}) <= 1,
            'expected selected port and at most one OpenCode bridge listener')
    return ports - {a.port}

def bridge_refusal(port):
    # OpenCodeBridge.start binds 127.0.0.1:0; route refuses every unauthenticated
    # request with exactly this response. Never send credentials, use proxies,
    # follow redirects or probe a port not already observed on the owned daemon.
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
    def timeout(signum, frame):
        raise ValueError('bridge refusal observation timed out')
    old_handler = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, 3)
    try:
        connection.request('GET', '/_internal/opencode/tools', headers={'Accept': 'application/json'})
        response = connection.getresponse()
        body = response.read(1025)
        require(len(body) <= 1024, 'bridge refusal response too large')
        require(response.status == 401 and json.loads(body) == {'error': 'Unauthorized'},
                'additional listener is not the expected refusing OpenCode bridge')
        return {'port': port, 'status': response.status, 'body': {'error': 'Unauthorized'}}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)
        connection.close()

def observe():
    if a.fixture:
        return json.loads(pathlib.Path(a.fixture).read_text())
    require(sys.platform == 'darwin', 'live mode requires macOS')
    home = pathlib.Path.home()
    data = {'uid': os.getuid(), 'home': str(home), 'launch': launch_inventory(home)}
    if a.capture_baseline: return data
    rows = command(['/bin/ps', '-axo', 'pid=,ppid=,uid=,command='])
    data['processes'] = []
    for line in rows.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) == 4:
            data['processes'].append(dict(zip(['pid','ppid','uid','command'],
                                             [int(parts[0]),int(parts[1]),int(parts[2]),parts[3]])))
    selected = [x for x in data['processes'] if x['pid'] == a.daemon_pid]
    require(len(selected) == 1 and selected[0]['uid'] == os.getuid(), 'daemon PID is not owned by test user')
    # Recheck UID/parent/start time and executable after observations to refuse a
    # vanished or replaced PID. This is still a snapshot, not an epoch handshake.
    anchor = command(['/bin/ps', '-p', str(a.daemon_pid), '-o', 'uid=,ppid=,lstart='])
    require(anchor.split()[:2] == [str(os.getuid()), str(selected[0]['ppid'])], 'daemon identity changed')
    data['daemon_executable'] = executable_path(a.daemon_pid)
    require(data['daemon_executable'] == entry(a.daemon_entry)
            and os.access(data['daemon_executable'], os.X_OK), 'daemon owner/executable mismatch')
    data['daemon_paseo_home'] = process_paseo_home(a.daemon_pid)
    data['open_files'] = command(['/usr/sbin/lsof', '-nP', '-u', str(os.getuid()), '-Fpn'])
    data['listeners'] = command(['/usr/sbin/lsof', '-nP', '-a', '-p', str(a.daemon_pid),
                                 '-iTCP', '-sTCP:LISTEN', '-Fn'], allow_empty=True)
    extra = listener_ports(data['listeners'])
    if extra: data['opencode_bridge'] = bridge_refusal(next(iter(extra)))
    require(command(['/bin/ps', '-p', str(a.daemon_pid), '-o', 'uid=,ppid=,lstart=']) == anchor
            and executable_path(a.daemon_pid) == data['daemon_executable'], 'daemon identity changed during observations')
    return data

app = pathlib.Path(a.app).absolute()
home_state = pathlib.Path(a.paseo_home).absolute()
protected = pathlib.Path(a.protected_home).absolute()
def entry(relative):
    require(bool(relative) and not pathlib.Path(relative).is_absolute(), 'V4 relative entry required')
    target = (app / relative).resolve()
    require(app.resolve() in target.parents and target.is_file(), 'entry missing or escapes bundle')
    return str(target)
obs = {}
def observations():
    global obs
    obs = observe()
    report.update(uid=obs['uid'], home=obs['home'], launch=obs['launch'])
    return 'collected; raw process environments and open-file lists are not saved'

def identity():
    require(obs['uid'] != 0, 'must run as a non-root test user')
    home = pathlib.Path(obs['home']).resolve()
    require(home != protected.resolve() and protected.resolve() not in home.parents, 'protected account selected')
    require(1024 <= a.port <= 65535 and a.port not in (6767, 6791), 'unsafe test port')
    for target in [app, home_state, pathlib.Path(a.report).absolute()]:
        resolved = target.resolve()
        require(home in resolved.parents, 'app, state and report must be within the test home')
        require(protected.resolve() not in resolved.parents, 'protected path selected')
    if not a.fixture:
        for value in [a.baseline, a.scanner, a.scan_reviews]:
            if value:
                require(home in pathlib.Path(value).resolve().parents, 'baseline/scanner must belong to test home')
    report.update(app=str(app), paseo_home=str(home_state), port=a.port)
    return 'test account, paths and port isolated'
# Validate paths/account before observing processes or scanning a bundle. Unsafe report
# locations are never written, even to record the rejection.
try:
    obs = (json.loads(pathlib.Path(a.fixture).read_text()) if a.fixture else
           {'uid': os.getuid(), 'home': str(pathlib.Path.home())})
    identity()
except Exception as e:
    print('FAIL isolation-inputs: ' + str(e)); sys.exit(1)
check('isolation-inputs', identity)
check('observations', observations)
if a.capture_baseline:
    check('pre-install', lambda: require(not app.exists() and not (home_state / 'command-centre').exists(),
                                       'capture baseline before installing or enabling'))
else:
    def bundle():
        home = pathlib.Path(obs['home']).resolve()
        require(app.parent.resolve() == home / 'Applications' and app.name == 'Fulcra.app', 'expected ~/Applications/Fulcra.app')
        require(not app.is_symlink() and app.is_dir(), 'app missing or symlinked')
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        name = info['CFBundleExecutable']
        require(isinstance(name, str) and name not in ('', '.', '..') and pathlib.Path(name).name == name, 'invalid bundle executable name')
        executable = app / 'Contents/MacOS' / name
        require(executable.resolve().parent == (app / 'Contents/MacOS').resolve(), 'bundle executable escapes MacOS directory')
        require(executable.is_file() and os.access(executable, os.X_OK), 'bundle executable missing/not executable')
        require(app.stat().st_uid == obs['uid'], 'app not owned by test user')
        return 'bundle present with executable'
    check('app-bundle', bundle)
    def process(pid):
        matches = [x for x in obs['processes'] if x['pid'] == pid]
        require(len(matches) == 1, 'PID missing or ambiguous')
        return matches[0]
    def names_entry(command_line, marker):
        # ps flattens argv: require boundaries, but retain the runbook's identity limitation.
        return re.search(r'(?:^|[\s\"\'])' + re.escape(marker) + r'(?=$|[\s\"\'])', command_line) is not None
    def daemon():
        proc = process(a.daemon_pid)
        marker = entry(a.daemon_entry)
        require(proc['uid'] == obs['uid'], 'daemon owner/entry mismatch')
        if 'daemon_executable' in obs:
            require(obs['daemon_executable'] == marker and os.access(marker, os.X_OK), 'daemon executable mismatch')
        else:
            # Backward-compatible OFFLINE fixtures only. A generic title never
            # meets this legacy entry predicate; live mode always uses libproc.
            require(a.fixture and names_entry(proc['command'], marker), 'daemon owner/entry mismatch')
        if 'daemon_paseo_home' in obs:
            require(obs['daemon_paseo_home'] == str(home_state), 'daemon PASEO_HOME not verified')
        else:
            env = obs.get('daemon_environment', '')
            matches = re.findall(r'(?:^|\s)PASEO_HOME=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)', env)
            require(a.fixture and matches == [str(home_state)], 'daemon PASEO_HOME not verified')
        extra = listener_ports(obs['listeners'])
        if extra:
            bridge = obs.get('opencode_bridge', {})
            require(bridge == {'port': next(iter(extra)), 'status': 401, 'body': {'error': 'Unauthorized'}},
                    'additional listener is not the expected refusing OpenCode bridge')
        else:
            require('opencode_bridge' not in obs, 'bridge observation without a listener')
        return 'test-owned bundled daemon; expected environment and loopback listener'
    check('daemon', daemon)
    def state():
        root = home_state / 'command-centre'
        require(root.is_dir() and not root.is_symlink(), 'state directory missing/symlinked')
        paths = [root]
        for base, dirs, files in os.walk(root, followlinks=False):
            paths.extend(pathlib.Path(base) / n for n in dirs + files)
        require((root / 'config.json').is_file(), 'first-run config missing')
        for f in paths:
            s = f.lstat()
            require(not stat.S_ISLNK(s.st_mode) and s.st_uid == obs['uid'], 'state ownership/symlink failure')
            expected = 0o700 if stat.S_ISDIR(s.st_mode) else 0o600
            require(stat.S_IMODE(s.st_mode) == expected, 'state modes must be 0700 directories / 0600 files and sockets')
        return str(len(paths)) + ' private state entries'
    check('state-modes', state)
    def child():
        proc = process(a.controller_pid)
        marker = entry(a.controller_entry)
        require(proc['uid'] == obs['uid'] and proc['ppid'] == a.daemon_pid and names_entry(proc['command'], marker),
                'controller must be direct test-owned daemon child')
        require(len([x for x in obs['processes'] if names_entry(x['command'], marker)]) == 1, 'multiple controller children')
        return 'one owned direct controller child (readiness is a separate trial step)'
    check('controller-child', child)
    def opened():
        names = [s[1:] for s in obs['open_files'].splitlines() if s.startswith('n')]
        require(bool(names), 'no open-file observations')
        root = str(protected)
        require(not any(n == root or n.startswith(root + '/') for n in names), 'test-user process opens protected home')
        require(not any(re.search(r':(?:6767|6791)(?:\D|$)', n) for n in names), 'test-user process touches a protected daemon port')
        return 'no protected-home files or protected ports observed in test-user processes; snapshot only'
    check('open-paths-and-ports', opened)
    def scan():
        require(bool(a.scanner), 'matching controller scanner required')
        scanner = pathlib.Path(a.scanner).resolve()
        require(scanner.name == 'v5-exact-audit.mjs' and scanner.is_file(), 'exact scanner unavailable')
        require(bool(a.scan_reviews), 'explicit exact reviewed-match file required')
        reviews = pathlib.Path(a.scan_reviews).resolve()
        report['scan_reviews_sha256'] = hashlib.sha256(reviews.read_bytes()).hexdigest()
        report['scanner_files'] = {name: hashlib.sha256((scanner.parent / name).read_bytes()).hexdigest()
            for name in ['v5-exact-audit.mjs', 'packaged-audit.mjs', 'no-machine-ties.mjs',
                         'portable-scope.mjs', 'packaged-review-policy.mjs', 'reviewed-pem-markers.json']}
        r = subprocess.run(['node', str(scanner), str(app), str(reviews)], capture_output=True, text=True, timeout=180)
        audit = json.loads(r.stdout)
        require(r.returncode == 0 and audit['passed'] is True and audit['files'] > 0
                and audit['unexempted'] == [] and audit['errors'] == [],
                'exact whole-bundle audit failed; inspect scanner separately')
        report['scan_receipt_sha256'] = hashlib.sha256(r.stdout.encode()).hexdigest()
        return {'files': audit['files'], 'reviewed_matches': len(audit['findings']),
                'unexempted': 0, 'errors': 0, 'confined_links_followed': True}
    check('whole-bundle-machine-ties', scan)
    def launch():
        require(bool(a.baseline), 'pre-install baseline required')
        b = json.loads(pathlib.Path(a.baseline).read_text())
        require(b['kind'] == 'baseline' and b['schema'] == 1 and b['mode'] == report['mode'], 'wrong baseline kind/mode')
        require(all(c['status'] == 'PASS' for c in b['checks']) and bool(b['checks']), 'baseline has failures')
        require(all(b[k] == report[k] for k in ['uid','home','app','paseo_home','port']), 'baseline belongs to another trial')
        require(b['launch'] == obs['launch'], 'launch registrations or files changed since baseline')
        return 'launch-agent/daemon files and current-user registered labels unchanged'
    check('no-launchd-additions', launch)
report['result'] = 'FAIL' if any(c['status'] == 'FAIL' for c in results) else 'PASS'
try:
    # Exclusive create, 0600, no symlink following; no other writes anywhere.
    fd = os.open(a.report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(report, f, indent=2); f.write('\n')
except Exception:
    print('FAIL report: cannot create new private report'); sys.exit(1)
print(report['mode'] + ': ' + report['result'])
sys.exit(1 if report['result'] == 'FAIL' else 0)
PY
