"""Selected resource seam regressions; temporary files/processes only, no providers."""
import dataclasses
from pathlib import Path
import os
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

from legacy_first_cutover import (BoundedCommands, BundlePin, CommandPrefix, FilePin,
    MacLegacyHost, MacProcessTable, TopologyUnavailable, UpgradeRefused)
from upgrade_existing_mac import ProcessIdentity, StopIncomplete, identity, seal_bundle


class Table:
    def __init__(self, rows, users=(), error=None, second=None):
        self.first, self.second = rows, second or rows
        self.users, self.error, self.calls = set(users), error, 0
    def rows(self, commands):
        self.calls += 1
        return self.first if self.calls == 1 else self.second
    def resource_users(self, commands, bundles):
        if self.error: raise self.error
        return self.users


class Fields:
    def __init__(self, raw): self.raw = raw
    def run(self, prefix, tail, **kwargs):
        assert kwargs['empty_ok'] and kwargs['clean_stderr'] and kwargs['include_pid'] and kwargs['file_search']
        return self.raw, 900


class SelectedResourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fulcra-selected-resources-')
        self.root = Path(self.temp.name).resolve()
        self.app = self.root/'app'
        (self.app/'Contents/MacOS').mkdir(parents=True)
        (self.app/'Contents/Resources').mkdir()
        (self.app/'Contents/MacOS/Fulcra').write_bytes(b'old binary')
        (self.app/'Contents/Resources/app.asar').write_bytes(b'old app')
        self.bundle = BundlePin(self.app, seal_bundle(self.app))
        self.parent = ProcessIdentity(10,'1.000001',Path('/bin/sh'),(1,2,32768))
        self.child = dataclasses.replace(self.parent,pid=11,started='1.000002')
        self.commands = SimpleNamespace(uncertain=[])
    def tearDown(self): self.temp.cleanup()
    def host(self, table, probe):
        host=MacLegacyHost(SimpleNamespace(old_bundles=(self.bundle,)),table=table,
                           process_probe=probe,listener_probe=lambda _:True)
        host.commands=self.commands
        host.selection.listen=('127.0.0.1',12345)
        return host
    def test_unrelated_restricted_identity_never_probed_when_resource_inventory_complete(self):
        calls=[]
        def probe(pid):
            calls.append(pid)
            if pid==99:raise TopologyUnavailable('restricted unrelated identity')
            return {10:self.parent,11:self.child}[pid]
        host=self.host(Table({10:1,11:10,99:1},users={10}),probe)
        self.assertEqual(host._tree((self.parent,),(self.bundle,)),(self.parent,self.child))
        self.assertEqual(calls,[10,11])
    def test_unknown_selected_descendant_refuses(self):
        def probe(pid):
            if pid==11:raise TopologyUnavailable('unknown selected')
            return self.parent
        with self.assertRaises(TopologyUnavailable):
            self.host(Table({10:1,11:10},users={10}),probe)._tree((self.parent,),(self.bundle,))
    def test_outside_resource_consumer_refuses_even_if_identity_unknown(self):
        host=self.host(Table({10:1,99:1},users={99}),lambda pid:self.fail('must refuse before PID probe'))
        with self.assertRaises(TopologyUnavailable):host._tree((self.parent,),(self.bundle,))
    def test_failed_native_resource_inventory_refuses_before_probe(self):
        host=self.host(Table({10:1},error=TopologyUnavailable('inventory failed')),lambda pid:self.fail('probe'))
        with self.assertRaises(TopologyUnavailable):host._tree((self.parent,),(self.bundle,))
    def test_root_pid_reuse_refuses(self):
        host=self.host(Table({10:1}),lambda _:dataclasses.replace(self.parent,started='2.000001'))
        with self.assertRaises(UpgradeRefused):host._tree((self.parent,),(self.bundle,))
    def test_new_selected_descendant_between_snapshots_refuses(self):
        host=self.host(Table({10:1},second={10:1,12:10}),lambda _:self.parent)
        with self.assertRaises(TopologyUnavailable):host._tree((self.parent,),(self.bundle,))
    def test_post_stop_unrelated_restricted_rows_do_not_block_complete_no_resource_inventory(self):
        host=self.host(Table({99:1}),lambda pid:None if pid==10 else self.fail('unrelated PID probe'))
        host.transaction=SimpleNamespace(plan=SimpleNamespace(installed=self.app,seal="1"*64),old_seal=self.bundle.seal,old_moved=False,new_moved=False,stop_confirmed=True)
        host.assert_old_absent(SimpleNamespace(processes=(self.parent,)))
    def test_post_stop_resource_relaunch_refuses(self):
        host=self.host(Table({99:1},users={99}),lambda _:None)
        host.transaction=SimpleNamespace(plan=SimpleNamespace(installed=self.app,seal="1"*64),old_seal=self.bundle.seal,old_moved=False,new_moved=False,stop_confirmed=True)
        with self.assertRaises(StopIncomplete):host.assert_old_absent(SimpleNamespace(processes=(self.parent,)))
    def test_post_stop_pid_reuse_refuses(self):
        host=self.host(Table({}),lambda _:dataclasses.replace(self.parent,started='2.000001'))
        with self.assertRaises(UpgradeRefused):host.assert_old_absent(SimpleNamespace(processes=(self.parent,)))
    def test_missing_resource_root_is_not_blanket_accepted(self):
        table=MacProcessTable(None,resource_command=SimpleNamespace(argv=("/usr/sbin/lsof",)))
        with self.assertRaises(FileNotFoundError):table.resource_users(Fields(b''),(BundlePin(self.root/'missing','0'*64),))
    def test_malformed_or_incomplete_native_fields_refuse(self):
        table=MacProcessTable(None,resource_command=SimpleNamespace(argv=("/usr/sbin/lsof",)))
        for raw in [b'garbage\n',b'p10\n',b'ftxt\n',b'p10\nftxt\np11\n',b'\xff']:
            with self.subTest(raw=raw),self.assertRaises(TopologyUnavailable):
                table.resource_users(Fields(raw),(self.bundle,))
    def test_only_exited_exact_owned_observer_is_excluded(self):
        table=MacProcessTable(None,resource_command=SimpleNamespace(argv=("/usr/sbin/lsof",)))
        self.assertEqual(table.resource_users(Fields(b'p900\nf4\np901\nftxt\n'),(self.bundle,)),{901})
    def test_projection_requires_recorded_inode_and_seal(self):
        rollback=self.root/'rollback';old_id=identity(self.app);self.app.rename(rollback)
        host=self.host(Table({}),lambda _:None);host.original_installed_identity=old_id
        host.transaction=SimpleNamespace(plan=SimpleNamespace(installed=self.app,rollback=rollback,install_stage=self.root/'stage',seal='1'*64),old_seal=self.bundle.seal,old_moved=True,new_moved=False,stop_confirmed=True,bindings={rollback:old_id})
        self.assertEqual(host._old_resource_bundles(),(BundlePin(rollback,self.bundle.seal),))
        (rollback/'Contents/Resources/app.asar').write_bytes(b'tampered')
        with self.assertRaises(UpgradeRefused):host._old_resource_bundles()
    def test_projection_refuses_wrong_retained_inode(self):
        rollback=self.root/'rollback';old_id=identity(self.app);self.app.rename(rollback)
        host=self.host(Table({}),lambda _:None);host.original_installed_identity=old_id
        host.transaction=SimpleNamespace(plan=SimpleNamespace(installed=self.app,rollback=rollback,install_stage=self.root/'stage',seal='1'*64),old_seal=self.bundle.seal,old_moved=True,new_moved=False,stop_confirmed=True,bindings={rollback:(0,0,0)})
        with self.assertRaises(UpgradeRefused):host._old_resource_bundles()
    def test_plain_unknown_missing_original_is_not_projected(self):
        self.app.rename(self.root/'not-owned-rename')
        host=self.host(Table({}),lambda _:None)
        host.transaction=SimpleNamespace(plan=SimpleNamespace(installed=self.app,seal="1"*64),old_seal=self.bundle.seal,old_moved=False,new_moved=False,stop_confirmed=True)
        with self.assertRaises(FileNotFoundError):host._old_resource_bundles()
    def test_real_native_open_resource_and_lifetime(self):
        if sys.platform!='darwin':self.skipTest('native lsof resource proof requires macOS')
        path=self.app/'held-resource';path.write_bytes(b'fixture resource')
        program=self.root/'reader.py';program.write_text('import sys\nf=open(sys.argv[1],"rb")\nprint("ready",flush=True)\nsys.stdin.readline()\nf.close()\n')
        child=subprocess.Popen([sys.executable,str(program),str(path)],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(),b'ready\n')
            observer=CommandPrefix(('/usr/sbin/lsof',),(FilePin.capture(Path('/usr/sbin/lsof')),))
            commands=BoundedCommands(lambda action:self.assertFalse(action),lambda n:None)
            users=MacProcessTable(None,observer).resource_users(commands,(self.bundle,))
            self.assertIn(child.pid,users)
            self.assertEqual(commands.action_count,0)
        finally:
            child.stdin.close();child.wait(timeout=5);child.stdout.close()
    def test_real_resource_survivor_follows_our_rollback_rename(self):
        if sys.platform!='darwin':self.skipTest('native lsof rename proof requires macOS')
        program=self.root/'reader.py';program.write_text('import sys\nf=open(sys.argv[1],"rb")\nprint("ready",flush=True)\nsys.stdin.readline()\nf.close()\n')
        child=subprocess.Popen([sys.executable,str(program),str(self.app/'Contents/MacOS/Fulcra')],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(),b'ready\n')
            prior=identity(self.app);rollback=self.root/'retained-rollback';self.app.rename(rollback)
            observer=CommandPrefix(('/usr/sbin/lsof',),(FilePin.capture(Path('/usr/sbin/lsof')),))
            host=self.host(MacProcessTable(None,observer),lambda _:None)
            host.commands=BoundedCommands(lambda _:None,lambda _:None)
            host.original_installed_identity=prior
            host.transaction=SimpleNamespace(plan=SimpleNamespace(installed=self.app,rollback=rollback,install_stage=self.root/'stage',seal='1'*64),old_seal=self.bundle.seal,old_moved=True,new_moved=False,stop_confirmed=True,bindings={rollback:prior})
            with self.assertRaises(StopIncomplete):host.assert_old_absent(SimpleNamespace(processes=()))
            child.stdin.close();child.wait(timeout=5)
            host.assert_old_absent(SimpleNamespace(processes=()))
        finally:
            if not child.stdin.closed:child.stdin.close()
            child.wait(timeout=5);child.stdout.close()
    def test_empty_exit_one_is_narrow_and_diagnostics_refuse(self):
        interpreter=Path(sys.executable).resolve();pin=FilePin.capture(interpreter)
        for body,expected in [('raise SystemExit(1)\n',None),('print("p10")\nraise SystemExit(1)\n',UpgradeRefused),('import sys\nprint("warning",file=sys.stderr)\n',TopologyUnavailable)]:
            script=self.root/'result.py';script.write_text(body)
            prefix=CommandPrefix((str(interpreter),str(script)),(pin,FilePin.capture(script)))
            commands=BoundedCommands(lambda _:None,lambda _:None)
            if expected:
                with self.assertRaises(expected):commands.run(prefix,(),empty_ok=True,clean_stderr=True,include_pid=True)
            else:
                raw,_=commands.run(prefix,(),empty_ok=True,clean_stderr=True,include_pid=True);self.assertEqual(raw,b'')

if __name__=='__main__':unittest.main()
