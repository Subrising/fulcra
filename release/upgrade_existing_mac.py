"""Existing-Mac upgrade transaction. No service actions occur during prepare.

Use Upgrade(Plan(...), lifecycle=ReviewedHostLifecycle()).prepare(), then cutover()
only in the same owning process. rollback() retains the new app and restores only
this transaction's app and explicit selectors; it never copies a daemon home.

The default Lifecycle refuses cutover. Mini launchd and Book desktop supervision
need separately reviewed implementations of the native observation/intake fence
and supported graceful stop/start ports. CLI reachability, an idle saved session,
ordinary GUI quit, and a process-name search do not prove that contract. The fence
must cover schedules, human input, controller work, and the entire selected
supervisor/daemon/app tree. No process kill or instruction replay port exists.
Preparation is not installed acceptance. Crash recovery is intentionally unavailable:
retained old bytes and bounded selector backups require explicit operator recovery.
"""
from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import os
import shutil
import stat
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from upgrade_space import METADATA_BUDGET, Footprint, SpaceRefused, bundle_footprint, check_space


class UpgradeRefused(RuntimeError):
    code = "UPGRADE_REFUSED"


class TopologyUnavailable(UpgradeRefused):
    code = "TOPOLOGY_UNAVAILABLE"


class NativeUpgradeApiUnavailable(TopologyUnavailable):
    code = "NATIVE_UPGRADE_API_UNAVAILABLE"

    def __init__(self, *missing):
        self.missing = tuple(missing)
        super().__init__("Native upgrade backend seam required: " + "; ".join(missing))


class Busy(UpgradeRefused):
    code = "NATIVE_SESSIONS_BUSY"


class StopIncomplete(UpgradeRefused):
    code = "GRACEFUL_STOP_INCOMPLETE"


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def canonical(path, *, exists=True):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts or path.resolve(strict=exists) != path:
        raise UpgradeRefused("Canonical absolute path required")
    return path


def identity(path):
    info = Path(path).lstat()
    return info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode)


def seal_bundle(app):
    """Streaming implementation of release/contract.mjs sealBundle's full seal.

    Directory entries are not part of that seal; bundle_footprint additionally
    checks the whole tree. Use JS UTF-16 ordering and compact UTF-8 JSON.
    """
    app = canonical(app)
    bundle_footprint(app)
    entries = []

    def walk(directory):
        for path in sorted(directory.iterdir(), key=lambda p: p.name.encode("utf-16-be")):
            info = path.lstat()
            relative = str(path.relative_to(app))
            if stat.S_ISLNK(info.st_mode):
                entries.append({"file": relative, "link": os.readlink(path)})
            elif stat.S_ISDIR(info.st_mode):
                walk(path)
            else:
                entries.append({"file": relative, "sha256": digest(path), "mode": info.st_mode & 0o777})
    walk(app)
    if not {"Contents/MacOS/Fulcra", "Contents/Resources/app.asar"}.issubset(
            {entry["file"] for entry in entries}):
        raise UpgradeRefused("Fulcra app entries missing")
    raw = json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def require_seal(app, expected):
    if (not isinstance(expected, str) or len(expected) != 64
            or any(c not in "0123456789abcdef" for c in expected)
            or seal_bundle(app) != expected):
        raise UpgradeRefused("Full bundle seal changed")


@dataclass(frozen=True)
class FileState:
    kind: str
    data: bytes
    mode: int = 0o600

    def __post_init__(self):
        if (self.kind not in ("file", "link") or not isinstance(self.data, bytes)
                or len(self.data) > METADATA_BUDGET or type(self.mode) is not int
                or self.mode < 0 or self.mode > 0o777):
            raise UpgradeRefused("Invalid bounded selector state")
        if self.kind == "link":
            canonical(self.data.decode("utf-8"))


def read_state(path):
    path = Path(path)
    canonical(path.parent)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        return FileState("link", os.readlink(path).encode("utf-8"), info.st_mode & 0o777)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > METADATA_BUDGET:
        raise UpgradeRefused("Selector must be bounded and unaliased")
    return FileState("file", path.read_bytes(), info.st_mode & 0o777)


@dataclass(frozen=True)
class Selector:
    path: Path
    replacement: FileState


@dataclass(frozen=True)
class Plan:
    source: Path
    seal: str
    measured: Footprint
    release: Path
    install_stage: Path
    installed: Path
    rollback: Path
    metadata: Path
    home: Path
    desktop_managed: bool
    preserve_roots: tuple
    selectors: tuple = ()
    settings: tuple = ()
    incoming: Path | None = None

    def layout(self):
        data = {name: getattr(self, name) for name in
                ("release", "install_stage", "installed", "rollback", "metadata")}
        if self.incoming is not None:
            data["incoming"] = self.incoming
        return data


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    started: str
    executable: Path
    file_identity: tuple


@dataclass(frozen=True)
class NativeSession:
    session_id: str
    active_turn: bool
    pending_permission: bool


@dataclass(frozen=True)
class NativeStatus:
    home: Path
    desktop_managed: bool
    complete: bool
    observed_at: float
    sessions: tuple
    processes: tuple


class Lifecycle:
    """Trusted host port; unavailable until a host implementation proves topology.

    observe() must query actual native turn/permission state including operators
    and internal helper agents. active_turn must also cover pending foreground
    starts/runs/replacements and autonomous provider-child work: a display status
    of idle alone is insufficient. complete means the entire session and lifecycle
    process inventories are known. CLI ls -ag and inspect are NOT this observation:
    listAgents hides internal agents and their CLI projections omit activeTurn.
    hold_intake() must exclude all new work until exit, including after restart;
    acquiring/releasing the lease currently permits no persistent writes/logs.
    A future durable backend hold also needs explicit home-filesystem budget and
    guarded acquisition/release support; a Python lock cannot provide boot fencing.
    graceful_stop() uses supported selected launcher/CLI operations, bounded by
    the supplied timeout, with no kill fallback. Current native supervisor/worker
    shutdown has independent forced 10s deadlines: CLI --force=false and a longer
    --timeout do not disable them and cannot implement this port safely.
    start() starts only a verified
    selected app/launcher, never sends a session instruction. Implementations must
    pin executable/launcher bytes and validate structured argv (never shell text),
    preserve settings, and bound their aggregate metadata/log output to log_budget.
    They must not overwrite adapter-owned files or change captured selectors.
    """
    @contextmanager
    def hold_intake(self):
        raise NativeUpgradeApiUnavailable(
            "atomic all-session reject-busy native input/provider-turn admission lease",
            "lease handoff blocking new-daemon intake through verified restart")
        yield

    def observe(self):
        raise NativeUpgradeApiUnavailable(
            "complete native snapshot including internal agents and pending provider starts",
            "daemon-boot-bound app/supervisor/worker process inventory")

    def graceful_stop(self, expected, *, timeout, log_budget):
        raise NativeUpgradeApiUnavailable(
            "captured-instance graceful stop under the same native admission lease",
            "selected launchd or desktop owner suppression and complete-tree exit verification",
            "shutdown capability without internal supervisor/worker force-kill deadlines")

    def start(self, app, *, log_budget):
        raise NativeUpgradeApiUnavailable(
            "pinned selected host launcher with admission disabled until lease release")


def _native_rename(source, target, *, exchange=False):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        operation = libc.renamex_np
        operation.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = operation(os.fsencode(source), os.fsencode(target), 2 if exchange else 4)
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        operation = libc.renameat2
        operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = operation(-100, os.fsencode(source), -100, os.fsencode(target), 2 if exchange else 1)
    else:
        raise TopologyUnavailable("Atomic app/selector rename unavailable")
    if result != 0:
        raise UpgradeRefused("Atomic rename refused: " + os.strerror(ctypes.get_errno()))


def rename_fresh(source, target):
    """Atomic no-overwrite app rename, including an occupied empty directory."""
    _native_rename(source, target)


def swap_existing(source, target):
    # Retain the exact prior selector inode (ACLs/xattrs/ownership included).
    _native_rename(source, target, exchange=True)


def mac_process_probe(pid):
    if sys.platform != "darwin" or type(pid) is not int or pid <= 0:
        raise TopologyUnavailable("macOS process identity probe unavailable")

    class BSDInfo(ctypes.Structure):
        # sys/proc_info.h proc_bsdinfo (PROC_PIDTBSDINFO=3); MAXCOMLEN=16.
        _fields_ = [("header", ctypes.c_uint32 * 12), ("comm", ctypes.c_char * 16),
                    ("name", ctypes.c_char * 32), ("tail", ctypes.c_uint32 * 6),
                    ("seconds", ctypes.c_uint64), ("microseconds", ctypes.c_uint64)]

    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                   ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]

    def read():
        info = BSDInfo()
        ctypes.set_errno(0)
        result = libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if result == 0 and ctypes.get_errno() == errno.ESRCH:
            return None
        if result != ctypes.sizeof(info) or info.header[3] != pid or not info.seconds:
            raise TopologyUnavailable("Kernel process start identity unavailable")
        return f"{info.seconds}.{info.microseconds:06d}"

    started = read()
    if started is None:
        return None
    buffer = ctypes.create_string_buffer(4096)
    if libproc.proc_pidpath(pid, buffer, len(buffer)) <= 0:
        raise TopologyUnavailable("Kernel executable path unavailable")
    executable = canonical(os.fsdecode(buffer.value))
    result = ProcessIdentity(pid, started, executable, identity(executable))
    if read() != started:
        raise UpgradeRefused("Process lifetime changed during identity capture")
    return result


class Upgrade:
    def __init__(self, plan, *, lifecycle=None, process_probe=mac_process_probe,
                 statvfs=os.statvfs, copytree=shutil.copytree, clock=time.monotonic):
        self.plan = plan
        self.lifecycle = lifecycle or Lifecycle()
        self.process_probe = process_probe
        self.statvfs = statvfs
        self.copytree = copytree
        self.clock = clock
        self.state = "new"
        self.devices = None
        self.bindings = {}
        self.parents = {}
        self.selector_states = {}
        self.prior_selectors = {}
        self.changed_selectors = set()
        self.retained_selectors = {}
        self.prior_selector_ids = {}
        self.settings = {}
        self.used_bytes = 0
        self.old_seal = None
        self.processes = None
        self.old_moved = False
        self.new_moved = False

    def _validate_plan(self):
        p = self.plan
        if (not isinstance(p, Plan) or not isinstance(p.selectors, tuple)
                or not isinstance(p.settings, tuple) or not isinstance(p.preserve_roots, tuple)
                or any(not isinstance(s, Selector) or not isinstance(s.replacement, FileState)
                       for s in p.selectors)):
            raise UpgradeRefused("Structured trusted plan required")
        if type(p.desktop_managed) is not bool or not isinstance(p.measured, Footprint):
            raise UpgradeRefused("Explicit topology and measured bytes required")
        paths = [p.source, *p.layout().values()]
        for path in (*paths, p.home, *p.preserve_roots, *p.settings, *(s.path for s in p.selectors)):
            if not isinstance(path, Path):
                raise UpgradeRefused("Plan paths must be explicit Path objects")
        for path in paths:
            canonical(path, exists=os.path.lexists(path))
            canonical(path.parent)
        if len(set(paths)) != len(paths):
            # incoming may name source: it is observation-only after receive.
            if p.incoming != p.source or len(set(paths)) != len(paths) - 1:
                raise UpgradeRefused("Upgrade paths overlap")
        owned = [p.release, p.install_stage, p.installed, p.rollback, p.metadata]
        for i, a in enumerate(owned):
            for b in owned[i + 1:]:
                if a.is_relative_to(b) or b.is_relative_to(a):
                    raise UpgradeRefused("Upgrade targets overlap")
        if any(p.source.is_relative_to(a) or a.is_relative_to(p.source) for a in owned):
            raise UpgradeRefused("Source overlaps upgrade targets")
        for root in (p.home, *p.preserve_roots):
            canonical(root)
            if any(a.is_relative_to(root) or root.is_relative_to(a) for a in owned):
                raise UpgradeRefused("Upgrade target overlaps retained user state")
        for target in (p.release, p.install_stage, p.rollback, p.metadata, self._guard_slot()):
            if os.path.lexists(target):
                raise UpgradeRefused("Fresh target is occupied")
        selector_paths = [s.path for s in p.selectors]
        if len(set(selector_paths)) != len(selector_paths) or set(selector_paths) & set(p.settings):
            raise UpgradeRefused("Duplicate selector or settings target")
        for path in (*selector_paths, *p.settings):
            canonical(path.parent)
            if not path.is_absolute() or ".." in path.parts:
                raise UpgradeRefused("Explicit canonical state target required")
            if any(path.is_relative_to(a) or a.is_relative_to(path) for a in paths):
                raise UpgradeRefused("State target overlaps app or metadata")
        for path in selector_paths:
            if any(path.is_relative_to(root) for root in (p.home, *p.preserve_roots)):
                raise UpgradeRefused("Selector cannot overwrite retained histories/config")
            if path.parent.stat().st_dev != p.metadata.parent.stat().st_dev:
                raise TopologyUnavailable("Selector writes require the budgeted metadata filesystem")
        self.parents = {path.parent: identity(path.parent) for path in
                        (*paths, *selector_paths, *p.settings)}
        self.bindings = {path: identity(path) for path in (p.source, p.installed, p.home, *p.preserve_roots)}

    def _guard_slot(self):
        return self.plan.rollback.with_name(self.plan.rollback.name + ".capacity-only")

    def _paths_unchanged(self):
        for path, recorded in {**self.parents, **self.bindings}.items():
            if not os.path.lexists(path) or identity(path) != recorded:
                raise UpgradeRefused("Captured path identity changed")
            canonical(path)
        for path, (recorded, old) in self.selector_states.items():
            if identity(path) != recorded or read_state(path) != old:
                raise UpgradeRefused("Selected state changed since capture")
        if self.old_moved and not self.new_moved and os.path.lexists(self.plan.installed):
            raise UpgradeRefused("Installed replacement target is occupied")
        if self.new_moved and os.path.lexists(self.plan.install_stage):
            raise UpgradeRefused("Retained new-app target is occupied")
        if os.path.lexists(self._guard_slot()):
            raise UpgradeRefused("Capacity-only target occupied")

    def _guard(self, phase):
        self._paths_unchanged()
        layout = self.plan.layout()
        if self.old_moved:
            # check_space's initial-layout occupancy rule refuses any rollback.
            # After OUR verified rename, project the identical actual filesystems
            # using a fresh non-written sibling; retained bytes remain allocated.
            layout["rollback"] = self._guard_slot()
            layout["installed"] = self.plan.installed if self.new_moved else self.plan.rollback
        if self.new_moved:
            layout["install_stage"] = self.plan.installed
        analysis = check_space(self.plan.source, **layout, phase=phase,
                               expected_devices=self.devices, statvfs=self.statvfs)
        if self.devices is None:
            self.devices = analysis["devices"]
        return analysis

    def _write(self, phase, action, *, byte_count=0):
        if self.used_bytes + byte_count > METADATA_BUDGET:
            raise UpgradeRefused("Total metadata/log budget exceeded")
        self._guard(phase)
        self.used_bytes += byte_count  # Failed writes consume the attempt budget too.
        action()

    def _remember(self, path):
        self.bindings[path] = identity(path)

    def prepare(self):
        if self.state != "new":
            raise UpgradeRefused("Preparation cannot be retried into occupied targets")
        self._validate_plan()
        self._guard("stage")  # Before copy/observer callbacks or any owned write.
        require_seal(self.plan.source, self.plan.seal)
        if bundle_footprint(self.plan.source) != self.plan.measured:
            raise UpgradeRefused("Measured local source bytes changed")
        self.old_seal = seal_bundle(self.plan.installed)
        for selector in self.plan.selectors:
            old = read_state(selector.path)
            self.prior_selectors[selector.path] = old
            self.prior_selector_ids[selector.path] = identity(selector.path)
            self.selector_states[selector.path] = (identity(selector.path), old)
        self.settings = {path: (identity(path), read_state(path)) for path in self.plan.settings}
        # Budget backups, replacement and rollback plus allocation slack, leaving
        # the remaining attempt budget for the trusted lifecycle's bounded logs.
        needed = sum(2 * len(old.data) + len(s.replacement.data) + 16384
                     for s in self.plan.selectors for old in [self.prior_selectors[s.path]])
        if needed > METADATA_BUDGET:
            raise UpgradeRefused("Selected rollback metadata exceeds 64 MiB")
        self.state = "preparing"
        self._write("stage", lambda: self.copytree(self.plan.source, self.plan.release, symlinks=True))
        self._remember(self.plan.release)
        require_seal(self.plan.release, self.plan.seal)
        self._write("installer", lambda: self.plan.metadata.mkdir(mode=0o700), byte_count=4096)
        self._remember(self.plan.metadata)
        for index, old in enumerate(self.prior_selectors.values()):
            backup = self.plan.metadata / f"selector-{index}.prior"
            self._write("installer", lambda path=backup, data=old.data: self._exclusive_bytes(path, data),
                        byte_count=len(old.data) + 4096)
        self._write("installer", lambda: self.copytree(self.plan.release, self.plan.install_stage, symlinks=True))
        self._remember(self.plan.install_stage)
        self._verify_prepared()
        self.state = "prepared"
        return self

    @staticmethod
    def _exclusive_bytes(path, data, mode=0o600):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())

    def _verify_prepared(self):
        self._paths_unchanged()
        for path in (self.plan.source, self.plan.release, self.plan.install_stage):
            require_seal(path, self.plan.seal)
            measured = bundle_footprint(path)
            if (measured.logical, measured.entries) != (self.plan.measured.logical, self.plan.measured.entries):
                raise UpgradeRefused("Staged bundle measured content differs")
        require_seal(self.plan.installed, self.old_seal)
        self._settings_unchanged()

    def _settings_unchanged(self):
        if any((identity(path), read_state(path)) != value for path, value in self.settings.items()):
            raise UpgradeRefused("Settings changed; adapter will not overwrite them")

    def _observe(self, *, stopped=False):
        status = self.lifecycle.observe()
        if (not isinstance(status, NativeStatus) or status.complete is not True
                or status.home != self.plan.home or type(status.desktop_managed) is not bool
                or status.desktop_managed != self.plan.desktop_managed
                or not isinstance(status.observed_at, (int, float))
                or not 0 <= self.clock() - status.observed_at <= 5
                or not isinstance(status.sessions, tuple) or not isinstance(status.processes, tuple)):
            raise TopologyUnavailable("Fresh complete native topology status unavailable")
        ids = set()
        for session in status.sessions:
            if (not isinstance(session, NativeSession) or not session.session_id
                    or session.session_id in ids or type(session.active_turn) is not bool
                    or type(session.pending_permission) is not bool):
                raise TopologyUnavailable("Native session status is unknown")
            ids.add(session.session_id)
            if session.active_turn or session.pending_permission:
                raise Busy("Every native session, including operators, must be quiescent")
        pids = set()
        for process in status.processes:
            if (not isinstance(process, ProcessIdentity) or type(process.pid) is not int
                    or process.pid <= 0 or process.pid in pids or not process.started):
                raise TopologyUnavailable("Complete lifecycle process identity unavailable")
            pids.add(process.pid)
            if self.process_probe(process.pid) != process:
                raise UpgradeRefused("PID/start/executable identity changed")
        if stopped and status.processes:
            raise StopIncomplete("Graceful stop did not stop the complete selected tree")
        if not stopped and not status.processes:
            raise TopologyUnavailable("Running selected process inventory missing")
        return status.processes

    def _stop(self, expected):
        self._guard("cutover")
        if self._observe() != expected:
            raise UpgradeRefused("Lifecycle process inventory changed before stop")
        # Reserve all remaining output for the stop/start pair once. The port
        # owns enforcement; there is no unbounded subprocess/log implementation.
        budget = METADATA_BUDGET - self.used_bytes - self._remaining_selector_bytes()
        if budget < 0:
            raise UpgradeRefused("Lifecycle output budget exhausted")
        allowance = budget // 2
        try:
            self._write("cutover", lambda: self.lifecycle.graceful_stop(
                expected, timeout=30, log_budget=allowance), byte_count=allowance)
        except TimeoutError as error:
            raise StopIncomplete("Supported graceful stop timed out; no force kill") from error
        self._observe(stopped=True)
        if any(self.process_probe(p.pid) is not None for p in expected):
            raise StopIncomplete("Captured process still exists or PID was reused; no force kill")
        self.state = "stopped"

    def _remaining_selector_bytes(self):
        return sum(len(s.replacement.data) + len(self.prior_selectors[s.path].data) + 16384
                   for s in self.plan.selectors)

    def _replace_selector(self, path, value):
        temporary = path.with_name(path.name + ".upgrade-temp")
        if os.path.lexists(temporary):
            raise UpgradeRefused("Selector temporary target occupied")
        def create():
            if value.kind == "link":
                os.symlink(value.data.decode("utf-8"), temporary)
                if hasattr(os, "lchmod"):
                    os.lchmod(temporary, value.mode)
                elif (temporary.lstat().st_mode & 0o777) != value.mode:
                    raise TopologyUnavailable("Exact selector link mode cannot be restored")
            else:
                self._exclusive_bytes(temporary, value.data, value.mode)
                os.chmod(temporary, value.mode)
        self._write("cutover", create, byte_count=len(value.data) + 4096)
        self._write("cutover", lambda: swap_existing(temporary, path), byte_count=4096)
        self.selector_states[path] = (identity(path), value)
        self.selector_states[temporary] = (identity(temporary), read_state(temporary))
        self.retained_selectors[path] = temporary
        self.changed_selectors.add(path)
        if identity(temporary) != self.prior_selector_ids[path]:
            raise UpgradeRefused("Selector identity changed at exchange; explicit recovery required")
        index = list(self.prior_selectors).index(path)
        retained = self.plan.metadata / f"selector-{index}.retained"
        self._write("cutover", lambda: rename_fresh(temporary, retained), byte_count=4096)
        self.selector_states.pop(temporary)
        self.selector_states[retained] = (identity(retained), self.prior_selectors[path])
        self.retained_selectors[path] = retained

    def _restore_selector(self, path):
        retained = self.retained_selectors[path]
        if identity(retained) != self.prior_selector_ids[path]:
            raise UpgradeRefused("Retained selector identity changed")
        current = self.selector_states[path][1]
        self._write("cutover", lambda: swap_existing(retained, path), byte_count=4096)
        self.selector_states[path] = (identity(path), self.prior_selectors[path])
        self.selector_states[retained] = (identity(retained), current)
        self.changed_selectors.remove(path)

    def _start(self):
        require_seal(self.plan.installed, self.plan.seal if self.new_moved else self.old_seal)
        self._guard("cutover")
        allowance = max(0, (METADATA_BUDGET - self.used_bytes - self._remaining_selector_bytes()) // 2)
        self._write("cutover", lambda: self.lifecycle.start(self.plan.installed, log_budget=allowance),
                    byte_count=allowance)
        self.processes = self._observe()
        require_seal(self.plan.installed, self.plan.seal if self.new_moved else self.old_seal)

    def cutover(self):
        if self.state != "prepared":
            raise UpgradeRefused("Cutover requires this transaction's verified preparation")
        self._verify_prepared()
        self._guard("cutover")
        self.processes = self._observe()  # Unknown/busy refuses even before the fence port.
        with self.lifecycle.hold_intake():
            if self._observe() != self.processes:
                raise UpgradeRefused("Lifecycle changed while acquiring intake fence")
            self._stop(self.processes)
            self._verify_prepared()
            self._write("cutover", lambda: rename_fresh(self.plan.installed, self.plan.rollback))
            self.old_moved = True
            self.bindings.pop(self.plan.installed)
            self._remember(self.plan.rollback)
            self._write("cutover", lambda: rename_fresh(self.plan.install_stage, self.plan.installed))
            self.new_moved = True
            self.bindings.pop(self.plan.install_stage)
            self._remember(self.plan.installed)
            require_seal(self.plan.installed, self.plan.seal)
            for selector in self.plan.selectors:
                self._replace_selector(selector.path, selector.replacement)
                self.changed_selectors.add(selector.path)
            self._settings_unchanged()
            self._start()
            self.state = "installed"
        return self

    def rollback(self):
        if self.state not in ("installed", "stopped"):
            raise UpgradeRefused("Rollback requires a stopped or installed owned transaction")
        self._paths_unchanged()
        if self.old_moved:
            require_seal(self.plan.rollback, self.old_seal)
        if self.new_moved:
            require_seal(self.plan.installed, self.plan.seal)
        self._guard("cutover")
        if self.state == "installed":
            if self._observe() != self.processes:
                raise UpgradeRefused("Installed process identity changed before rollback")
        else:
            self._observe(stopped=True)
        with self.lifecycle.hold_intake():
            if self.state == "installed":
                self._stop(self.processes)
            else:
                self._observe(stopped=True)
            for selector in self.plan.selectors:
                if selector.path in self.changed_selectors:
                    self._restore_selector(selector.path)
            if self.new_moved:
                if os.path.lexists(self.plan.install_stage):
                    raise UpgradeRefused("Retained new-app target occupied")
                self._write("cutover", lambda: rename_fresh(self.plan.installed, self.plan.install_stage))
                self.new_moved = False
                self.bindings.pop(self.plan.installed)
                self._remember(self.plan.install_stage)
            if self.old_moved:
                if os.path.lexists(self.plan.installed):
                    raise UpgradeRefused("Prior app target occupied")
                self._write("cutover", lambda: rename_fresh(self.plan.rollback, self.plan.installed))
                self.old_moved = False
                self.bindings.pop(self.plan.rollback)
                self._remember(self.plan.installed)
            require_seal(self.plan.installed, self.old_seal)
            self._start()
            self.state = "rolled-back"
        return self
