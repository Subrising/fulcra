import os
import shutil
import tempfile
import time
import sys
import unittest
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from upgrade_existing_mac import (Busy, FileState, Lifecycle, NativeSession, NativeStatus,
                                  Plan, ProcessIdentity, Selector, StopIncomplete,
                                  TopologyUnavailable, Upgrade, UpgradeRefused, identity,
                                  read_state, seal_bundle, mac_process_probe, rename_fresh)
from upgrade_space import GIB, METADATA_BUDGET, SpaceRefused, bundle_footprint


class FixtureLifecycle(Lifecycle):
    """Native CLI/process counterpart only; never connects to installed services."""
    def __init__(self, home, executable):
        self.home = home
        self.executable = executable
        self.process = ProcessIdentity(1234, "fixture lifetime 1", executable, identity(executable))
        self.sessions = (NativeSession("operator", False, False), NativeSession("worker", False, False))
        self.complete = True
        self.events = []
        self.timeout = False
        self.held = False
        self.holds = 0
        self.generation = 1
        self.status_age = 0

    @contextmanager
    def hold_intake(self):
        self.holds += 1
        self.held = True
        try:
            yield
        finally:
            self.held = False

    def observe(self):
        return NativeStatus(self.home, False, self.complete, time.monotonic() - self.status_age,
                            self.sessions, (self.process,) if self.process else ())

    def probe(self, pid):
        return self.process if self.process and self.process.pid == pid else None

    def graceful_stop(self, expected, *, timeout, log_budget):
        assert self.held and timeout == 30 and 0 <= log_budget <= METADATA_BUDGET
        self.events.append("graceful-stop")
        if self.timeout:
            raise TimeoutError("supported CLI did not complete")
        self.process = None

    def start(self, app, *, log_budget):
        assert self.held and 0 <= log_budget <= METADATA_BUDGET
        self.events.append("start-only")
        self.generation += 1
        self.process = ProcessIdentity(1234 + self.generation, f"fixture lifetime {self.generation}",
                                       self.executable, identity(self.executable))


class UpgradeExistingMacTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "candidate.app"
        self.installed = self.root / "installed.app"
        self.app(self.source, b"new app")
        self.app(self.installed, b"prior app")
        self.home = self.root / "home"
        self.home.mkdir()
        self.history = self.home / "sessions.jsonl"
        self.history.write_bytes(b"prior history\n")
        self.settings = self.home / "settings.json"
        self.settings.write_bytes(b'{"commandCentreEnabled":true,"manageBuiltInDaemon":false,"keepRunningAfterQuit":false}')
        self.selector = self.root / "selected-launcher.json"
        self.selector.write_bytes(b"exact prior selector\n")
        self.selector.chmod(0o640)
        self.cli = self.root / "selected-cli"
        self.cli.write_bytes(b"fixture CLI")
        self.plan = Plan(source=self.source, seal=seal_bundle(self.source),
                         measured=bundle_footprint(self.source), release=self.root / "release.app",
                         install_stage=self.root / "install-temp.app", installed=self.installed,
                         rollback=self.root / "rollback.app", metadata=self.root / "metadata",
                         home=self.home, desktop_managed=False, preserve_roots=(self.home,),
                         selectors=(Selector(self.selector, FileState("file", b"new selector\n", 0o600)),),
                         settings=(self.settings,), incoming=self.source)
        self.service = FixtureLifecycle(self.home, self.cli)
        self.available = 30 * GIB
        self.probes = []
        self.upgrade = self.make()

    def tearDown(self):
        self.temp.cleanup()

    def app(self, path, data):
        (path / "Contents/MacOS").mkdir(parents=True)
        (path / "Contents/Resources").mkdir()
        (path / "Contents/MacOS/Fulcra").write_bytes(b"executable " + data)
        (path / "Contents/MacOS/Fulcra").chmod(0o755)
        (path / "Contents/Resources/app.asar").write_bytes(data)

    def capacity(self, path):
        self.probes.append(str(path))
        return SimpleNamespace(f_bavail=self.available, f_frsize=1)

    def make(self, **kwargs):
        return Upgrade(kwargs.pop("plan", self.plan), lifecycle=kwargs.pop("lifecycle", self.service),
                       process_probe=kwargs.pop("process_probe", self.service.probe),
                       statvfs=kwargs.pop("statvfs", self.capacity), **kwargs)

    def prior_untouched(self):
        self.assertEqual((self.installed / "Contents/Resources/app.asar").read_bytes(), b"prior app")
        self.assertEqual(self.selector.read_bytes(), b"exact prior selector\n")
        self.assertEqual(self.service.events, [])
        self.assertEqual(self.service.holds, 0)

    def test_insufficient_space_refuses_before_any_callback_or_write(self):
        self.available = 9 * GIB
        calls = []
        self.upgrade = self.make(copytree=lambda *a, **k: calls.append("copy"))
        with self.assertRaises(SpaceRefused):
            self.upgrade.prepare()
        self.assertEqual(calls, [])
        self.assertFalse(self.plan.release.exists())
        self.assertFalse(self.plan.metadata.exists())
        self.prior_untouched()

    def test_successful_stage_cutover_and_exact_rollback_keep_newer_user_state(self):
        prior = read_state(self.selector)
        prior_identity = identity(self.selector)
        prior_app_identity = identity(self.installed)
        settings = self.settings.read_bytes()
        self.upgrade.prepare()
        self.prior_untouched()
        self.assertEqual(self.upgrade.devices.keys(),
                         {"release", "install_stage", "installed", "rollback", "metadata", "incoming"})
        self.upgrade.cutover()
        self.assertEqual(self.upgrade.state, "installed")
        self.assertEqual((self.installed / "Contents/Resources/app.asar").read_bytes(), b"new app")
        self.assertEqual((self.plan.rollback / "Contents/Resources/app.asar").read_bytes(), b"prior app")
        self.assertEqual(self.selector.read_bytes(), b"new selector\n")
        self.assertEqual(self.settings.read_bytes(), settings)
        self.history.write_bytes(b"prior history\nnewer history\n")
        self.settings.write_bytes(settings + b"\n")  # Newer config is never rewound on rollback.
        self.upgrade.rollback()
        self.assertEqual(self.upgrade.state, "rolled-back")
        self.assertEqual(read_state(self.selector), prior)
        self.assertEqual(identity(self.selector), prior_identity)
        self.assertEqual(identity(self.installed), prior_app_identity)
        self.assertEqual((self.installed / "Contents/Resources/app.asar").read_bytes(), b"prior app")
        self.assertEqual((self.plan.install_stage / "Contents/Resources/app.asar").read_bytes(), b"new app")
        self.assertEqual(self.history.read_bytes(), b"prior history\nnewer history\n")
        self.assertEqual(self.settings.read_bytes(), settings + b"\n")
        self.assertEqual(self.service.events, ["graceful-stop", "start-only", "graceful-stop", "start-only"])
        self.assertLessEqual(self.upgrade.used_bytes, METADATA_BUDGET)

    def test_operator_active_turn_and_pending_permission_both_refuse(self):
        self.upgrade.prepare()
        for active, permission in ((True, False), (False, True)):
            with self.subTest(active=active, permission=permission):
                self.service.sessions = (NativeSession("operator", active, permission),)
                with self.assertRaises(Busy):
                    self.upgrade.cutover()
                self.prior_untouched()

    def test_unknown_incomplete_stale_or_wrong_topology_status_refuses(self):
        self.upgrade.prepare()
        self.service.complete = False
        with self.assertRaises(TopologyUnavailable):
            self.upgrade.cutover()
        self.service.complete = True
        self.service.status_age = 6
        with self.assertRaises(TopologyUnavailable):
            self.upgrade.cutover()
        self.service.status_age = 0
        self.service.sessions = (NativeSession("operator", None, False),)
        with self.assertRaises(TopologyUnavailable):
            self.upgrade.cutover()
        self.prior_untouched()

    def test_unproven_host_lifecycle_is_explicitly_unavailable(self):
        self.upgrade = self.make(lifecycle=Lifecycle())
        self.upgrade.prepare()
        with self.assertRaises(TopologyUnavailable):
            self.upgrade.cutover()
        self.prior_untouched()

    def test_failed_installer_bytes_cannot_affect_service(self):
        def corrupt_copy(source, target, **kwargs):
            shutil.copytree(source, target, **kwargs)
            if target == self.plan.install_stage:
                (target / "Contents/Resources/app.asar").write_bytes(b"corrupt")
        self.upgrade = self.make(copytree=corrupt_copy)
        with self.assertRaises(UpgradeRefused):
            self.upgrade.prepare()
        with self.assertRaises(UpgradeRefused):
            self.upgrade.cutover()
        self.assertTrue(self.plan.install_stage.exists())
        self.prior_untouched()

    def test_capacity_rechecked_before_installer_and_before_service(self):
        def capacity_drops(source, target, **kwargs):
            shutil.copytree(source, target, **kwargs)
            self.available = 1
        self.upgrade = self.make(copytree=capacity_drops)
        with self.assertRaises(SpaceRefused):
            self.upgrade.prepare()
        self.assertTrue(self.plan.release.exists())
        self.assertFalse(self.plan.install_stage.exists())
        self.prior_untouched()

    def test_cutover_rechecks_capacity_without_stopping_service(self):
        self.upgrade.prepare()
        self.available = 1
        with self.assertRaises(SpaceRefused):
            self.upgrade.cutover()
        self.prior_untouched()

    def test_graceful_stop_timeout_never_swaps_or_force_kills(self):
        self.upgrade.prepare()
        self.service.timeout = True
        with self.assertRaises(StopIncomplete):
            self.upgrade.cutover()
        self.assertEqual(self.service.events, ["graceful-stop"])
        self.assertIsNotNone(self.service.process)
        self.assertEqual((self.installed / "Contents/Resources/app.asar").read_bytes(), b"prior app")
        self.assertFalse(self.plan.rollback.exists())
        self.assertEqual(self.selector.read_bytes(), b"exact prior selector\n")

    def test_changed_process_start_identity_refuses_before_service(self):
        self.upgrade.prepare()
        self.upgrade.process_probe = lambda pid: replace(self.service.process, started="reused PID")
        with self.assertRaises(UpgradeRefused):
            self.upgrade.cutover()
        self.prior_untouched()

    def test_changed_path_identity_and_changed_device_map_refuse(self):
        self.upgrade.prepare()
        self.plan.release.rename(self.root / "moved-release")
        shutil.copytree(self.root / "moved-release", self.plan.release)
        with self.assertRaises(UpgradeRefused):
            self.upgrade.cutover()
        self.prior_untouched()

    def test_changed_device_map_refuses(self):
        self.upgrade.prepare()
        self.upgrade.devices = {**self.upgrade.devices, "metadata": -1}
        with self.assertRaises(SpaceRefused):
            self.upgrade.cutover()
        self.prior_untouched()

    def test_occupied_rollback_and_changed_selector_or_settings_refuse(self):
        self.upgrade.prepare()
        self.plan.rollback.mkdir()
        with self.assertRaises(SpaceRefused):
            self.upgrade.cutover()
        self.plan.rollback.rmdir()
        self.selector.write_bytes(b"newer independent selector")
        with self.assertRaises(UpgradeRefused):
            self.upgrade.cutover()
        self.assertEqual(self.service.events, [])
        self.assertEqual(self.selector.read_bytes(), b"newer independent selector")

    def test_changed_settings_refuses_without_rewriting_them(self):
        self.upgrade.prepare()
        self.settings.write_bytes(b"newer settings")
        with self.assertRaises(UpgradeRefused):
            self.upgrade.cutover()
        self.assertEqual(self.settings.read_bytes(), b"newer settings")
        self.assertEqual(self.service.events, [])

    def test_measured_and_sealed_source_mismatch_refuses_before_writes(self):
        bad = replace(self.plan, measured=replace(self.plan.measured, logical=self.plan.measured.logical + 1))
        with self.assertRaises(UpgradeRefused):
            self.make(plan=bad).prepare()
        self.assertFalse(self.plan.release.exists())
        (self.source / "Contents/Resources/app.asar").write_bytes(b"changed source")
        with self.assertRaises(UpgradeRefused):
            self.upgrade.prepare()
        self.prior_untouched()

    def test_selector_symlink_rollback_restores_exact_target(self):
        self.selector.unlink()
        self.selector.symlink_to(self.cli)
        target = self.root / "new-cli"
        target.write_bytes(b"new fixture CLI")
        change = Selector(self.selector, FileState("link", str(target).encode(), 0o777))
        self.upgrade = self.make(plan=replace(self.plan, selectors=(change,)))
        self.upgrade.prepare().cutover().rollback()
        self.assertEqual(os.readlink(self.selector), str(self.cli))

    def test_metadata_budget_refuses_before_any_stage_bytes(self):
        huge = FileState("file", b"x" * METADATA_BUDGET)
        self.upgrade = self.make(plan=replace(self.plan, selectors=(Selector(self.selector, huge),)))
        with self.assertRaises(UpgradeRefused):
            self.upgrade.prepare()
        self.assertFalse(self.plan.release.exists())
        self.prior_untouched()

    def test_real_filesystem_probe_and_byte_swap(self):
        self.upgrade = self.make(statvfs=os.statvfs)
        # Real statvfs refusal is a valid result on an undersized test mount.
        try:
            self.upgrade.prepare()
        except SpaceRefused:
            self.prior_untouched()
            return
        self.upgrade.cutover().rollback()
        self.assertEqual((self.installed / "Contents/Resources/app.asar").read_bytes(), b"prior app")

    def test_installed_and_retained_bundle_bytes_are_verified_before_rollback_actions(self):
        self.upgrade.prepare().cutover()
        events = list(self.service.events)
        (self.plan.rollback / "Contents/Resources/app.asar").write_bytes(b"changed prior app")
        with self.assertRaises(UpgradeRefused):
            self.upgrade.rollback()
        self.assertEqual(self.service.events, events)
        self.assertEqual((self.installed / "Contents/Resources/app.asar").read_bytes(), b"new app")

    def test_newer_selector_is_not_rewound_on_rollback(self):
        self.upgrade.prepare().cutover()
        events = list(self.service.events)
        self.selector.write_bytes(b"newer selector from another owner")
        with self.assertRaises(UpgradeRefused):
            self.upgrade.rollback()
        self.assertEqual(self.selector.read_bytes(), b"newer selector from another owner")
        self.assertEqual(self.service.events, events)

    def test_disposable_state_destination_uses_its_actual_filesystem(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            other = Path(directory).resolve()
            selector = other / "selected-launcher"
            selector.write_bytes(b"external prior")
            plan = replace(self.plan, metadata=other / "metadata",
                           selectors=(Selector(selector, FileState("file", b"external new")),))
            upgrade = self.make(plan=plan)
            upgrade.prepare().cutover().rollback()
            self.assertEqual(upgrade.devices["metadata"], other.stat().st_dev)
            self.assertEqual(upgrade.devices["installed"], self.root.stat().st_dev)
            self.assertEqual(selector.read_bytes(), b"external prior")

    def test_full_seal_matches_source_contract_algorithm(self):
        (self.source / "Contents/Resources/link").symlink_to("app.asar")
        (self.source / "Contents/Resources/unicode-é").write_bytes(b"full inventory")
        # Fixed oracle generated by the source release/contract.mjs algorithm;
        # normal focused tests require only Python's stdlib.
        self.assertEqual(seal_bundle(self.source),
                         "5f6fe3a09ade5826b881d7d65f29b25756e45d21b81d746baa31f23d7a899ec2")

    def test_atomic_rename_refuses_even_an_occupied_empty_directory(self):
        self.plan.rollback.mkdir()
        with self.assertRaises(UpgradeRefused):
            rename_fresh(self.installed, self.plan.rollback)
        self.prior_untouched()

    def test_real_mac_kernel_process_lifetime_probe_for_test_runner(self):
        if sys.platform != "darwin":
            with self.assertRaises(TopologyUnavailable):
                mac_process_probe(os.getpid())
            return
        first = mac_process_probe(os.getpid())
        self.assertEqual(mac_process_probe(os.getpid()), first)
        self.assertEqual(first.pid, os.getpid())
        self.assertRegex(first.started, r"^[0-9]+\.[0-9]{6}$")
        self.assertEqual(first.file_identity, identity(first.executable))



if __name__ == "__main__":
    unittest.main()
