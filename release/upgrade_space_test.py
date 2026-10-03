import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from upgrade_space import GIB, Footprint, SpaceRefused, bundle_footprint, check_space, guarded_write


class UpgradeSpaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.new = self.root / "candidate.app"
        self.old = self.root / "installed.app"
        for app, contents in ((self.new, b"new candidate"), (self.old, b"old app")):
            (app / "Contents").mkdir(parents=True)
            (app / "Contents" / "app.asar").write_bytes(contents)
        self.layout = dict(release=self.root / "release", install_stage=self.root / "installing.app",
                           installed=self.old, rollback=self.root / "rollback.app",
                           metadata=self.root / "metadata")

    def tearDown(self):
        self.temp.cleanup()

    def capacity(self, available):
        return lambda _: SimpleNamespace(f_bavail=available, f_frsize=1)

    def test_insufficient_space_refuses_before_stage_or_service_action(self):
        calls = []
        with self.assertRaises(SpaceRefused) as error:
            guarded_write(self.new, self.layout, lambda: calls.append("service change"),
                          statvfs=self.capacity(9 * GIB))
        self.assertFalse(calls)
        self.assertFalse(self.layout["release"].exists())
        self.assertEqual((self.old / "Contents/app.asar").read_bytes(), b"old app")
        self.assertGreater(error.exception.analysis["volumes"][0]["shortfallBytes"], 0)

    def test_staged_upgrade_and_rollback_preserve_actual_bytes(self):
        def stage():
            shutil.copytree(self.new, self.layout["release"])
            shutil.copytree(self.new, self.layout["install_stage"])
        analysis = guarded_write(self.new, self.layout, stage, statvfs=self.capacity(20 * GIB))
        def cutover():
            self.old.rename(self.layout["rollback"])
            self.layout["install_stage"].rename(self.old)
        # The real source and both destination trees exist. Check immediately
        # before the simulated service/app cutover on their actual filesystem.
        guarded_write(self.new, self.layout, cutover, phase="cutover",
                      expected_devices=analysis["devices"], statvfs=self.capacity(20 * GIB))
        self.assertEqual((self.old / "Contents/app.asar").read_bytes(), b"new candidate")
        self.assertEqual((self.layout["rollback"] / "Contents/app.asar").read_bytes(), b"old app")
        self.old.rename(self.root / "retained-new.app")
        self.layout["rollback"].rename(self.old)
        self.assertEqual((self.old / "Contents/app.asar").read_bytes(), b"old app")

    def test_cutover_rechecks_capacity_before_service_change(self):
        shutil.copytree(self.new, self.layout["release"])
        shutil.copytree(self.new, self.layout["install_stage"])
        called = []
        with self.assertRaises(SpaceRefused):
            guarded_write(self.new, self.layout, lambda: called.append(True), phase="cutover",
                          statvfs=self.capacity(1))
        self.assertFalse(called)
        self.assertTrue(self.old.exists())
        self.assertFalse(self.layout["rollback"].exists())

    def test_capacity_is_rechecked_between_release_and_installer_copy(self):
        first = guarded_write(self.new, self.layout,
                              lambda: shutil.copytree(self.new, self.layout["release"]),
                              statvfs=self.capacity(20 * GIB))
        with self.assertRaises(SpaceRefused):
            guarded_write(self.new, self.layout,
                          lambda: shutil.copytree(self.new, self.layout["install_stage"]),
                          phase="installer", expected_devices=first["devices"], statvfs=self.capacity(1))
        self.assertFalse(self.layout["install_stage"].exists())
        result = guarded_write(self.new, self.layout,
                               lambda: shutil.copytree(self.new, self.layout["install_stage"]),
                               phase="installer", expected_devices=first["devices"], statvfs=self.capacity(20 * GIB))
        self.assertTrue(result["ok"])

    def test_sparse_source_is_charged_by_logical_size_and_full_fallback_copies(self):
        with (self.new / "Contents/sparse").open("wb") as out:
            out.truncate(32 * 2**20)
        footprint = bundle_footprint(self.new)
        self.assertGreaterEqual(footprint.copy_bound, footprint.logical)
        result = check_space(self.new, **self.layout, statvfs=self.capacity(20 * GIB))
        reasons = result["volumes"][0]["writes"]
        self.assertEqual(reasons[0]["bytes"], footprint.copy_bound * 2)
        self.assertEqual(reasons[1]["bytes"], footprint.copy_bound)

    def test_symlink_destination_and_changed_filesystem_refuse(self):
        (self.root / "alias").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(SpaceRefused):
            check_space(self.new, **{**self.layout, "release": self.root / "alias/release"})
        with self.assertRaises(SpaceRefused):
            check_space(self.new, **self.layout, expected_devices={})

    def test_existing_rollback_cannot_be_overwritten(self):
        self.layout["rollback"].mkdir()
        with self.assertRaises(SpaceRefused):
            check_space(self.new, **self.layout)

    def test_receive_charges_transport_copy_before_any_candidate_write(self):
        footprint = bundle_footprint(self.new)
        result = check_space(footprint, **self.layout, phase="receive",
                             incoming=self.root / "incoming.app", statvfs=self.capacity(20 * GIB))
        copies = [write["bytes"] for write in result["volumes"][0]["writes"][:3]]
        self.assertEqual(copies, [footprint.copy_bound, footprint.copy_bound * 2, footprint.copy_bound])
        with self.assertRaises(SpaceRefused):
            Footprint(logical=-1, allocated=1, entries=1)

    def test_successful_stage_and_cutover_against_real_statvfs(self):
        # Exercise the production probe on an actual temporary destination mount.
        # A host below the retained 9 GiB reserve is an explicit unavailable target.
        free = os.statvfs(self.root)
        if free.f_bavail * free.f_frsize < 10 * GIB:
            self.skipTest("Host lacks required staging reserve")
        result = guarded_write(self.new, self.layout,
                               lambda: (shutil.copytree(self.new, self.layout["release"]),
                                        shutil.copytree(self.new, self.layout["install_stage"])))
        self.assertTrue(result["ok"])
        checked = check_space(self.new, **self.layout, phase="cutover",
                              expected_devices=result["devices"])
        self.assertTrue(checked["ok"])


if __name__ == "__main__":
    unittest.main()
