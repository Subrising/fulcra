"""Bounded LEGACY first cutover, separate from the strict future-lease adapter.

prepare() only creates verified separate app copies and non-live selectors.
cutover(owner_window_selected=True) is an explicit owner-selected stop window,
not permission inferred from idle status. No such window is selected by default.

Admitted limits: public SDK observations are incomplete/non-atomic; internal and
provider-autonomous activity can be invisible. CLI Stop cannot bind expected
PID/start atomically. Legacy supervisor/worker/launchd forced deadlines remain.
Owner coordination is not admission fencing. Startup may run normal automation;
this adapter sends no instructions and offers no crash-exactly-once/replay claim.

Production commands are pinned structured argv: selected launchctl bootout /
bootstrap on Mini; selected CLI daemon stop (no --force), captured-PID Cocoa
normal termination and open -n -a on Book. A launch request is not byte proof;
post-launch observation binds the exact new executable and selected home. Source/fixture verification is not installed acceptance.
Use only after one delivery review and an actual parent-selected owner window.
"""
from __future__ import annotations

import ctypes
import errno
import sys
import json
import os
import plistlib
import re
import select
import socket
import stat
import subprocess
import time
from dataclasses import dataclass, replace
from pathlib import Path

from upgrade_existing_mac import (Busy, FileState, ProcessIdentity, StopIncomplete,
                                  TopologyUnavailable, Upgrade, UpgradeRefused, canonical,
                                  digest, identity, mac_process_probe, read_state, Selector,
                                  rename_fresh, require_seal, swap_existing)
from upgrade_space import METADATA_BUDGET, SEAL_BUDGET, check_space

RESIDUALS = (
    "Public SDK/CLI status is non-atomic and omits internal/provider-autonomous work",
    "CLI Stop has no atomic expected-PID/start argument; check-to-command race remains",
    "Legacy shutdown retains internal force/abandonment and launchd deadlines",
    "Owner window is not a native admission fence; normal startup automation can run",
    "No crash-exactly-once, automatic rollback or instruction replay",
)


class OwnerWindowRequired(UpgradeRefused):
    code = "LEGACY_OWNER_WINDOW_REQUIRED"


class CommandUncertain(UpgradeRefused):
    code = "LEGACY_COMMAND_UNCERTAIN"


@dataclass(frozen=True)
class FilePin:
    path: Path
    resolved: Path
    sha256: str
    inode: tuple | None = None

    @classmethod
    def capture(cls, path):
        path = Path(path)
        canonical(path.parent)
        resolved = path.resolve(strict=True)
        return cls(path, resolved, digest(resolved), identity(resolved))

    @classmethod
    def planned(cls, target, source):
        source, target = Path(source), Path(target)
        canonical(source.parent)
        resolved = target.parent / os.readlink(source) if source.is_symlink() else target
        return cls(target, resolved.resolve(strict=False), digest(source.resolve(strict=True)))

    def validate(self):
        canonical(self.path.parent)
        resolved = self.path.resolve(strict=True)
        info = resolved.stat()
        if (resolved != self.resolved or not stat.S_ISREG(info.st_mode)
                or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022
                or digest(resolved) != self.sha256
                or self.inode is not None and identity(resolved) != self.inode):
            raise UpgradeRefused("Selected executable/launcher/manifest byte identity changed")


@dataclass(frozen=True)
class CommandPrefix:
    # Each prefix token is a pinned executable/script file, never shell text.
    argv: tuple
    pins: tuple

    def validate(self):
        if (not isinstance(self.argv, tuple) or not self.argv
                or not isinstance(self.pins, tuple)
                or any(not isinstance(p, FilePin) for p in self.pins)
                or len({p.path for p in self.pins}) != len(self.pins)):
            raise UpgradeRefused("Structured pinned command prefix required")
        for token in self.argv:
            if not isinstance(token, str) or Path(token) not in {p.path for p in self.pins}:
                raise UpgradeRefused("Every command prefix token must name a pinned file")
        for pin in self.pins:
            pin.validate()
        if not os.access(self.argv[0], os.X_OK):
            raise UpgradeRefused("Selected command executable is unavailable")


@dataclass(frozen=True)
class BundlePin:
    path: Path
    seal: str

    def validate(self):
        require_seal(self.path, self.seal)


@dataclass(frozen=True)
class HostSelection:
    topology: str  # mini-launchd | book-desktop; no inferred fallback.
    old_cli: CommandPrefix
    new_cli: CommandPrefix
    selected_roots: tuple  # Exact current kernel lifetimes, including independent helpers.
    old_bundles: tuple
    new_bundles: tuple
    listen: tuple  # Actual local (127.0.0.1, port), not a default port.
    app_process: ProcessIdentity | None = None
    bundle_id: str | None = None
    open_command: CommandPrefix | None = None
    launchctl: CommandPrefix | None = None
    launchd_label: str | None = None
    plist_selector: Path | None = None
    old_program_argv: tuple = ()
    new_program_argv: tuple = ()
    old_runtime_pins: tuple = ()
    new_runtime_pins: tuple = ()
    stop_timeout: float = 30


@dataclass(frozen=True)
class LegacyObservation:
    server_id: str
    supervisor_pid: int
    started_at: str
    worker_pid: int
    sessions: tuple
    processes: tuple
    observed_at: float
    # This cannot be consumed as NativeStatus.complete=True.
    global_complete: bool = False
    atomic: bool = False
    residuals: tuple = RESIDUALS


class BoundedCommands:
    """No shell, disk logs, retry or kill-on-timeout. Uncertain children are retained.

    A timed-out CLI may still be executing. Its handle stays owned here and blocks
    subsequent actions; explicit recovery must inspect it, never replay it. Output
    is charged to the transaction's shared 64 MiB budget as it arrives.
    """
    def __init__(self, before, charge, *, output_limit=1024 * 1024):
        self.before, self.charge = before, charge
        self.output_limit = output_limit
        self.uncertain = []
        self.action_count = 0

    def run(self, prefix, tail, *, action=False, timeout=15):
        if self.uncertain:
            raise CommandUncertain("An earlier selected command is unresolved; no replay")
        prefix.validate()
        if (not isinstance(tail, tuple) or any(not isinstance(s, str) or "\0" in s
                or len(s) > 16384 for s in tail) or "--force" in tail):
            raise UpgradeRefused("Invalid structured legacy command arguments")
        self.before(action)
        env = {"HOME": str(Path.home()), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
        if action:
            self.action_count += 1
        child = subprocess.Popen(prefix.argv + tail, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        streams = [child.stdout, child.stderr]
        output = {stream: bytearray() for stream in streams}
        deadline = time.monotonic() + timeout
        try:
            while streams:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CommandUncertain("Selected command timed out; exit/action unconfirmed")
                ready, _, _ = select.select(streams, [], [], min(remaining, 0.2))
                for stream in ready:
                    block = os.read(stream.fileno(), 65536)
                    if not block:
                        streams.remove(stream)
                    else:
                        self.charge(len(block))
                        output[stream].extend(block)
                        if sum(map(len, output.values())) > self.output_limit:
                            raise CommandUncertain("Selected command output exceeded its bound")
            try:
                code = child.wait(timeout=max(0.001, deadline - time.monotonic()))
            except subprocess.TimeoutExpired as error:
                raise CommandUncertain("Selected command exit unconfirmed") from error
        except BaseException:
            self.uncertain.append(child)
            raise
        finally:
            if child.poll() is not None:
                child.stdout.close()
                child.stderr.close()
        if code != 0:
            raise UpgradeRefused("Selected legacy command failed; no automatic retry")
        return bytes(output[child.stdout])


class _CocoaApplication:
    """NSRunningApplication selected exclusively by process identifier.

    SDK NSRunningApplication.h defines terminate as an asynchronous normal quit
    request. The object PID, executable URL and kernel lifetime are rechecked;
    no bundle/name lookup or force-termination selector exists here.
    """
    def __init__(self, pid):
        if sys.platform != "darwin":
            raise TopologyUnavailable("Captured-PID Cocoa termination requires macOS")
        try:
            self.appkit = ctypes.CDLL("/System/Library/Frameworks/AppKit.framework/AppKit")
            self.objc = ctypes.CDLL("/usr/lib/libobjc.A.dylib")
        except OSError as error:
            raise TopologyUnavailable("Cocoa captured-application API unavailable") from error
        self.objc.objc_getClass.argtypes = [ctypes.c_char_p]
        self.objc.objc_getClass.restype = ctypes.c_void_p
        self.objc.sel_registerName.argtypes = [ctypes.c_char_p]
        self.objc.sel_registerName.restype = ctypes.c_void_p
        self.address = ctypes.cast(self.objc.objc_msgSend, ctypes.c_void_p).value
        pool_class = self.objc.objc_getClass(b"NSAutoreleasePool")
        pool = self._send(pool_class, "alloc", ctypes.c_void_p)
        self.pool = self._send(pool, "init", ctypes.c_void_p)
        app_class = self.objc.objc_getClass(b"NSRunningApplication")
        self.application = self._send(app_class, "runningApplicationWithProcessIdentifier:",
                                      ctypes.c_void_p, ctypes.c_int, pid)
        if not self.application:
            self.close()
            raise TopologyUnavailable("Captured PID is not a running Cocoa application")

    def _send(self, receiver, selector, result_type, argument_type=None, argument=None):
        arguments = (ctypes.c_void_p, ctypes.c_void_p)
        if argument_type is not None:
            arguments += (argument_type,)
        function = ctypes.CFUNCTYPE(result_type, *arguments)(self.address)
        values = (receiver, self.objc.sel_registerName(selector.encode("ascii")))
        return function(*(values + (argument,) if argument_type is not None else values))

    def pid(self):
        return self._send(self.application, "processIdentifier", ctypes.c_int)

    def executable(self):
        url = self._send(self.application, "executableURL", ctypes.c_void_p)
        path = self._send(url, "path", ctypes.c_void_p) if url else None
        raw = self._send(path, "UTF8String", ctypes.c_char_p) if path else None
        if not raw:
            raise TopologyUnavailable("Captured Cocoa executable URL unavailable")
        return Path(os.fsdecode(raw)).resolve(strict=True)

    def terminate(self):
        return bool(self._send(self.application, "terminate", ctypes.c_bool))

    def close(self):
        if self.pool:
            self._send(self.pool, "drain", None)
            self.pool = None


class CocoaAppTermination:
    def __init__(self, process_probe=mac_process_probe, application_for_pid=_CocoaApplication):
        self.probe, self.application_for_pid = process_probe, application_for_pid

    def terminate(self, expected):
        if not isinstance(expected, ProcessIdentity) or self.probe(expected.pid) != expected:
            raise UpgradeRefused("Captured app PID/start/executable changed before normal termination")
        application = self.application_for_pid(expected.pid)
        try:
            executable = application.executable()
            if (application.pid() != expected.pid or executable != expected.executable
                    or identity(executable) != expected.file_identity
                    or self.probe(expected.pid) != expected or application.pid() != expected.pid):
                raise UpgradeRefused("Cocoa receiver is not the captured selected application")
            if application.terminate() is not True:
                raise StopIncomplete("Captured application declined normal termination; no force fallback")
        finally:
            application.close()


class MacProcessTable:
    def __init__(self, ps_command):
        self.ps_command = ps_command

    def rows(self, commands):
        raw = commands.run(self.ps_command, ("-U", str(os.getuid()), "-o", "pid=,ppid="))
        rows = {}
        for line in raw.decode("ascii").splitlines():
            parts = line.split()
            if len(parts) != 2 or not all(s.isdecimal() for s in parts):
                raise TopologyUnavailable("Native PID/parent table unavailable")
            pid, parent = map(int, parts)
            if pid <= 0 or pid in rows:
                raise TopologyUnavailable("Native PID table is ambiguous")
            rows[pid] = parent
        return rows


def listener_inactive(endpoint):
    try:
        connection = socket.create_connection(endpoint, timeout=0.3)
    except OSError as error:
        if error.errno == errno.ECONNREFUSED:
            return True
        raise TopologyUnavailable("Selected listener state is unknown") from error
    connection.close()
    return False


def runtime_inventory(root):
    """The selected current runtime_launch.py inventory shape, without exec."""
    canonical(root)
    root_info = root.lstat()
    if root_info.st_uid != os.getuid() or root_info.st_mode & 0o022:
        raise UpgradeRefused("Runtime root owner/write permissions changed")
    files, links, directories = {}, {}, []
    for base, dirs, names in os.walk(root, followlinks=False):
        for name in sorted(dirs + names):
            path = Path(base) / name
            relative = str(path.relative_to(root))
            info = path.lstat()
            if info.st_uid != os.getuid():
                raise UpgradeRefused("Runtime artifact owner changed")
            if stat.S_ISLNK(info.st_mode):
                if not path.resolve(strict=True).is_relative_to(root):
                    raise UpgradeRefused("Runtime link escapes immutable root")
                links[relative] = os.readlink(path)
            elif stat.S_ISDIR(info.st_mode):
                if info.st_mode & 0o022:
                    raise UpgradeRefused("Runtime directory is writable by another principal")
                directories.append(relative)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode & 0o022:
                files[relative] = digest(path)
            else:
                raise UpgradeRefused("Unsupported/aliased runtime artifact")
    return {"files": files, "links": links, "directories": sorted(directories)}


@dataclass
class MiniRuntimeStage:
    """Render a fresh Mini app+service closure from the exact current deployment.

    No historical root/rollback defaults. Only the selected current owned-child
    Paseo role is supported. All other profile/plist fields are preserved; unknown
    role/topology/schema refuses rather than guessing a new launch architecture.
    """
    old_root: Path
    new_root: Path
    selector: Path
    launch: FilePin
    runtime_launch: FilePin
    profiles: FilePin
    manifest: FilePin
    python: FilePin
    used_bytes: int = 0

    def prepare_parents(self, tx):
        canonical(self.old_root)
        canonical(self.new_root.parent)
        require_seal(tx.plan.source, tx.plan.seal)
        from upgrade_space import bundle_footprint
        if bundle_footprint(tx.plan.source) != tx.plan.measured:
            raise UpgradeRefused("Measured sealed source changed before Mini parent writes")
        if (os.path.lexists(self.new_root) or tx.plan.release != self.new_root / "app/Fulcra.app"
                or self.new_root.is_relative_to(self.old_root)
                or any(self.new_root.is_relative_to(root) or root.is_relative_to(self.new_root)
                       for root in (tx.plan.installed, tx.plan.home, *tx.plan.preserve_roots))):
            raise UpgradeRefused("Fresh independent Mini immutable root required")
        for target in (tx.plan.release, tx.plan.install_stage, tx.plan.rollback, tx.plan.metadata,
                       tx._guard_slot()):
            if os.path.lexists(target):
                raise UpgradeRefused("Mini preparation target is already occupied")
        for pin, name in ((self.launch, "service/launch.py"),
                          (self.runtime_launch, "service/runtime_launch.py"),
                          (self.profiles, "service/profiles.json"),
                          (self.manifest, "daemon-manifest.json")):
            if pin.path != self.old_root / name:
                raise UpgradeRefused("Selected current helper layout differs")
            pin.validate()
        self.python.validate()
        if (self.profiles.path.stat().st_size > 65536
                or self.manifest.path.stat().st_size > SEAL_BUDGET):
            raise UpgradeRefused("Current runtime metadata exceeds its bound")
        self.profile_data = json.loads(self.profiles.path.read_bytes())
        self.manifest_data = json.loads(self.manifest.path.read_bytes())
        self.prior_plist = read_state(self.selector)
        if (self.profile_data.get("version") != 1
                or set(self.profile_data.get("roles", {})) != {"paseo"}
                or self.manifest_data.get("version") != 1
                or set(self.manifest_data.get("roles", {})) != {"paseo"}
                or self.profile_data["roles"]["paseo"].get("topology") != "owned-child"):
            raise TopologyUnavailable("Only the selected current owned-child runtime can be rendered")
        old_app = self.old_root / "app/Fulcra.app"
        expected_roots = {str(old_app), str(self.old_root / "service")}
        if set(self.manifest_data.get("roots", {})) != expected_roots:
            raise UpgradeRefused("Current runtime inventory roots differ")
        for root, inventory in self.manifest_data["roots"].items():
            if runtime_inventory(Path(root)) != inventory:
                raise UpgradeRefused("Current deployed runtime bytes differ from selected manifest")
        external = self.manifest_data.get("externalPins", {})
        expected_external = {str(self.python.path): {"resolved": str(self.python.resolved),
                                                   "sha256": self.python.sha256}}
        if external != expected_external:
            raise UpgradeRefused("Current external Python launcher pin differs")
        old_argv = (str(self.python.path), str(self.runtime_launch.path), str(self.manifest.path),
                    self.manifest.sha256, "paseo")
        plist = plistlib.loads(self.prior_plist.data)
        if (self.prior_plist.kind != "file" or plist.get("ProgramArguments") != list(old_argv)
                or self.selector not in [s.path for s in tx.plan.selectors]):
            raise UpgradeRefused("Live plist is not the selected current immutable runtime")
        self.old_program = old_argv
        for directory in (self.new_root, self.new_root / "app"):
            check = check_space(tx.plan.source, **tx.plan.layout(), phase="stage",
                                expected_devices=tx.devices, statvfs=tx.statvfs)
            tx.devices = check["devices"]
            if tx.used_bytes + 4096 > METADATA_BUDGET:
                raise UpgradeRefused("Total legacy metadata budget exceeded")
            tx.used_bytes += 4096
            directory.mkdir(mode=0o700)
            self.used_bytes += 4096
        self.anchors = {path: identity(path) for path in (self.new_root, self.new_root / "app")}

    def _write(self, tx, action, amount):
        if tx.used_bytes + amount > METADATA_BUDGET:
            raise UpgradeRefused("Total legacy metadata budget exceeded")
        if self.used_bytes + amount > SEAL_BUDGET:
            raise UpgradeRefused("Mini service/profile/manifest exceeded 16 MiB seal allocation")
        if any(identity(path) != recorded for path, recorded in self.anchors.items()):
            raise UpgradeRefused("Mini immutable staging parent identity changed")
        check_space(tx.plan.source, **tx.plan.layout(), phase="installer",
                    expected_devices=tx.devices, statvfs=tx.statvfs)
        self.used_bytes += amount
        tx.used_bytes += amount
        action()

    def render(self, tx):
        require_seal(tx.plan.release, tx.plan.seal)
        if read_state(self.selector) != self.prior_plist:
            raise UpgradeRefused("Current launchd selector changed during Mini staging")
        service = self.new_root / "service"
        self._write(tx, lambda: service.mkdir(mode=0o700), 4096)
        self.anchors[service] = identity(service)
        for pin in (self.launch, self.runtime_launch):
            pin.validate()
            raw = pin.path.read_bytes()
            self._write(tx, lambda path=service / pin.path.name, raw=raw:
                        tx._exclusive_bytes(path, raw, 0o400), len(raw) + 4096)
        def relocate(value):
            if isinstance(value, str) and value.startswith(str(self.old_root) + "/"):
                return str(self.new_root) + value[len(str(self.old_root)):]
            if isinstance(value, list):
                return [relocate(item) for item in value]
            if isinstance(value, dict):
                return {relocate(key): relocate(item) for key, item in value.items()}
            return value
        profile = relocate(self.profile_data)
        role = profile["roles"]["paseo"]
        if (role["env"].get("PASEO_HOME") != str(tx.plan.home)
                or role["env"].get("PASEO_LISTEN") !=
                f"127.0.0.1:{tx.host.selection.listen[1]}"
                or role["env"].get("FULCRA_COMMAND_CENTRE") != "1"
                or role["env"].get("ELECTRON_RUN_AS_NODE") != "1"):
            raise UpgradeRefused("Current private home/listener/owned-child configuration differs")
        for name in role["required"]:
            canonical(Path(name))
        role["pins"] = {name: digest(Path(name)) for name in role["pins"]}
        profile_raw = json.dumps(profile, sort_keys=True, separators=(",", ":")).encode()
        if len(profile_raw) > 65536:
            raise UpgradeRefused("Rendered deployment profile exceeds current helper bound")
        profile_path = service / "profiles.json"
        self._write(tx, lambda: tx._exclusive_bytes(profile_path, profile_raw, 0o400), len(profile_raw) + 4096)
        import hashlib
        profile_hash = hashlib.sha256(profile_raw).hexdigest()
        manifest = {"version": 1, "externalPins": self.manifest_data["externalPins"],
                    "roots": {str(tx.plan.release): runtime_inventory(tx.plan.release),
                              str(service): runtime_inventory(service)},
                    "roles": {"paseo": [str(self.python.path), str(service / "launch.py"),
                                          str(profile_path), profile_hash, "paseo"]}}
        raw = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        manifest_path = self.new_root / "daemon-manifest.json"
        self._write(tx, lambda: tx._exclusive_bytes(manifest_path, raw, 0o400), len(raw) + 4096)
        new_argv = (str(self.python.path), str(service / "runtime_launch.py"), str(manifest_path),
                    hashlib.sha256(raw).hexdigest(), "paseo")
        old_plist = plistlib.loads(self.prior_plist.data)
        new_plist = {**old_plist, "ProgramArguments": list(new_argv)}
        if {k: v for k, v in old_plist.items() if k != "ProgramArguments"} != {
                k: v for k, v in new_plist.items() if k != "ProgramArguments"}:
            raise UpgradeRefused("Unexpected launchd field change")
        rendered = FileState("file", plistlib.dumps(new_plist, sort_keys=False), self.prior_plist.mode)
        tx.plan = replace(tx.plan, selectors=tuple(Selector(s.path, rendered) if s.path == self.selector
                                                   else s for s in tx.plan.selectors))
        tx.host.selection = replace(tx.host.selection, old_program_argv=self.old_program,
                                   new_program_argv=new_argv,
                                   old_runtime_pins=(self.python, self.launch, self.runtime_launch,
                                                     self.profiles, self.manifest),
                                   new_runtime_pins=tuple(FilePin.capture(path) for path in
                                         (self.python.path, service / "launch.py", service / "runtime_launch.py",
                                          profile_path, manifest_path)))
        for path in self.anchors:
            tx._remember(path)
        # New CLI may target this fresh immutable app. Its expected byte pins are
        # supplied from the sealed source, then validated after copy by host.bind.
        self.rendered_program = new_argv


class MacLegacyHost:
    """Concrete selected local host commands; no global lease/inventory promise."""
    def __init__(self, selection, *, table, process_probe=mac_process_probe,
                 listener_probe=listener_inactive, app_locator=None, image_validator=None,
                 app_termination=None,
                 clock=time.monotonic, sleep=time.sleep):
        self.selection, self.table = selection, table
        self.probe, self.listener_probe = process_probe, listener_probe
        self.clock, self.sleep = clock, sleep
        self.app_locator = app_locator
        self.image_validator = image_validator
        self.app_termination = app_termination or CocoaAppTermination(process_probe)
        self.transaction = None
        self.commands = None

    def bind(self, transaction):
        self.transaction = transaction
        self.commands = BoundedCommands(transaction._before_command, transaction._charge_output)
        s = self.selection
        if (not isinstance(s, HostSelection) or s.topology not in ("mini-launchd", "book-desktop")
                or not isinstance(s.selected_roots, tuple) or not s.selected_roots
                or any(not isinstance(p, ProcessIdentity) for p in s.selected_roots)
                or len({p.pid for p in s.selected_roots}) != len(s.selected_roots)
                or not isinstance(s.old_bundles, tuple) or not isinstance(s.new_bundles, tuple)
                or not s.old_bundles or not s.new_bundles
                or any(not isinstance(b, BundlePin) for b in (*s.old_bundles, *s.new_bundles))
                or not isinstance(s.listen, tuple) or len(s.listen) != 2
                or s.listen[0] != "127.0.0.1" or type(s.listen[1]) is not int
                or not 1 <= s.listen[1] <= 65535 or not 0 < s.stop_timeout <= 60):
            raise TopologyUnavailable("Explicit selected legacy host topology required")
        required_old = BundlePin(transaction.plan.installed, transaction.old_seal)
        required_new = {BundlePin(transaction.plan.installed, transaction.plan.seal),
                        BundlePin(transaction.plan.release, transaction.plan.seal)}
        if required_old not in s.old_bundles or not required_new.issubset(set(s.new_bundles)):
            raise TopologyUnavailable("Both installed and immutable app routes must be byte bound")
        if transaction.plan.desktop_managed != (s.topology == "book-desktop"):
            raise TopologyUnavailable("Selected deployment ownership does not match plan")
        if s.topology == "book-desktop" and s.app_process is None:
            raise TopologyUnavailable("Book requires a captured packaged app lifetime")
        if s.app_process is not None:
            if (s.app_process not in s.selected_roots or s.open_command is None
                    or not isinstance(s.bundle_id, str)
                    or not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+", s.bundle_id)):
                raise TopologyUnavailable("Captured app and pinned Quit/relaunch route required")
            info = transaction.plan.installed / "Contents/Info.plist"
            if plistlib.loads(info.read_bytes()).get("CFBundleIdentifier") != s.bundle_id:
                raise UpgradeRefused("Selected app bundle identifier differs")
            if self._find_app() != s.app_process:
                raise UpgradeRefused("Selected app kernel lifetime/image differs")
        if s.topology == "mini-launchd":
            if (s.launchctl is None or s.plist_selector not in [x.path for x in transaction.plan.selectors]
                    or not isinstance(s.launchd_label, str)
                    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", s.launchd_label)):
                raise TopologyUnavailable("Selected launchd label/plist/pinned command required")
            old = transaction.prior_selectors[s.plist_selector]
            new = next(x.replacement for x in transaction.plan.selectors if x.path == s.plist_selector)
            self._validate_plist(old, s.old_program_argv, s.old_runtime_pins)
            self._validate_plist(new, s.new_program_argv, s.new_runtime_pins, verify_files=False)
            prior, candidate = plistlib.loads(old.data), plistlib.loads(new.data)
            if {k: v for k, v in prior.items() if k != "ProgramArguments"} != {
                    k: v for k, v in candidate.items() if k != "ProgramArguments"}:
                raise UpgradeRefused("Legacy staging must preserve every other launchd field")
        self.validate_bytes(new=False)
        self.validate_staged_new()

    def _find_app(self):
        if self.app_locator is not None:
            # Fixture/native observation port only; production default binds the
            # exact sealed packaged main executable, never a process title.
            return self.app_locator()
        main = (self.transaction.plan.installed / "Contents/MacOS/Fulcra").resolve(strict=True)
        matches = [self.probe(pid) for pid in self.table.rows(self.commands)]
        matches = [p for p in matches if p is not None and p.executable == main]
        if len(matches) != 1:
            raise TopologyUnavailable("Selected packaged app lifetime is ambiguous")
        return matches[0]

    def validate_staged_new(self):
        p = self.transaction.plan
        def staged(path):
            return p.install_stage / path.relative_to(p.installed) if path.is_relative_to(p.installed) else path
        for bundle in self.selection.new_bundles:
            require_seal(staged(bundle.path), bundle.seal)
        for pin in (*self.selection.new_cli.pins, *self.selection.new_runtime_pins):
            target = staged(pin.path)
            candidate = replace(pin, path=target, resolved=staged(pin.resolved),
                                inode=None if target != pin.path else pin.inode)
            candidate.validate()

    def _validate_plist(self, state, argv, pins, *, verify_files=True):
        if state.kind != "file":
            raise UpgradeRefused("Selected launchd plist must be a regular captured file")
        data = plistlib.loads(state.data)
        if (data.get("Label") != self.selection.launchd_label
                or data.get("ProgramArguments") != list(argv) or len(argv) != 5
                or argv[4] != "paseo" or not re.fullmatch(r"[0-9a-f]{64}", argv[3])):
            raise UpgradeRefused("Reviewed launchd program selection differs")
        if any(Path(token) not in {p.path for p in pins} for token in argv[:3]):
            raise UpgradeRefused("Launchd executable/helper/manifest must all be byte pinned")
        if next(p.sha256 for p in pins if p.path == Path(argv[2])) != argv[3]:
            raise UpgradeRefused("Launchd manifest hash argument differs")
        if verify_files:
            for pin in pins:
                pin.validate()

    def validate_bytes(self, *, new):
        s = self.selection
        for bundle in s.new_bundles if new else s.old_bundles:
            bundle.validate()
        for pin in s.new_runtime_pins if new else s.old_runtime_pins:
            pin.validate()
        (s.new_cli if new else s.old_cli).validate()
        for command in (s.launchctl, s.open_command):
            if command is not None:
                command.validate()

    def _json(self, tail, *, new=False):
        raw = self.commands.run(self.selection.new_cli if new else self.selection.old_cli, tail)
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError) as error:
            raise TopologyUnavailable("Selected public native CLI returned invalid JSON") from error

    def _status(self, *, new=False):
        p = self.transaction.plan
        data = self._json(("--home", str(p.home), "daemon", "status", "--json"), new=new)
        if (not isinstance(data, dict) or data.get("home") != str(p.home)
                or data.get("desktopManaged") is not p.desktop_managed
                or data.get("localDaemon") != "running" or data.get("connectedDaemon") != "reachable"
                or data.get("listen") != f"127.0.0.1:{self.selection.listen[1]}"
                or any(type(data.get(k)) is not int or data[k] <= 1 for k in ("pid", "workerPid"))
                or not isinstance(data.get("startedAt"), str) or not data["startedAt"]
                or not isinstance(data.get("serverId"), str) or not data["serverId"]):
            raise TopologyUnavailable("Selected public daemon topology is unavailable or changed")
        return data

    def _sessions(self, *, new=False, allow_busy=False):
        home = str(self.transaction.plan.home)
        rows = self._json(("--home", home, "ls", "-a", "-g", "--json"), new=new)
        if not isinstance(rows, list) or len(rows) > 8192:
            raise TopologyUnavailable("Public global session list unavailable")
        views, seen = [], set()
        for row in rows:
            sid = row.get("id") if isinstance(row, dict) else None
            if (not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", sid)
                    or sid in seen):
                raise TopologyUnavailable("Public session IDs missing/ambiguous")
            seen.add(sid)
            info = self._json(("--home", home, "inspect", sid, "--json"), new=new)
            if (not isinstance(info, dict) or info.get("Id") != sid
                    or info.get("Status") not in ("idle", "closed", "error", "running", "initializing")
                    or not isinstance(info.get("PendingPermissions"), list)):
                raise TopologyUnavailable("Known public native session status is unknown")
            if info["Status"] == "error" and not allow_busy:
                raise TopologyUnavailable("Public error state cannot establish a quiet owner window")
            busy = (info["Status"] in ("running", "initializing") or bool(info["PendingPermissions"])
                    or info.get("ActiveTurn") is not None or info.get("activeTurn") is not None)
            if busy and not allow_busy:
                raise Busy("Known public session is busy/awaiting permission; owner window cannot exempt it")
            views.append((sid, info["Status"], bool(info["PendingPermissions"])))
        again = self._json(("--home", home, "ls", "-a", "-g", "--json"), new=new)
        if (not isinstance(again, list) or {r.get("id") for r in again if isinstance(r, dict)} != seen
                or len(again) != len(seen)):
            raise TopologyUnavailable("Public session set changed during non-atomic observation")
        return tuple(views)

    def _tree(self, roots, bundles):
        rows = self.table.rows(self.commands)
        selected = {p.pid for p in roots}
        if not selected.issubset(rows):
            raise UpgradeRefused("Captured deployment root is missing or changed")
        while True:
            children = {pid for pid, parent in rows.items() if parent in selected}
            expanded = selected | children
            if expanded == selected:
                break
            selected = expanded
        processes = {}
        for pid in rows:
            current = self.probe(pid)
            if current is None:
                if pid in selected:
                    raise TopologyUnavailable("Selected process exited during capture")
                continue
            if any(current.executable.is_relative_to(bundle.path) for bundle in bundles):
                if pid not in selected:
                    raise TopologyUnavailable("Unmatched process still uses a selected app/runtime path")
            if pid in selected:
                processes[pid] = current
        if any(processes.get(p.pid) != p for p in roots):
            raise UpgradeRefused("Captured kernel deployment/helper lifetime changed")
        return tuple(processes[pid] for pid in sorted(processes))

    def observe(self, *, new=False, allow_busy=False):
        self.validate_bytes(new=new)
        status = self._status(new=new)
        sessions = self._sessions(new=new, allow_busy=allow_busy)
        observed = self._status(new=new)
        keys = ("home", "pid", "startedAt", "workerPid", "serverId", "desktopManaged", "listen")
        if any(observed[k] != status[k] for k in keys):
            raise UpgradeRefused("Daemon boot/lifetime changed during public observation")
        if new:
            roots = tuple(self.probe(pid) for pid in sorted({status["pid"], status["workerPid"]}))
            if any(p is None for p in roots):
                raise TopologyUnavailable("Replacement kernel processes unavailable")
            if self.selection.app_process is not None:
                app = self._find_app()
                if app not in roots:
                    roots += (app,)

            bundles = self.selection.new_bundles
        else:
            roots, bundles = self.selection.selected_roots, self.selection.old_bundles
            if not {status["pid"], status["workerPid"]}.issubset({p.pid for p in roots}):
                raise TopologyUnavailable("Selected roots do not bind public supervisor/worker")
        processes = self._tree(roots, bundles)
        for role_pid in (status["pid"], status["workerPid"]):
            process = next(p for p in processes if p.pid == role_pid)
            matches = (self.image_validator(process, bundles) if self.image_validator is not None
                       else any(process.executable.is_relative_to(b.path) for b in bundles))
            if matches is not True:
                raise TopologyUnavailable("Public daemon process does not use a selected pinned app image")
        return LegacyObservation(status["serverId"], status["pid"], status["startedAt"],
                                 status["workerPid"], sessions, processes, self.clock())

    def same_deployment(self, before, after):
        if ((before.server_id, before.supervisor_pid, before.started_at, before.worker_pid, before.processes)
                != (after.server_id, after.supervisor_pid, after.started_at, after.worker_pid, after.processes)):
            raise UpgradeRefused("Selected boot/kernel tree changed since preparation")

    def stop(self, captured):
        self.same_deployment(captured, self.observe())
        s = self.selection
        if s.topology == "mini-launchd":
            self.commands.run(s.launchctl, ("bootout", f"gui/{os.getuid()}/{s.launchd_label}"),
                              action=True, timeout=s.stop_timeout + 2)
        else:
            self.commands.run(s.old_cli, ("--home", str(self.transaction.plan.home), "daemon", "stop",
                                         "--timeout", str(s.stop_timeout), "--json"),
                              action=True, timeout=s.stop_timeout + 2)
        if s.app_process is not None and self.probe(s.app_process.pid) is not None:
            if self.probe(s.app_process.pid) != s.app_process:
                raise UpgradeRefused("App lifetime changed before normal Quit")
            self.transaction._before_command(True)
            self.commands.action_count += 1
            self.app_termination.terminate(s.app_process)
        deadline = self.clock() + s.stop_timeout
        while True:
            try:
                self.assert_old_absent(captured)
                break
            except StopIncomplete:
                if self.clock() >= deadline:
                    raise StopIncomplete("Selected legacy deployment/helper survived stop; no adapter kill")
                self.sleep(0.1)
        stopped = self._json(("--home", str(self.transaction.plan.home), "daemon", "status", "--json"))
        if (not isinstance(stopped, dict) or stopped.get("home") != str(self.transaction.plan.home)
                or stopped.get("localDaemon") != "stopped" or stopped.get("pid") is not None
                or stopped.get("connectedDaemon") == "reachable"):
            raise StopIncomplete("Selected home remains active after legacy stop")

    def assert_old_absent(self, captured, *, check_listener=True):
        if self.commands.uncertain:
            raise CommandUncertain("Unresolved selected command blocks path replacement")
        for expected in captured.processes:
            try:
                current = self.probe(expected.pid)
            except (UpgradeRefused, TopologyUnavailable):
                # A process can disappear between libproc's two reads during an
                # explicitly requested stop. Only a fresh kernel absence resolves
                # that observation; a repeated unknown/different lifetime refuses.
                current = self.probe(expected.pid)
            if current is not None:
                if current != expected:
                    raise UpgradeRefused("Captured PID was reused; explicit recovery required")
                raise StopIncomplete("Captured deployment/helper is still alive")
        if check_listener and not self.listener_probe(self.selection.listen):
            raise StopIncomplete("Selected listener is still occupied")
        if check_listener:
            # Before restart, any process using the selected old binary route is a
            # survivor/relaunch. This is an explicit selected-path check, not names.
            for pid in self.table.rows(self.commands):
                current = self.probe(pid)
                if current is not None and any(current.executable.is_relative_to(b.path)
                        for b in self.selection.old_bundles):
                    raise StopIncomplete("A selected old binary route is still in use")

    def start(self, *, prior=False):
        s = self.selection
        self.validate_bytes(new=not prior)
        if s.topology == "mini-launchd":
            self.commands.run(s.launchctl, ("bootstrap", f"gui/{os.getuid()}", str(s.plist_selector)),
                              action=True)
        if s.app_process is not None:
            self.commands.run(s.open_command, ("-n", "-a", str(self.transaction.plan.installed)),
                              action=True)


class LegacyFirstCutover(Upgrade):
    """Reuse only strict byte preparation/guard/rename mechanics, never its lease."""
    def __init__(self, plan, host, *, mini_runtime=None, external_report=None, **kwargs):
        super().__init__(plan, **kwargs)
        self.mini_runtime = mini_runtime
        self.external_report = external_report
        self.report_devices = None
        self.host = host
        self.captured = None
        self.owner_window = False
        self.stop_confirmed = False
        self.restart_started = False
        self.staged_selectors = {}
        self.legacy_observation = None

    def _charge_output(self, count):
        if self.used_bytes + count + self._remaining_selector_bytes() > METADATA_BUDGET:
            raise CommandUncertain("Total legacy metadata/output budget exceeded")
        self.used_bytes += count

    def _before_command(self, action):
        if action and not self.owner_window:
            raise OwnerWindowRequired("No explicit owner stop/start window selected")
        self._guard("cutover")

    def _write(self, phase, action, *, byte_count=0):
        if self.stop_confirmed:
            self.host.assert_old_absent(self.captured, check_listener=not self.restart_started)
        return super()._write(phase, action, byte_count=byte_count)

    def prepare(self):
        if self.external_report is not None:
            canonical(self.external_report, exists=False)
            canonical(self.external_report.parent)
            if os.path.lexists(self.external_report):
                raise UpgradeRefused("External report target is already occupied")
            checked = check_space(self.plan.source, **{**self.plan.layout(), "metadata": self.external_report},
                                  phase="stage", statvfs=self.statvfs)
            self.report_devices = checked["devices"]
        if self.host.selection.topology == "mini-launchd" and self.mini_runtime is None:
            raise TopologyUnavailable("Mini needs concrete fresh app/service/profile/manifest staging")
        if self.mini_runtime is not None:
            self.mini_runtime.prepare_parents(self)
            original_copy = self.copytree
            def copy_with_runtime(source, target, **kwargs):
                original_copy(source, target, **kwargs)
                if target == self.plan.release:
                    self.mini_runtime.render(self)
            self.copytree = copy_with_runtime
        super().prepare()
        self.host.bind(self)
        for index, selector in enumerate(self.plan.selectors):
            target = self.plan.metadata / f"selector-{index}.next"
            value = selector.replacement
            def stage(path=target, value=value):
                if value.kind == "link":
                    os.symlink(value.data.decode(), path)
                    if hasattr(os, "lchmod"):
                        os.lchmod(path, value.mode)
                else:
                    self._exclusive_bytes(path, value.data, value.mode)
                    os.chmod(path, value.mode)
            self._write("cutover", stage, byte_count=len(value.data) + 4096)
            self.selector_states[target] = (identity(target), read_state(target))
            self.staged_selectors[selector.path] = target
        self.captured = self.host.observe(allow_busy=True)
        self.legacy_observation = self.captured
        if self.external_report is not None:
            self._report_preparation()
        return self

    def _report_preparation(self):
        report = self.external_report
        canonical(report.parent)
        if os.path.lexists(report) or any(report.is_relative_to(root) for root in
                                        (self.plan.home, *self.plan.preserve_roots)):
            raise UpgradeRefused("External report must be a fresh owned non-state path")
        layout = {**self.plan.layout(), "metadata": report}
        checked = check_space(self.plan.source, **layout, phase="cutover", statvfs=self.statvfs,
                              expected_devices=self.report_devices)
        self.report_devices = checked["devices"]
        raw = json.dumps({"mode": "legacy-first-cutover", "globalComplete": False, "atomic": False,
                          "residuals": RESIDUALS, "sourceSeal": self.plan.seal,
                          "supervisorPid": self.captured.supervisor_pid,
                          "serverId": self.captured.server_id}).encode()
        self._write("cutover", lambda: self._exclusive_bytes(report, raw), byte_count=len(raw) + 4096)

    def _replace_selector(self, path, value):
        staged = self.staged_selectors[path]
        if read_state(staged) != value:
            raise UpgradeRefused("Non-live staged selector changed")
        self._write("cutover", lambda: swap_existing(staged, path), byte_count=4096)
        self.selector_states[path] = (identity(path), value)
        self.selector_states[staged] = (identity(staged), self.prior_selectors[path])
        self.retained_selectors[path] = staged
        self.changed_selectors.add(path)
        if identity(staged) != self.prior_selector_ids[path]:
            raise UpgradeRefused("Prior selector identity changed at exchange")

    def cutover(self, *, owner_window_selected=False):
        if owner_window_selected is not True:
            raise OwnerWindowRequired("Legacy cutover requires the explicit owner-selected window")
        if self.state != "prepared" or self.captured is None:
            raise UpgradeRefused("Verified legacy preparation required")
        self._verify_prepared()
        self._guard("cutover")
        self.host.validate_staged_new()
        self.host.same_deployment(self.captured, self.host.observe())
        self.owner_window = True
        try:
            self.host.stop(self.captured)
            self.stop_confirmed = True
            self.state = "stopped"
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
            self._settings_unchanged()
            self.host.assert_old_absent(self.captured)
            self.restart_started = True
            self.host.start()
            self.legacy_observation = self.host.observe(new=True)
            self.state = "installed"
        except BaseException:
            if self.host.commands.action_count and self.state != "installed":
                self.state = "legacy-recovery-required"
            raise
        finally:
            self.owner_window = False
        return self

    def rollback(self, *, owner_window_selected=False):
        if owner_window_selected is not True:
            raise OwnerWindowRequired("Legacy binary rollback requires a new explicit owner window")
        if self.state != "installed":
            raise UpgradeRefused("Partial legacy failure requires explicit recovery; no automatic retry")
        self._paths_unchanged()
        require_seal(self.plan.rollback, self.old_seal)
        require_seal(self.plan.installed, self.plan.seal)
        current = self.host.observe(new=True)
        self.host.same_deployment(self.legacy_observation, current)
        # Stop selection for the replacement is bound to its freshly observed
        # lifetimes. The same normal deployment owner is used; no generic restart.
        original = self.host.selection
        self.host.selection = replace(original, old_cli=original.new_cli,
                                      old_bundles=original.new_bundles, selected_roots=current.processes,
                                      app_process=self.host._find_app() if original.app_process is not None else None)
        self.captured = current
        self.stop_confirmed = False
        self.restart_started = False
        self.owner_window = True
        try:
            self.host.stop(current)
            self.stop_confirmed = True
            self.state = "stopped"
            for selector in self.plan.selectors:
                if selector.path in self.changed_selectors:
                    self._restore_selector(selector.path)
            self._write("cutover", lambda: rename_fresh(self.plan.installed, self.plan.install_stage))
            self.new_moved = False
            self.bindings.pop(self.plan.installed)
            self._remember(self.plan.install_stage)
            self._write("cutover", lambda: rename_fresh(self.plan.rollback, self.plan.installed))
            self.old_moved = False
            self.bindings.pop(self.plan.rollback)
            self._remember(self.plan.installed)
            require_seal(self.plan.installed, self.old_seal)
            self.host.selection = original
            self.restart_started = True
            self.host.start(prior=True)
            # The old kernel lifetimes are gone; observe restored bytes with fresh
            # roots rather than reviving old PID authority or sending instructions.
            restored = replace(original, new_cli=original.old_cli, new_bundles=original.old_bundles,
                               new_runtime_pins=original.old_runtime_pins)
            self.host.selection = restored
            self.legacy_observation = self.host.observe(new=True)
            self.state = "rolled-back"
        finally:
            self.host.selection = original
            self.owner_window = False
        return self
