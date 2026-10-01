"""W1 state migration between the legacy two-service installation and the daemon-owned controller child (V4).
Run ONLY by the external one-shot operator, with BOTH services stopped (it refuses otherwise). Never run against live state
outside the approved window. Every step is recorded in a receipt (sha256 of every file it reads or writes).

  forward   current -> final. Reads the legacy controller home and portable home READ-ONLY and builds
            <PASEO_HOME>/command-centre (the V4 ORCA_HOME) from them:
              journal.sqlite  (SQLite online backup of the legacy journal; the legacy file is not modified)
              config.json     (version 2, synthesised from the legacy portable config.json: authority ids, providers,
                               local host; remote hosts only as given by --host)
              tasks.json, memory/, grants/, seat-sweep.mode (copies)
            and edits <PASEO_HOME>/config.json: the persisted `orca-organization-next` directory plugin entry is removed (in V4
            that id is distribution-owned, served from the app's bundled-plugins). The original is kept byte-exact first.
  Both directions first DISARM the V4 boot chain (review W1-1(c)): <PASEO_HOME>/daemon-boot.json removed, every
            <PASEO_HOME>/command-centre/boots/*.exit voided (renamed), so no boot can anchor across a release switch.
  rollback  final -> current. Restores <PASEO_HOME>/config.json byte-exact, moves <PASEO_HOME>/command-centre aside (never
            deleted: it holds everything V4 recorded, for reconciliation), and DISARMS the legacy human-input chain (removes
            <legacy home>/admission/human/armed-* markers): V4 boots write no legacy human-input log, so the legacy sweep must
            not vouch across the V4 window. The legacy journal is the pre-switch one: V4-period writes are NOT merged back.

  w1_migrate.py forward  --legacy-home DIR --portable-home DIR --paseo-home DIR --backup DIR [--host name=srv_ID@sshTarget ...] [--port N]
                         [--legacy-argv="--relay --no-mcp --no-inject-mcp --web-ui"]   (legacy launch flags -> config.json)
                         [--local-host mini]            (localHost.name; default keeps the live label; serverId from PASEO_HOME/server-id)
                         [--book-profile FILE]          (A1: live Book transport profile -> command-centre/book-transport.json;
                                                         its sshTarget must equal the --host macbook entry; the key stays in place)
                         [--legacy-tasks DIR]           (A3: owned task root beside command-centre/tasks -> task-roots.json;
                                                         default <legacy home>/tasks; nothing is moved)
                         [--outcomes-root DIR]          (config outcomesRoot: where published outcomes are read, e.g. the live
                                                         ORCA_OUTCOMES_DIR; shared memory stays in command-centre/memory)
                         [--memory-source DIR]          (the canonical shared-memory corpus, e.g. the legacy native memory's root
                                                         /path/to/shared-memory -> command-centre/memory, exact copy)
  w1_migrate.py carry-memory --paseo-home DIR --memory-source DIR --backup DIR [--refresh]   (correct an installation
                         migrated without its corpus; identical target = no-op; --refresh re-copies, old tree -> backup)
  w1_migrate.py rollback --legacy-home DIR --paseo-home DIR --backup DIR [--port N]
  w1_migrate.py disarm-v4-chain --legacy-home DIR --paseo-home DIR [--port N]   (any other V4 release switch)
  w1_migrate.py carry-defaults --legacy-home DIR --paseo-home DIR --backup DIR     (correct an installation migrated
                                                   before the X2 defaults carry; then restart the owned child)
  w1_migrate.py set-memory-root --paseo-home DIR --root DIR --backup DIR --bundle-exe FILE --bundle-entry FILE [--clear]
                         (DESIGN-NEXT-BUILD B1: point V4's shared memory at an existing canonical folder, e.g. the decisions
                          vault, instead of the command-centre/memory copy; --clear removes the setting. GATED: the installed
                          bundle's own portable-memory entry must start with the candidate config, so a bundle that does
                          not know the key -- and would refuse to start -- is never given it)
"""
import argparse, hashlib, json, os, re, shutil, socket, sqlite3, stat, subprocess, sys, tempfile, time
from pathlib import Path
JN = 'journal' + '.sqlite'


class Refused(Exception):
    pass


def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def write_private(path, data):
    path = Path(path); tmp = path.with_name(f'.{path.name}.w1-{os.getpid()}')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try: os.write(fd, data if isinstance(data, bytes) else data.encode()); os.fsync(fd)
    finally: os.close(fd)
    os.replace(tmp, path)


def port_free(port):
    try: socket.create_connection(('127.0.0.1', port), 0.5).close(); return False
    except OSError: return True


def stopped(legacy_home, paseo_home, port):
    """Both services must be down: no listener on the daemon port, no legacy controller socket, no live process lock owner."""
    if port and not port_free(port): raise Refused(f'the daemon port {port} is still served')
    # Review delta: the daemon's own pid lock (product pid-lock.ts, JSON {pid,...}), so the check holds without --port.
    pidfile = Path(paseo_home, 'paseo.pid')
    if pidfile.exists() or pidfile.is_symlink():
        try: pid = json.loads(pidfile.read_text()).get('pid')
        except Exception: raise Refused(f'{pidfile} is unreadable: cannot prove the daemon is stopped')
        if not isinstance(pid, int) or pid <= 0: raise Refused(f'{pidfile} names no pid: cannot prove the daemon is stopped')
        try: os.kill(pid, 0)
        except ProcessLookupError: pass
        except PermissionError: raise Refused(f'the daemon still runs: {pidfile} names live pid {pid}')
        else: raise Refused(f'the daemon still runs: {pidfile} names live pid {pid}')
    if Path(legacy_home, 'control.sock').exists(): raise Refused('the legacy controller socket still exists')
    for lock in (Path(legacy_home, 'process.lock'), Path(paseo_home, 'command-centre', 'process.lock')):
        if lock.exists():
            try: pid = json.loads(lock.read_text()).get('pid')
            except Exception: pid = None
            if pid:
                try: os.kill(int(pid), 0); raise Refused(f'{lock} is held by running pid {pid}')
                except ProcessLookupError: pass


def local_server_id(H):
    try: value = (H / 'server-id').read_text().strip()
    except OSError: return None
    return value if re.fullmatch(r'srv_[A-Za-z0-9_-]{8,64}', value) else None


def private_file(p, what, limit):
    st = os.lstat(p)
    if os.path.realpath(p) != str(p) or not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077 or st.st_size > limit:
        raise Refused(f'{what} must be a private regular file this user owns: {p}')


def book_profile(file, hosts):
    # A1: the live Book transport profile, copied (never edited) into ORCA_HOME. Its key stays where it is; the controller pins the
    # ssh target to the configured Book host, so the two must agree before anything is written.
    private_file(file, 'the Book transport profile', 16384)
    raw = Path(file).read_bytes(); p = json.loads(raw)
    if sorted(p) != ['command', 'controller', 'host', 'keyFile', 'sshTarget'] or p['host'] != 'macbook': raise Refused('unsupported Book transport profile')
    book = [h for h in hosts if h['name'] == 'macbook']
    if len(book) != 1 or book[0]['sshTarget'] != p['sshTarget']: raise Refused('the Book profile ssh target must equal the --host macbook entry')
    if not os.path.isabs(p['keyFile']): raise Refused('the Book key file must be absolute')
    private_file(p['keyFile'], 'the Book key file', 4096)
    return raw


# X2 installation defaults (the legacy controller's <legacy home>/session-defaults.json) -> V4 config.json `defaults`.
# Only what V4 reads from that file: thinkingOptionId and the per-provider modes, validated as V4 would at spawn
# (orca-organization/server/config.mjs and provider-mode.mjs SUPPORTED_MODES minus REFUSED), so the migration never
# writes a config the controller refuses. The legacy file is only read; rollback leaves it exactly as it was.
THINKING = ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
SELECTABLE_MODES = {'claude': ('plan', 'default', 'acceptEdits', 'auto'), 'codex': ('auto', 'auto-review')}


def legacy_defaults(L):
    f = Path(L) / 'session-defaults.json'
    if not f.exists(): return None, None
    try: doc = json.loads(f.read_text())
    except Exception: raise Refused(f'{f} is not valid JSON')
    d = doc.get('defaults') if isinstance(doc, dict) and doc.get('version') == 1 else None
    if not isinstance(d, dict): raise Refused(f'{f} is not a version-1 session-defaults file')
    out = {}
    if 'thinkingOptionId' in d:
        if d['thinkingOptionId'] not in THINKING: raise Refused(f'{f}: thinkingOptionId {d["thinkingOptionId"]!r} is not one V4 accepts')
        out['thinkingOptionId'] = d['thinkingOptionId']
    if 'modes' in d:
        m = d['modes']
        if not isinstance(m, dict) or set(m) - set(SELECTABLE_MODES): raise Refused(f'{f}: modes must name only claude/codex')
        for provider, mode in m.items():
            if mode not in SELECTABLE_MODES[provider]: raise Refused(f'{f}: mode {mode!r} is not selectable for {provider} under V4')
        out['modes'] = {p: m[p] for p in ('claude', 'codex') if p in m}
    return out, sha(f)


BOOT_RECORD = re.compile(r'^daemon-boot\.json(\.[0-9a-f-]{36}\.tmp)?$')


def disarm_v4_chain(H, cc):
    """Review W1-1(c): every V4 release switch breaks the owned daemon's boot chain, mirroring the legacy
    disarmHumanChain. With the daemon stopped: remove <PASEO_HOME>/daemon-boot.json (and its temporary siblings), so the
    next boot names no predecessor, and void every <ORCA_HOME>/boots/*.exit (renamed, never deleted), so no later boot
    can anchor across the switch. Seats granted before it then decline at the sweep instead of skipping the boots that
    ran on the other release. Returns (removed, voided)."""
    removed = [n for n in sorted(os.listdir(H)) if BOOT_RECORD.match(n) and (H / n).is_file() and not (H / n).is_symlink()]
    for n in removed: os.unlink(H / n)
    fd = os.open(H, os.O_RDONLY); os.fsync(fd); os.close(fd)
    voided, boots, ts = [], cc / 'boots', int(time.time() * 1000)
    if boots.is_symlink() or cc.is_symlink(): raise Refused(f'{boots} (or its home) is a symlink: refusing to void seals through it')
    if boots.is_dir():
        voided = [n for n in sorted(os.listdir(boots)) if n.endswith('.exit')]
        for n in voided: os.rename(boots / n, boots / f'{n}.void-{ts}')
        fd = os.open(boots, os.O_RDONLY); os.fsync(fd); os.close(fd)
    return removed, voided


def forward(a):
    L, H, B = map(Path, (a.legacy_home, a.paseo_home, a.backup)); P = Path(a.portable_home) if a.portable_home else None
    if P is None and not (a.authority_company and a.authority_programme and a.issue_api):
        raise Refused('a non-portable legacy controller needs --authority-company, --authority-programme and --issue-api (its authority.mjs constants and issue API)')
    stopped(L, H, a.port)
    cc = H / 'command-centre'
    if cc.exists(): raise Refused(f'{cc} already exists: refusing to overwrite V4 state')
    if B.exists() and any(B.iterdir()): raise Refused(f'--backup must be new or empty: {B}')
    hosts = []
    for spec in a.host or []:
        name, rest = spec.split('=', 1); server, target = rest.split('@', 1)
        hosts.append({'name': name, 'serverId': server, 'sshTarget': target})
    # Everything that can refuse is checked before the first write.
    book = book_profile(a.book_profile, hosts) if a.book_profile else None
    legacy_tasks = os.path.realpath(a.legacy_tasks or str(L / 'tasks'))
    if legacy_tasks != (a.legacy_tasks or str(L / 'tasks')) or not os.path.isdir(legacy_tasks) or os.stat(legacy_tasks).st_uid != os.getuid():
        raise Refused(f'the legacy tasks directory must be an existing canonical folder this user owns: {legacy_tasks}')
    outcomes_root = None
    if a.outcomes_root:
        outcomes_root = os.path.realpath(a.outcomes_root)
        if outcomes_root != a.outcomes_root or not os.path.isdir(outcomes_root): raise Refused(f'--outcomes-root must be an existing canonical folder: {a.outcomes_root}')
    carried, carried_sha = legacy_defaults(L)
    # DESIGN-NEXT-BUILD A5: role defaults only when given; forward never invents them.
    role_defaults = None
    if a.role_defaults:
        try: role_defaults = json.loads(a.role_defaults)
        except ValueError: raise Refused('--role-defaults must be a JSON object')
        validate_roles(role_defaults, '--role-defaults')
    B.mkdir(parents=True, exist_ok=True, mode=0o700); os.chmod(B, 0o700)
    r = {'direction': 'forward', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'steps': []}
    step = lambda name, **k: (r['steps'].append({'step': name, **k}), print(json.dumps({'step': name, **k}), flush=True))
    t0 = time.monotonic()
    removed, voided = disarm_v4_chain(H, cc); step('V4 boot chain disarmed (release switch)', recordsRemoved=removed, sealsVoided=len(voided))
    cfg_raw = (H / 'config.json').read_bytes(); write_private(B / 'paseo-config.json.orig', cfg_raw)
    step('backup PASEO_HOME/config.json', sha256=hashlib.sha256(cfg_raw).hexdigest())
    legacy_journal_sha = sha(L / JN)
    cc.mkdir(mode=0o700); os.chmod(cc, 0o700)
    src = sqlite3.connect(f'file:{L / JN}?mode=ro', uri=True); dst = sqlite3.connect(cc / JN)
    with dst: src.backup(dst)
    src.close(); dst.close(); os.chmod(cc / JN, 0o600)
    if sha(L / JN) != legacy_journal_sha: raise Refused('the legacy journal changed during the copy')
    check = sqlite3.connect(f'file:{cc / JN}?mode=ro', uri=True); ok = check.execute('PRAGMA integrity_check').fetchone()[0]; tables = check.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]; check.close()
    if ok != 'ok': raise Refused(f'the copied journal failed its integrity check: {ok}')
    step('journal copied (online backup; legacy journal unchanged)', legacySha256=legacy_journal_sha, tables=tables, integrity=ok)
    # Portable legacy controller: its ORCA_HOME config. Non-portable (the live one): authority.mjs's constants and the issue
    # API base URL (V4 fetches <issueApi>/api/issues/<id>; null would mean local tasks.json).
    legacy = json.loads((P / 'config.json').read_text()) if P else {'authority': {'companyId': a.authority_company, 'programmeId': a.authority_programme, 'issueApi': a.issue_api}}
    v2 = {'version': 2, 'daemon': {'url': None},
          'authority': {'companyId': legacy['authority']['companyId'], 'programmeId': legacy['authority']['programmeId'], 'issueApi': legacy['authority'].get('issueApi')},
          'providers': {'claude': legacy.get('providers', {}).get('claude', 'claude'), 'codex': legacy.get('providers', {}).get('codex', 'codex')},
          'hosts': hosts, 'localHost': {'name': a.local_host, 'serverId': local_server_id(H)}, 'defaults': {}, 'artifacts': {}}
    # Live parity: the legacy labels (mini/macbook) are kept, so every 'mini'/'macbook' rule (creation hosts, team resumption,
    # FD-1b labels) behaves as it does today. Published outcomes stay where the live controller read them (ORCA_OUTCOMES_DIR).
    if outcomes_root: v2['outcomesRoot'] = outcomes_root
    if carried:
        v2['defaults'].update(carried)
        step('installation defaults carried from the legacy session-defaults.json', thinkingOptionId=carried.get('thinkingOptionId'), modes=carried.get('modes'), sourceSha256=carried_sha)
    if role_defaults:
        v2['defaults']['roles'] = role_defaults; step('role defaults written', roles=sorted(role_defaults))
    write_private(cc / 'config.json', json.dumps(v2, indent=2) + '\n'); step('config.json v2 written', localHost=v2['localHost']['name'], hosts=[h['name'] for h in hosts], outcomesRoot=v2.get('outcomesRoot'))
    if book is not None:
        write_private(cc / 'book-transport.json', book); step('Book transport profile pinned', file='book-transport.json', keyFile=os.path.basename(json.loads(book)['keyFile']))
    # A3: running sessions keep their cwd. The legacy tasks directory is an owned task root beside <ORCA_HOME>/tasks; nothing moves.
    write_private(cc / 'task-roots.json', json.dumps({'version': 1, 'roots': [legacy_tasks]}, indent=2) + '\n'); step('owned task roots written', file='task-roots.json', roots=[str(cc / 'tasks'), legacy_tasks])
    if P and (P / 'tasks.json').exists(): shutil.copyfile(P / 'tasks.json', cc / 'tasks.json'); os.chmod(cc / 'tasks.json', 0o600); step('tasks.json copied', sha256=sha(cc / 'tasks.json'))
    else: write_private(cc / 'tasks.json', json.dumps({'version': 1, 'issues': [], 'projects': []}) + '\n'); step('tasks.json created empty (issues come from the issue API)')
    if getattr(a, 'memory_source', None):
        # W1 E3: the live corpus was the legacy native memory's root, not a portable-home memory/. Exactly one source.
        if P and (P / 'memory').is_dir(): raise Refused('both --portable-home memory/ and --memory-source given: choose one corpus')
        m = carry_memory_tree(a.memory_source, cc, B); step('canonical shared memory carried into command-centre/memory', **{k: v for k, v in m.items() if k != 'target'})
    for src_dir, name in (((P / 'memory') if P else None, 'memory'), (L / 'grants', 'grants')):
        if src_dir is None: continue
        if src_dir.is_dir():
            subprocess.run(['/bin/cp', '-cRPp', str(src_dir), str(cc / name)], check=True); step(f'{name}/ copied', files=sum(len(f) for _, _, f in os.walk(cc / name)))
    if book is not None and a.book_key_into_home:
        # Review item 3 (W1-PROCEDURES F3/F9): the Book key moves under <ORCA_HOME>/grants/, which the frozen privateDenyRules
        # already deny to agents (grants/** and Bash(*<home>/grants*)); the profile's keyFile is pinned there. Every other
        # profile value is unchanged; the source key is not modified (the legacy release keeps using it on rollback).
        prof = json.loads(book); src_key = prof['keyFile']; kdir = cc / 'grants' / 'book'
        kdir.mkdir(parents=True, exist_ok=True, mode=0o700); os.chmod(cc / 'grants', 0o700); os.chmod(kdir, 0o700)
        write_private(kdir / 'transport.secret', Path(src_key).read_bytes())
        prof['keyFile'] = str(kdir / 'transport.secret')
        write_private(cc / 'book-transport.json', json.dumps(prof, indent=2) + '\n')
        step('Book key moved under the denied grants/ path', file='grants/book/transport.secret', profile='book-transport.json')
    if (L / 'seat-sweep.mode').exists():
        shutil.copyfile(L / 'seat-sweep.mode', cc / 'seat-sweep.mode'); os.chmod(cc / 'seat-sweep.mode', 0o600); step('seat-sweep.mode copied', mode=(cc / 'seat-sweep.mode').read_text().strip())
    cfg = json.loads(cfg_raw); removed = (cfg.get('plugins') or {}).pop('orca-organization-next', None)
    # The legacy daemon took these as launch flags; the packaged (owned-child) daemon takes none, so they move into its config.
    flags = {'--relay': ('daemon.relay.enabled', True), '--no-relay': ('daemon.relay.enabled', False), '--mcp': ('daemon.mcp.enabled', True),
             '--no-mcp': ('daemon.mcp.enabled', False), '--inject-mcp': ('daemon.mcp.injectIntoAgents', True), '--no-inject-mcp': ('daemon.mcp.injectIntoAgents', False),
             '--web-ui': ('features.webUi.enabled', True), '--no-web-ui': ('features.webUi.enabled', False)}
    applied = {}
    for flag in (a.legacy_argv or '').split():
        if flag not in flags: raise Refused(f'unknown legacy daemon flag {flag}')
        key, value = flags[flag]; node = cfg
        for part in key.split('.')[:-1]: node = node.setdefault(part, {})
        node[key.split('.')[-1]] = value; applied[key] = value
    if applied: step('legacy launch flags moved into PASEO_HOME/config.json', applied=applied)
    write_private(H / 'config.json', json.dumps(cfg, indent=2) + '\n')
    step('PASEO_HOME/config.json: persisted orca-organization-next entry removed (distribution-owned in V4)', removed=bool(removed), sha256=sha(H / 'config.json'))
    r['ms'] = round((time.monotonic() - t0) * 1000); write_private(B / 'forward-receipt.json', json.dumps(r, indent=1)); return r


def rollback(a):
    L, H, B = map(Path, (a.legacy_home, a.paseo_home, a.backup))
    stopped(L, H, a.port)
    orig = B / 'paseo-config.json.orig'
    if not orig.exists(): raise Refused('no forward backup to roll back to')
    r = {'direction': 'rollback', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'steps': []}
    step = lambda name, **k: (r['steps'].append({'step': name, **k}), print(json.dumps({'step': name, **k}), flush=True))
    t0 = time.monotonic()
    write_private(H / 'config.json', orig.read_bytes())
    if sha(H / 'config.json') != sha(orig): raise Refused('PASEO_HOME/config.json restore is not byte-exact')
    step('PASEO_HOME/config.json restored byte-exact', sha256=sha(orig))
    cc = H / 'command-centre'
    removed, voided = disarm_v4_chain(H, cc); step('V4 boot chain disarmed (release switch)', recordsRemoved=removed, sealsVoided=len(voided))
    if cc.exists():
        kept = B / f'command-centre-after-final-{time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())}'
        os.rename(cc, kept); step('V4 state moved aside (kept for reconciliation, never deleted)', kept=str(kept))
    human = L / 'admission' / 'human'; removed = []
    if human.is_dir():
        for n in sorted(os.listdir(human)):
            if n.startswith('armed-'): os.unlink(human / n); removed.append(n)
        fd = os.open(human, os.O_RDONLY); os.fsync(fd); os.close(fd)
    step('legacy human-input chain disarmed (V4 boots are invisible to it)', markersRemoved=len(removed))
    r['ms'] = round((time.monotonic() - t0) * 1000); write_private(B / 'rollback-receipt.json', json.dumps(r, indent=1)); return r


def carry_defaults(a):
    """Live correction for an installation migrated before the carry existed: write the X2 defaults into the EXISTING
    <PASEO_HOME>/command-centre/config.json `defaults` (other keys kept). The old file is backed up first; re-running
    with the same values writes nothing. The controller reads it at start: restart the owned child afterwards."""
    L, H, B = Path(a.legacy_home), Path(a.paseo_home), Path(a.backup)
    receipt = {'step': 'carry-defaults', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    try:
        out = _carry_defaults(L, H, B, receipt); receipt.update(out, outcome='changed' if out.get('changed') else 'unchanged'); return out
    except Refused as e:
        receipt.update(outcome='refused', refused=str(e)); raise
    finally:
        # Review W1-REBUILD finding 5(c): every outcome leaves a receipt beside the backup, not only stdout.
        B.mkdir(parents=True, exist_ok=True, mode=0o700); os.chmod(B, 0o700)
        write_private(B / 'carry-defaults-receipt.json', json.dumps(receipt, indent=1) + '\n')


def _carry_defaults(L, H, B, receipt):
    cfg = H / 'command-centre' / 'config.json'
    if not cfg.exists(): raise Refused(f'{cfg} does not exist: nothing migrated to correct')
    carried, carried_sha = legacy_defaults(L)
    if not carried: raise Refused('no legacy session-defaults.json defaults to carry')
    before = cfg.read_bytes(); v2 = json.loads(before)
    if v2.get('version') != 2 or not isinstance(v2.get('defaults'), dict): raise Refused(f'{cfg} is not a V4 version-2 config with a defaults object')
    want = {**v2['defaults'], **carried}
    out = {'step': 'installation defaults carried into command-centre/config.json', 'thinkingOptionId': carried.get('thinkingOptionId'), 'modes': carried.get('modes'), 'sourceSha256': carried_sha, 'configSha256Before': sha(cfg)}
    if want == v2['defaults']: out['changed'] = False
    else:
        B.mkdir(parents=True, exist_ok=True, mode=0o700); os.chmod(B, 0o700)
        bk = B / 'command-centre-config.json.pre-defaults'
        if bk.exists(): raise Refused(f'{bk} exists: use a fresh --backup')
        write_private(bk, before)
        receipt['backup'] = str(bk)
        v2['defaults'] = want; write_private(cfg, json.dumps(v2, indent=2) + '\n')
        if json.loads(cfg.read_text())['defaults'] != want:
            # Review W1-REBUILD finding 5(b): never leave a changed-but-unverified config behind; restore the pre-step bytes first.
            write_private(cfg, before); restored = cfg.read_bytes() == before
            receipt.update(restored=restored, configSha256After=sha(cfg))
            raise Refused(f'the defaults did not read back as written; pre-step config {"restored" if restored else "NOT restored"} from {bk}')
        out.update(changed=True, backup=str(bk))
    out['configSha256After'] = sha(cfg)
    print(json.dumps(out), flush=True); return out


def tree_digest(root):
    """(files, bytes, sha256 over sorted (relative path, kind, file sha256)) of a memory tree; refuses symlinks and specials."""
    root = Path(root); rows = []; files = size = 0
    for base, dirs, names in os.walk(root, followlinks=False):
        dirs.sort()
        for n in sorted(dirs + names):
            p = Path(base) / n; st = os.lstat(p); rel = str(p.relative_to(root))
            if stat.S_ISLNK(st.st_mode): raise Refused(f'memory tree contains a symlink: {rel}')
            if stat.S_ISDIR(st.st_mode): rows.append(f'd {rel}')
            elif stat.S_ISREG(st.st_mode): rows.append(f'f {rel} {sha(p)}'); files += 1; size += st.st_size
            else: raise Refused(f'memory tree contains a special file: {rel}')
    return files, size, hashlib.sha256('\n'.join(sorted(rows)).encode()).hexdigest()


def carry_memory_tree(src, cc, backup, refresh=False):
    """The canonical shared-memory corpus -> <ORCA_HOME>/memory (V4's fixed memoryRoot), as an exact private copy:
    regular files 0600, directories 0700, no symlinks, per-file digests verified; atomic rename into place. The legacy
    corpus stays where it is and is only read. Identical target: unchanged. A differing target needs refresh, which moves
    the old tree into the backup first."""
    src = str(src)
    if not os.path.isabs(src) or os.path.realpath(src) != src or not os.path.isdir(src): raise Refused(f'--memory-source must be an existing canonical folder: {src}')
    want = tree_digest(src); dst = Path(cc) / 'memory'; out = {'source': src, 'files': want[0], 'bytes': want[1], 'treeSha256': want[2]}
    if dst.exists() or dst.is_symlink():
        if dst.is_symlink() or not dst.is_dir(): raise Refused(f'{dst} exists and is not a directory')
        if any(dst.iterdir()):
            if tree_digest(dst) == want: out['changed'] = False; return out
            if not refresh: raise Refused(f'{dst} exists with a different corpus: use --refresh (the old tree is moved into the backup)')
            B = Path(backup); B.mkdir(parents=True, exist_ok=True, mode=0o700); aside = B / f'memory-before-{time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())}'
            if aside.exists(): raise Refused(f'{aside} exists: use a fresh --backup')
            os.rename(dst, aside); out['previousMovedTo'] = str(aside)
        else: dst.rmdir()
    tmp = Path(cc) / f'.memory.carry-{os.getpid()}'
    if tmp.exists(): raise Refused(f'{tmp} exists')
    subprocess.run(['/bin/cp', '-RPp', src, str(tmp)], check=True)   # -p: mtimes kept (search ranks ties by mtime)
    for base, dirs, names in os.walk(tmp, followlinks=False):
        os.chmod(base, 0o700)
        for n in names: os.chmod(Path(base) / n, 0o600)
    if tree_digest(tmp) != want:
        shutil.rmtree(tmp); raise Refused('the copied memory tree does not match the source digest (source changed during the copy?); nothing installed')
    os.rename(tmp, dst); out.update(changed=True, target=str(dst))
    if tree_digest(dst) != want: raise Refused('installed memory tree does not read back as copied')
    return out


def carry_memory(a):
    """Live correction for an installation migrated without its canonical shared-memory corpus (W1: the legacy native
    memory served /path/to/shared-memory; V4 serves <ORCA_HOME>/memory, and forward copied only a
    portable-home memory/). Writes a receipt beside the backup for every outcome."""
    H, B = Path(a.paseo_home), Path(a.backup); cc = H / 'command-centre'
    receipt = {'step': 'carry-memory', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    try:
        if not (cc / 'config.json').exists(): raise Refused(f'{cc} is not a migrated V4 home')
        out = carry_memory_tree(a.memory_source, cc, B, a.refresh); out['step'] = 'canonical shared memory carried into command-centre/memory'
        receipt.update(out, outcome='changed' if out.get('changed') else 'unchanged'); print(json.dumps(out), flush=True); return out
    except Refused as e:
        receipt.update(outcome='refused', refused=str(e)); raise
    finally:
        B.mkdir(parents=True, exist_ok=True, mode=0o700); os.chmod(B, 0o700)
        write_private(B / 'carry-memory-receipt.json', json.dumps(receipt, indent=1) + '\n')


def bundle_accepts(candidate, exe, entry):
    """The ordering hazard (MEMORY-DEFECT section 2): the controller's loadConfig refuses unknown keys, so a config.json
    carrying a new setting must only be written once a bundle that accepts it is installed. Rather than trusting a
    version label, start the INSTALLED bundle's own portable-memory entry (the executable a V4 session is given,
    ELECTRON_RUN_AS_NODE=1) against a scratch private ORCA_HOME holding the candidate config: its module load runs the
    bundle's own validateConfig, so an older bundle exits with 'Unknown setting ...' and a newer one answers MCP
    initialize. The scratch home is removed afterwards; nothing else is read or written."""
    for f, what in ((exe, '--bundle-exe'), (entry, '--bundle-entry')):
        if not f or not os.path.isabs(f) or not os.path.isfile(f): raise Refused(f'{what} must name the installed bundle file: {f}')
    tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix='w1-bundle-gate-')))
    try:
        os.chmod(tmp, 0o700); write_private(tmp / 'config.json', json.dumps(candidate, indent=2) + '\n')
        req = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'w1-bundle-gate', 'version': '1'}}}
        env = {'ELECTRON_RUN_AS_NODE': '1', 'ORCA_HOME': str(tmp), 'ORCA_MEMORY_CLIENT': 'local', 'PATH': '/usr/bin:/bin'}
        try: r = subprocess.run([exe, entry], input=json.dumps(req) + '\n', capture_output=True, text=True, env=env, timeout=60)
        except subprocess.TimeoutExpired: return False, 'the bundle entry did not answer within 60 s'
        answered = any(isinstance(m, dict) and m.get('id') == 1 and 'result' in m for m in (_json_or_none(l) for l in r.stdout.splitlines()))
        lines = [l.strip() for l in r.stderr.splitlines() if l.strip()]
        why = next((l for l in lines if re.match(r'^[A-Za-z]*Error\b', l)), lines[-1] if lines else '')
        return answered, why[:300]
    finally: shutil.rmtree(tmp, ignore_errors=True)


# L44 (29 Sep): writing memoryRoot stopped every running tool server of an older build -- their config reader threw on
# the key -- although the live bundle accepted it. So a new setting is also dry-run-loaded by EVERY running process that
# reads this installation's config (its environment names ORCA_HOME=<PASEO_HOME>/command-centre) and by the conversation
# launcher's target, each with its own executable and its own code, in a scratch home. Any refusal refuses the write and
# names the refusing bundles and the sessions holding them. Nothing live is read beyond the process table and the
# launcher script; the probes run in scratch homes only.
LAUNCHER = os.path.expanduser('~/.local/share/orca-conversation/bin/orca-conversation')
CONFIG_ERROR = re.compile(r'(?:Error: )((?:Unknown|Invalid|Missing) setting [^\n"`$]+|Invalid portable configuration[^\n"]*)')


def _ps(*args):
    r = subprocess.run(['/bin/ps', *args], capture_output=True, text=True); return r.stdout if r.returncode == 0 else ''


def _session_of(pid):
    """The agent CLI above a tool server: its native session id (claude --resume=<id>) and the paseo agent id, if any."""
    env = _ps('eww', '-o', 'command=', '-p', str(pid)); m = re.search(r'\bPASEO_AGENT_ID=(\S+)', env)
    out = {'pid': pid, 'agent': m.group(1) if m else None, 'cli': None, 'nativeSession': None}
    p = pid
    for _ in range(12):
        line = _ps('-o', 'ppid=,command=', '-p', str(p)).strip()
        if not line: break
        ppid, _, cmd = line.partition(' '); ppid = int(ppid)
        if ppid <= 1: break
        pcmd = _ps('-o', 'command=', '-p', str(ppid)).strip()
        tool = os.path.basename(pcmd.split(' ', 1)[0])
        if tool in ('claude', 'codex'):
            r = re.search(r'--resume[= ]([0-9a-f-]{36})', pcmd) or re.search(r'\bresume ([0-9a-f-]{36})', pcmd)
            a = re.search(r'\bPASEO_AGENT_ID=(\S+)', _ps('eww', '-o', 'command=', '-p', str(ppid)))
            out.update(cli=tool, cliPid=ppid, nativeSession=r.group(1) if r else None, agent=out['agent'] or (a.group(1) if a else None)); break
        p = ppid
    return out


def _probe_kind(script):
    if script.endswith('/src/portable-memory/entry.mjs') or script.endswith('/src/control/inbox.mjs') or script.endswith('/src/control/delegated.mjs'): return 'mcp', script
    for marker in ('/orca-conversation/', '/orca-ingress/', '/src/'):
        if marker in script:
            root = script[:script.index(marker)]
            if os.path.isfile(os.path.join(root, 'src/config.mjs')): return 'loader', os.path.join(root, 'src/config.mjs')
    if '/bundled-plugins/orca-organization-next/' in script:
        root = script[:script.index('/bundled-plugins/orca-organization-next/')] + '/bundled-plugins/orca-organization-next'
        return 'mcp', os.path.join(root, 'src/portable-memory/entry.mjs')
    return None, script


def config_readers(cc, launcher=LAUNCHER):
    """Running readers of <cc>/config.json, grouped by (executable, probed code), with the sessions holding each."""
    groups = {}
    for line in _ps('-axww', '-o', 'pid=,command=').splitlines():
        pid_s, _, cmd = line.strip().partition(' ')
        parts = cmd.split()
        if len(parts) < 2 or not parts[1].endswith('.mjs') or not pid_s.isdigit(): continue
        env = _ps('eww', '-o', 'command=', '-p', pid_s)
        m = re.search(r'\bORCA_HOME=(\S+)', env)
        if not m or m.group(1) != str(cc): continue
        kind, target = _probe_kind(parts[1])
        g = groups.setdefault((parts[0], target), {'kind': kind, 'exe': parts[0], 'code': target, 'scripts': set(), 'holders': []})
        g['scripts'].add(parts[1]); g['holders'].append(_session_of(int(pid_s)))
    if launcher and os.path.isfile(launcher):
        text = Path(launcher).read_text(errors='replace')
        home = re.search(r"ORCA_HOME='?([^'\n]+)'?", text); ex = re.search(r'^exec (\S+) (\S+)', text, re.M)
        if ex and home and home.group(1) == str(cc):
            kind, target = _probe_kind(ex.group(2))
            g = groups.setdefault((ex.group(1), target), {'kind': kind, 'exe': ex.group(1), 'code': target, 'scripts': set(), 'holders': []})
            g['scripts'].add(ex.group(2)); g['holders'].append({'launcher': launcher})
    return [{**g, 'scripts': sorted(g['scripts'])} for g in groups.values()]


def probe_config(reader, config):
    """Does this reader's own code, under its own executable, load `config`? (accepted, detail) -- scratch home only."""
    tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix='w1-fleet-gate-')))
    try:
        os.chmod(tmp, 0o700); cc = tmp / 'cc'; cc.mkdir(mode=0o700)
        write_private(cc / 'config.json', json.dumps(config, indent=2) + '\n'); write_private(cc / 'tasks.json', json.dumps({'version': 1, 'issues': [], 'projects': []}) + '\n')
        env = {'ELECTRON_RUN_AS_NODE': '1', 'ORCA_HOME': str(cc), 'ORCA_MEMORY_CLIENT': 'local', 'HOME': str(tmp), 'TMPDIR': str(tmp) + '/', 'PATH': '/usr/bin:/bin'}
        if reader['kind'] == 'loader':
            code = 'const m = await import(process.argv[1]); m.loadConfig({ ORCA_HOME: process.argv[2] }); console.log("config-accepted")'
            argv, stdin = [reader['exe'], '--input-type=module', '-e', code, Path(reader['code']).as_uri(), str(cc)], ''
        elif reader['kind'] == 'mcp':
            req = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'w1-fleet-gate', 'version': '1'}}}
            argv, stdin = [reader['exe'], reader['code']], json.dumps(req) + '\n'
        else: return False, f'no probe for {reader["code"]}'
        try: r = subprocess.run(argv, input=stdin, capture_output=True, text=True, env=env, timeout=60)
        except subprocess.TimeoutExpired: return False, 'probe did not answer within 60 s'
        except OSError as e: return False, f'probe could not start: {e}'
        err = CONFIG_ERROR.search(r.stderr + r.stdout)
        if reader['kind'] == 'loader': ok = r.returncode == 0 and 'config-accepted' in r.stdout
        else: ok = any(isinstance(m, dict) and m.get('id') == 1 and 'result' in m for m in (_json_or_none(l) for l in r.stdout.splitlines()))
        return ok and not err, (err.group(1) if err else ('' if ok else (r.stderr.strip().splitlines() or [''])[-1]))[:300]
    finally: shutil.rmtree(tmp, ignore_errors=True)


def fleet_gate(candidate, cc, readers=None, launcher=LAUNCHER):
    """Probe every reader with the candidate config; returns (blockers, report)."""
    readers = config_readers(cc, launcher) if readers is None else readers
    report = []
    for g in readers:
        ok, detail = probe_config(g, candidate)
        report.append({'exe': g['exe'], 'code': g['code'], 'kind': g['kind'], 'accepted': ok, 'detail': detail, 'holders': g['holders'], 'scripts': g['scripts']})
    return [x for x in report if not x['accepted']], report


def _json_or_none(line):
    try: return json.loads(line)
    except ValueError: return None


FLEET_READERS = None   # test/offline only: a JSON file listing the readers to probe instead of scanning the process table


def set_config_key(H, B, key, value, clear, exe, entry, backup_name, receipt):
    """Set (or with clear, remove) one optional top-level key of <PASEO_HOME>/command-centre/config.json, every other key
    kept byte-for-byte in value. Gated by bundle_accepts; backed up; read back; restored on any read-back mismatch."""
    cfg = H / 'command-centre' / 'config.json'
    if not cfg.exists(): raise Refused(f'{cfg} does not exist: not a migrated V4 home')
    before = cfg.read_bytes(); v2 = json.loads(before)
    if v2.get('version') != 2: raise Refused(f'{cfg} is not a V4 version-2 config')
    want = {k: v for k, v in v2.items() if k != key} if clear else {**v2, key: value}
    out = {'key': key, 'clear': clear, 'value': None if clear else value, 'configSha256Before': sha(cfg)}
    if want == v2: out.update(changed=False, configSha256After=sha(cfg)); return out
    ok, why = bundle_accepts(want, exe, entry)
    receipt['bundleGate'] = {'exe': exe, 'entry': entry, 'entrySha256': sha(entry), 'accepted': ok, 'detail': why}
    if not ok: raise Refused(f'the installed bundle does not accept this config ({why or "no answer"}): install a bundle that knows `{key}` first; nothing written')
    if not clear:
        readers = json.loads(Path(FLEET_READERS).read_text()) if FLEET_READERS else None
        blockers, report = fleet_gate(want, H / 'command-centre', readers)
        receipt['fleetGate'] = {'readers': len(report), 'refused': len(blockers), 'report': report}
        if blockers:
            names = '; '.join(f"{b['code']} ({len(b['holders'])} holder(s): {', '.join((h.get('nativeSession') or h.get('agent') or h.get('launcher') or str(h.get('pid')))[:36] for h in b['holders'])}): {b['detail']}" for b in blockers)
            raise Refused(f'{len(blockers)} running reader(s) of this config would refuse it; nothing written: {names}')
    B.mkdir(parents=True, exist_ok=True, mode=0o700); os.chmod(B, 0o700)
    bk = B / backup_name
    if bk.exists(): raise Refused(f'{bk} exists: use a fresh --backup')
    write_private(bk, before); receipt['backup'] = str(bk)
    write_private(cfg, json.dumps(want, indent=2) + '\n')
    if json.loads(cfg.read_text()) != want:
        write_private(cfg, before); restored = cfg.read_bytes() == before
        receipt.update(restored=restored, configSha256After=sha(cfg))
        raise Refused(f'config.json did not read back as written; pre-step config {"restored" if restored else "NOT restored"} from {bk}')
    out.update(changed=True, backup=str(bk), configSha256After=sha(cfg)); return out


def set_memory_root(a):
    """DESIGN-NEXT-BUILD B1: V4 reads the shared-memory corpus from memoryRoot (default <ORCA_HOME>/memory). Point it at
    the canonical folder the installation already keeps (the decisions vault), so V4 sessions read the live corpus
    rather than the carry-memory snapshot. The memory server only searches and reads; the folder is never written."""
    H, B = Path(a.paseo_home), Path(a.backup)
    receipt = {'step': 'set-memory-root', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    try:
        root = None
        if not a.clear:
            root = a.root
            if not root or not os.path.isabs(root) or os.path.normpath(root) != root or os.path.realpath(root) != root or not os.path.isdir(root) or len(root) > 1024:
                raise Refused(f'--root must be an existing canonical absolute folder (no symlink, no trailing slash): {root}')
        out = set_config_key(H, B, 'memoryRoot', root, a.clear, a.bundle_exe, a.bundle_entry, 'command-centre-config.json.pre-memory-root' + ('-clear' if a.clear else ''), receipt)
        out['step'] = 'memoryRoot ' + ('removed from' if a.clear else 'set in') + ' command-centre/config.json'
        receipt.update(out, outcome='changed' if out.get('changed') else 'unchanged'); print(json.dumps(out), flush=True); return out
    except Refused as e:
        receipt.update(outcome='refused', refused=str(e)); raise
    finally:
        B.mkdir(parents=True, exist_ok=True, mode=0o700); os.chmod(B, 0o700)
        write_private(B / ('set-memory-root' + ('-clear' if a.clear else '') + '-receipt.json'), json.dumps(receipt, indent=1) + '\n')


# DESIGN-NEXT-BUILD A2/A5: role defaults (defaults.roles). The Python mirror of orca-organization/server/config.mjs
# validateRoles and src/control/provider-mode.mjs's value checks (MODEL_SELECTION, family, THINKING, modes), so the
# migration never writes a table the controller refuses at spawn.
SESSION_ROLES = ('planning', 'orchestration', 'implementation')
ROLE_PROVIDERS = ('claude', 'codex')
MODEL_SELECTION = re.compile(r'[a-z][a-z0-9-]{0,31}(/[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,63})?')
# The approved table (prime, 29 Sep): Opus 5.5 plans at high effort and orchestrates at medium; implementation sessions
# are Claude (an omitted provider resolves to it), Sonnet 5.5 at high. Claude only: Codex keeps today's values.
APPROVED_ROLE_DEFAULTS = {
    'planning': {'claude': {'model': 'claude/claude-opus-5-5', 'thinkingOptionId': 'high'}},
    'orchestration': {'claude': {'model': 'claude/claude-opus-5-5', 'thinkingOptionId': 'medium'}},
    'implementation': {'provider': 'claude', 'claude': {'model': 'claude/claude-sonnet-5-5', 'thinkingOptionId': 'high'}},
}


def validate_roles(roles, where='role defaults'):
    if not isinstance(roles, dict): raise Refused(f'{where} must be an object')
    for role, entry in roles.items():
        if role not in SESSION_ROLES: raise Refused(f'{where}: unknown role {role!r}')
        if not isinstance(entry, dict) or set(entry) - {'provider', *ROLE_PROVIDERS}: raise Refused(f'{where}: {role} may name only provider/claude/codex')
        if 'provider' in entry and entry['provider'] not in ROLE_PROVIDERS: raise Refused(f'{where}: {role}.provider must be claude or codex')
        for p in ROLE_PROVIDERS:
            if p not in entry: continue
            x = entry[p]
            if not isinstance(x, dict) or set(x) - {'model', 'thinkingOptionId', 'modeId'}: raise Refused(f'{where}: {role}.{p} may name only model/thinkingOptionId/modeId')
            for k, v in x.items():
                if not isinstance(v, str) or not v or len(v) > 128: raise Refused(f'{where}: {role}.{p}.{k} must be a short non-empty string')
            if 'model' in x and (not MODEL_SELECTION.fullmatch(x['model']) or x['model'].split('/')[0] != p): raise Refused(f'{where}: {role}.{p}.model {x["model"]!r} is not a {p} model selection')
            if 'thinkingOptionId' in x and x['thinkingOptionId'] not in THINKING: raise Refused(f'{where}: {role}.{p}.thinkingOptionId {x["thinkingOptionId"]!r} is not one V4 accepts')
            if 'modeId' in x and x['modeId'] not in SELECTABLE_MODES[p]: raise Refused(f'{where}: {role}.{p}.modeId {x["modeId"]!r} is not selectable for {p} under V4')
    return roles


def carry_role_defaults(a):
    """DESIGN-NEXT-BUILD A5: write the approved role table into the EXISTING <PASEO_HOME>/command-centre/config.json
    `defaults.roles` (every other key kept); with --clear, remove it. Gated like memoryRoot on the INSTALLED bundle
    accepting the result (an older bundle refuses `defaults.roles` and the controller would not start); backed up, read
    back, restored on mismatch, idempotent. A different table already present is replaced only with --refresh. The
    controller reads it per spawn: new sessions get it; running ones are unchanged."""
    H, B = Path(a.paseo_home), Path(a.backup); suffix = '-clear' if a.clear else ''
    receipt = {'step': 'carry-role-defaults' + suffix, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    try:
        cfg = H / 'command-centre' / 'config.json'
        if not cfg.exists(): raise Refused(f'{cfg} does not exist: not a migrated V4 home')
        v2 = json.loads(cfg.read_bytes())
        if v2.get('version') != 2 or not isinstance(v2.get('defaults'), dict): raise Refused(f'{cfg} is not a V4 version-2 config with a defaults object')
        current = v2['defaults'].get('roles'); receipt['previous'] = current
        if a.clear: want = {k: v for k, v in v2['defaults'].items() if k != 'roles'}
        else:
            table = validate_roles(json.loads(json.dumps(APPROVED_ROLE_DEFAULTS)))
            if current is not None and current != table and not a.refresh:
                raise Refused('defaults.roles already holds a different table: pass --refresh to replace it (the previous table is kept in the backup)')
            want = {**v2['defaults'], 'roles': table}
        out = set_config_key(H, B, 'defaults', want, False, a.bundle_exe, a.bundle_entry, 'command-centre-config.json.pre-roles' + suffix, receipt)
        out.update(step='defaults.roles ' + ('removed from' if a.clear else 'set in') + ' command-centre/config.json', roles=None if a.clear else want['roles'], previous=current)
        out.pop('value', None)
        receipt.update(out, outcome='changed' if out.get('changed') else 'unchanged'); print(json.dumps(out), flush=True); return out
    except Refused as e:
        receipt.update(outcome='refused', refused=str(e))
        if receipt.get('bundleGate', {}).get('accepted') is False: receipt['refusedCode'] = 'bundle-does-not-accept-roles'
        raise
    finally:
        B.mkdir(parents=True, exist_ok=True, mode=0o700); os.chmod(B, 0o700)
        write_private(B / f'carry-role-defaults{suffix}-receipt.json', json.dumps(receipt, indent=1) + '\n')


def disarm(a):
    """A V4 release switch outside forward/rollback (a later V4 bundle, or a downgrade): the daemon stopped, disarm only."""
    L, H = Path(a.legacy_home), Path(a.paseo_home)
    stopped(L, H, a.port)
    removed, voided = disarm_v4_chain(H, H / 'command-centre')
    out = {'step': 'V4 boot chain disarmed (release switch)', 'recordsRemoved': removed, 'sealsVoided': len(voided)}
    print(json.dumps(out), flush=True); return out


def main(argv):
    ap = argparse.ArgumentParser(prog='w1_migrate.py'); sub = ap.add_subparsers(dest='cmd', required=True)
    f = sub.add_parser('forward'); f.add_argument('--legacy-home', required=True); f.add_argument('--portable-home')
    f.add_argument('--authority-company'); f.add_argument('--authority-programme'); f.add_argument('--issue-api', help='base URL, e.g. http://127.0.0.1:3200')
    f.add_argument('--paseo-home', required=True); f.add_argument('--backup', required=True); f.add_argument('--host', action='append'); f.add_argument('--port', type=int)
    f.add_argument('--local-host', default='mini'); f.add_argument('--book-profile'); f.add_argument('--book-key-into-home', action='store_true'); f.add_argument('--legacy-tasks'); f.add_argument('--outcomes-root'); f.add_argument('--memory-source')
    f.add_argument('--role-defaults', help='a defaults.roles JSON object to write (validated as the controller would); omitted = none')
    f.add_argument('--legacy-argv', help='the legacy daemon launch flags to carry into config.json, e.g. "--relay --no-mcp --no-inject-mcp --web-ui"')
    b = sub.add_parser('rollback'); b.add_argument('--legacy-home', required=True); b.add_argument('--paseo-home', required=True); b.add_argument('--backup', required=True); b.add_argument('--port', type=int)
    c = sub.add_parser('carry-defaults'); c.add_argument('--legacy-home', required=True); c.add_argument('--paseo-home', required=True); c.add_argument('--backup', required=True)
    m = sub.add_parser('carry-memory'); m.add_argument('--paseo-home', required=True); m.add_argument('--memory-source', required=True); m.add_argument('--backup', required=True)
    m.add_argument('--refresh', action='store_true')
    r = sub.add_parser('set-memory-root'); r.add_argument('--paseo-home', required=True); r.add_argument('--backup', required=True); r.add_argument('--root')
    r.add_argument('--clear', action='store_true'); r.add_argument('--bundle-exe', required=True); r.add_argument('--bundle-entry', required=True)
    o = sub.add_parser('carry-role-defaults'); o.add_argument('--paseo-home', required=True); o.add_argument('--backup', required=True)
    o.add_argument('--refresh', action='store_true'); o.add_argument('--clear', action='store_true'); o.add_argument('--bundle-exe', required=True); o.add_argument('--bundle-entry', required=True)
    d = sub.add_parser('disarm-v4-chain'); d.add_argument('--legacy-home', required=True); d.add_argument('--paseo-home', required=True); d.add_argument('--port', type=int)
    for sp in (r, o): sp.add_argument('--fleet-readers', help='OFFLINE TESTS ONLY: a JSON list of readers to probe instead of the running processes')
    a = ap.parse_args(argv)
    global FLEET_READERS
    FLEET_READERS = getattr(a, 'fleet_readers', None)
    for k in ('legacy_home', 'portable_home', 'paseo_home', 'backup', 'memory_source', 'bundle_exe', 'bundle_entry'):
        v = getattr(a, k, None)
        if v is not None and not os.path.isabs(v): raise Refused(f'--{k.replace("_", "-")} must be absolute')
    return forward(a) if a.cmd == 'forward' else rollback(a) if a.cmd == 'rollback' else carry_defaults(a) if a.cmd == 'carry-defaults' else carry_memory(a) if a.cmd == 'carry-memory' else set_memory_root(a) if a.cmd == 'set-memory-root' else carry_role_defaults(a) if a.cmd == 'carry-role-defaults' else disarm(a)


if __name__ == '__main__':
    try: main(sys.argv[1:])
    except Refused as e: print(json.dumps({'refused': str(e)}), file=sys.stderr); sys.exit(2)
