"""Space preflight for an existing Mac upgrade; never stops or changes services.

Compilation uses release/package.sh's separate 9/25 GiB floors. This guard
counts additional upgrade writes on their actual destination filesystems.
"""
import argparse
import json
import os
import stat
from dataclasses import asdict, dataclass
from pathlib import Path

GIB = 2**30
MIB = 2**20
# Retain the previous system-volume reserve. External upgrade writes are bounded
# metadata, not the build's caches; reserve 1 GiB beyond their 64 MiB budget.
SYSTEM_RESERVE = 9 * GIB
METADATA_RESERVE = GIB
METADATA_BUDGET = 64 * MIB
SEAL_BUDGET = 16 * MIB


class SpaceRefused(RuntimeError):
    pass


@dataclass(frozen=True)
class Footprint:
    logical: int
    allocated: int
    entries: int

    def __post_init__(self):
        for value in (self.logical, self.allocated, self.entries):
            if type(value) is not int or value < 0:
                raise SpaceRefused("Invalid measured bundle footprint")
        if self.entries == 0 or self.logical == 0:
            raise SpaceRefused("Empty measured bundle footprint")

    @property
    def copy_bound(self):
        # APFS clones are optional. Charge full independent copies, plus one
        # allocation block per entry even if the source is sparse/compressed.
        return max(self.logical, self.allocated) + self.entries * 4096


def bundle_footprint(bundle):
    bundle = Path(bundle)
    if not bundle.is_absolute() or bundle.resolve(strict=True) != bundle:
        raise SpaceRefused("Bundle must be an existing canonical directory")
    if not bundle.is_dir():
        raise SpaceRefused("Bundle directory missing")
    logical = allocated = entries = 0
    for root, directories, files in os.walk(bundle, followlinks=False):
        for name in directories + files:
            path = Path(root) / name
            info = path.lstat()
            entries += 1
            allocated += info.st_blocks * 512
            if stat.S_ISREG(info.st_mode):
                logical += info.st_size
            elif stat.S_ISLNK(info.st_mode):
                if not path.resolve(strict=True).is_relative_to(bundle):
                    raise SpaceRefused("Bundle link escapes its root")
            elif not stat.S_ISDIR(info.st_mode):
                raise SpaceRefused("Unsupported bundle entry")
    return Footprint(logical, allocated, entries)


def destination_directory(path):
    """Resolve the actual mount without creating any destination or directory."""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise SpaceRefused("Destination must be absolute without parent traversal")
    current = path
    while not os.path.lexists(current):
        current = current.parent
    if current.is_symlink() or current.resolve(strict=True) != current:
        raise SpaceRefused("Destination ancestor is not canonical")
    if not current.is_dir():
        current = current.parent
    return current


def check_space(bundle, *, release, install_stage, installed, rollback,
                metadata, incoming=None, phase="stage", expected_devices=None, statvfs=os.statvfs):
    """Check immediately before an owned write or cutover, then recheck each boundary.

    stage: two full candidate copies (immutable release + installer temp), and
    another full copy for a failed clone/ditto temp retained for inspection.
    cutover: those copies already exist; only bounded seal/metadata writes remain.
    Existing installed/rollback bytes are measured but not double charged: the
    cutover must rename the old app on the same filesystem, never duplicate it.
    """
    if phase not in ("receive", "stage", "cutover"):
        raise SpaceRefused("Unknown upgrade phase")
    # A receive check uses the exact footprint measured on the build host before
    # copying any candidate bytes. Stage/cutover always measure local bytes anew.
    if phase == "receive":
        if not isinstance(bundle, Footprint) or incoming is None:
            raise SpaceRefused("Receive requires measured footprint and incoming destination")
        new = bundle
    else:
        new = bundle_footprint(bundle)
    old = bundle_footprint(installed)
    paths = {"release": release, "install_stage": install_stage,
             "installed": installed, "rollback": rollback, "metadata": metadata}
    if incoming is not None:
        paths["incoming"] = incoming
    directories = {key: destination_directory(value) for key, value in paths.items()}
    devices = {key: directory.stat().st_dev for key, directory in directories.items()}
    if expected_devices is not None and devices != expected_devices:
        raise SpaceRefused("Destination filesystem changed since preflight")
    if not devices["installed"] == devices["install_stage"] == devices["rollback"]:
        raise SpaceRefused("App replacement and retained rollback require same-filesystem rename")
    if os.path.lexists(rollback):
        raise SpaceRefused("Rollback target already exists; refuse overwrite")
    if phase in ("receive", "stage"):
        if os.path.lexists(release) or os.path.lexists(install_stage):
            raise SpaceRefused("Stage destinations must be absent")
        if phase == "receive" and os.path.lexists(incoming):
            raise SpaceRefused("Incoming destination must be absent")
    elif not Path(install_stage).is_dir() or not Path(release).is_dir():
        raise SpaceRefused("Cutover requires both staged copies")

    volumes = {}
    def charge(key, amount, reserve, reason):
        device = devices[key]
        directory = directories[key]
        data = volumes.setdefault(device, {"device": device, "probe": str(directory),
                                          "additionalBytes": 0, "reserveBytes": 0,
                                          "writes": []})
        data["additionalBytes"] += amount
        data["reserveBytes"] = max(data["reserveBytes"], reserve)
        data["writes"].append({"destination": str(paths[key]), "bytes": amount, "reason": reason})

    if phase == "receive":
        charge("incoming", new.copy_bound, SYSTEM_RESERVE, "Received candidate; full transfer allocation")
    if phase in ("receive", "stage"):
        charge("release", new.copy_bound * 2, SYSTEM_RESERVE,
               "Immutable app plus a retained full failed-copy fallback; no APFS clone credit")
        charge("install_stage", new.copy_bound, SYSTEM_RESERVE, "Independent installer temporary app")
    else:
        charge("release", 0, SYSTEM_RESERVE, "Immutable release already occupies disk")
        charge("install_stage", 0, SYSTEM_RESERVE, "Installer temporary app already occupies disk")
    charge("release", SEAL_BUDGET, SYSTEM_RESERVE, "Seal source, manifests and service profile budget")
    charge("installed", 0, SYSTEM_RESERVE, "Retain prior app by rename; its occupied bytes remain")
    charge("metadata", METADATA_BUDGET, METADATA_RESERVE, "Bounded backup/roster/log writes; no history copy")
    failures = []
    for volume in volumes.values():
        usage = statvfs(volume["probe"])
        volume["availableBytes"] = usage.f_bavail * usage.f_frsize
        volume["requiredBytes"] = volume["additionalBytes"] + volume["reserveBytes"]
        volume["shortfallBytes"] = max(0, volume["requiredBytes"] - volume["availableBytes"])
        if volume["shortfallBytes"]:
            failures.append(f'{volume["probe"]}: short {volume["shortfallBytes"]} bytes')
    result = {"phase": phase, "candidate": asdict(new), "candidateCopyBound": new.copy_bound,
              "retainedInstalled": asdict(old), "devices": devices,
              "volumes": list(volumes.values()), "ok": not failures}
    if failures:
        error = SpaceRefused("Insufficient upgrade space: " + "; ".join(failures))
        error.analysis = result
        raise error
    return result


def guarded_write(bundle, layout, operation, *, phase="stage", expected_devices=None,
                  statvfs=os.statvfs):
    analysis = check_space(bundle, **layout, phase=phase,
                           expected_devices=expected_devices, statvfs=statvfs)
    operation()
    return analysis


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    for key in ("release", "install-stage", "installed", "rollback", "metadata"):
        parser.add_argument("--" + key, required=True)
    parser.add_argument("--incoming")
    parser.add_argument("--phase", choices=("receive", "stage", "cutover"), default="stage")
    parser.add_argument("--measured-footprint", action="store_true",
                        help="Receive only: bundle argument is build-host footprint JSON")
    args = vars(parser.parse_args())
    bundle = args.pop("bundle")
    try:
        if args.pop("measured_footprint"):
            if args["phase"] != "receive":
                raise SpaceRefused("Measured footprint only permitted before receive")
            bundle = Footprint(**json.loads(Path(bundle).read_text()))
        print(json.dumps(check_space(bundle, **args), indent=2))
        return 0
    except SpaceRefused as error:
        print(json.dumps({"error": str(error), "analysis": getattr(error, "analysis", None)}, indent=2))
        return 75


if __name__ == "__main__":
    raise SystemExit(main())
