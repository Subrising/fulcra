import dataclasses,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from legacy_first_cutover import MacLegacyHost,TopologyUnavailable,UpgradeRefused
from upgrade_existing_mac import ProcessIdentity,mac_process_probe
from executor import cutover_retaining_prepared,error_record

class Table:
    def __init__(self,before,after):self.before,self.after,self.calls=before,after,0
    def rows(self,_):self.calls+=1;return self.before if self.calls==1 else self.after
    def resource_users(self,*_):return set()

class DiagnosticTests(unittest.TestCase):
    def setUp(self):self.root=ProcessIdentity(10,'1.000001',Path('/bin/sh'),(1,2,32768))
    def host(self,table,probe):
        h=MacLegacyHost(SimpleNamespace(app_process=None),table=table,process_probe=probe)
        h.commands=SimpleNamespace(uncertain=[]);return h
    def test_new_descendant_refusal_has_exact_sets_parents_and_kernel(self):
        child=dataclasses.replace(self.root,pid=12,started='2.000001')
        h=self.host(Table({10:1},{10:1,12:10}),lambda pid:self.root if pid==10 else child)
        with self.assertRaises(TopologyUnavailable) as caught:h._tree((self.root,),())
        d=caught.exception.observer_diagnostic
        self.assertEqual(d['before'],[10]);self.assertEqual(d['after'],[10,12]);self.assertEqual(d['added'],[12]);self.assertEqual(d['removed'],[])
        self.assertIn([12,10],d['parentsAfter']);self.assertEqual(d['currentKernel'][1]['kernel']['started'],'2.000001')
        self.assertIsNone(d['causalClassification']);self.assertTrue(d['refusalUnchanged'])
    def test_missing_root_after_snapshot_is_refused_and_diagnosed(self):
        h=self.host(Table({10:1},{}),lambda _:self.root)
        with self.assertRaises(TopologyUnavailable) as caught:h._tree((self.root,),())
        d=caught.exception.observer_diagnostic;self.assertEqual(d['removed'],[10]);self.assertEqual(d['after'],[]);self.assertEqual(d['kind'],'selected-root-missing')
    def test_pid_reuse_still_refuses_and_records_both_lifetimes(self):
        changed=dataclasses.replace(self.root,started='9.000001')
        h=self.host(Table({10:1},{10:1}),lambda _:changed)
        with self.assertRaises(UpgradeRefused) as caught:h._tree((self.root,),())
        d=caught.exception.observer_diagnostic;self.assertEqual(d['expectedRoots'][0]['started'],'1.000001');self.assertEqual(d['capturedKernel'][0]['started'],'9.000001')
    def test_unknown_selected_is_not_skipped_by_diagnostics(self):
        def probe(_):raise TopologyUnavailable('selected unknown')
        h=self.host(Table({10:1},{10:1}),probe)
        with self.assertRaises(TopologyUnavailable) as caught:h._tree((self.root,),())
        self.assertEqual(caught.exception.observer_diagnostic['kind'],'selected-identity-unknown')
    def test_diagnostic_budget_is_bounded_for_large_unicode_paths(self):
        roots=tuple(dataclasses.replace(self.root,pid=i,executable=Path('/'+'😀'*1000)) for i in range(10,18))
        h=self.host(Table({},{}),lambda _:None)
        e=h._tree_refusal(TopologyUnavailable('change'),'selected-tree-changed',roots,{i:10 for i in range(3000)},set(range(3000)),{p.pid:p for p in roots},after={10:1})
        self.assertLessEqual(len(json.dumps(e.observer_diagnostic).encode()),16384);self.assertTrue(e.observer_diagnostic['setsTruncated'])
    def test_real_native_child_exit_is_diagnosed_and_still_refused(self):
        if sys.platform!='darwin':self.skipTest('native libproc required')
        child=subprocess.Popen([sys.executable,'-c','import sys;print("ready",flush=True);sys.stdin.readline()'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(),b'ready\n');parent=mac_process_probe(os.getpid());prior=mac_process_probe(child.pid)
            class NativeTable:
                def rows(self,_):
                    return {parent.pid:1,child.pid:parent.pid} if child.poll() is None else {parent.pid:1}
                def resource_users(self,*_):child.stdin.close();child.wait(timeout=5);return set()
            h=self.host(NativeTable(),mac_process_probe);h.transaction=SimpleNamespace(captured=SimpleNamespace(processes=(parent,prior)))
            with self.assertRaises(TopologyUnavailable) as caught:h._tree((parent,),())
            d=caught.exception.observer_diagnostic
            self.assertEqual(d['kind'],'selected-process-exited');self.assertIn(child.pid,d['removed']);self.assertEqual(d['failedPid'],child.pid)
            old=next(p for p in d['preparedKernel'] if p['pid']==child.pid);self.assertEqual(old['started'],prior.started)
            self.assertIsNone(next(p['kernel'] for p in d['currentKernel'] if p['pid']==child.pid));self.assertIsNone(d['causalClassification'])
        finally:
            if not child.stdin.closed:child.stdin.close()
            child.wait(timeout=5);child.stdout.close()

class PreparedRetentionTests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.receipt=str(Path(self.temp.name)/'receipt.json')
    def tearDown(self):self.temp.cleanup()
    def tx(self,errors):
        class Tx:
            state='prepared';captured=object();calls=0;prepareCalls=1;charged=0
            host=SimpleNamespace(commands=SimpleNamespace(action_count=0,uncertain=[]))
            def _charge_output(self,n):self.charged+=n
            def cutover(self,*,owner_window_selected):
                assert owner_window_selected;self.calls+=1
                if errors:
                    error=errors.pop(0)
                    if error:raise error
                self.state='installed';self.host.commands.action_count=2
        return Tx()
    def test_same_prepared_object_held_no_bare_retry_or_automatic_effect(self):
        e=TopologyUnavailable('tree changed');e.observer_diagnostic={'version':1,'added':[11],'refusalUnchanged':True}
        tx=self.tx([e,None]);record={};commands=iter(['retry-owner-window-selected','finish','retry-owner-window-selected native-child-exit-observed-and-owner-checkpoint'])
        def read(_):
            self.assertEqual(tx.calls,1);self.assertEqual(tx.host.commands.action_count,0)
            held=json.loads(Path(self.receipt).read_text());self.assertEqual(held['observerDiagnostic']['added'],[11]);self.assertEqual(held['state'],'prepared-held-no-service-effects')
            return next(commands)
        self.assertTrue(cutover_retaining_prepared(tx,record,self.receipt,read))
        self.assertEqual(tx.calls,2);self.assertEqual(tx.prepareCalls,1);self.assertEqual(json.loads(Path(self.receipt).read_text())['serviceActions'],0)
        installed=json.loads(Path(self.receipt+'.installed').read_text());self.assertEqual(installed['state'],'installed');self.assertNotIn('observerDiagnostic',installed);self.assertTrue(Path(installed['control_fifo']).exists())
    def test_explicit_retry_still_refuses_new_work_then_owner_can_abort_no_effects(self):
        errors=[TopologyUnavailable('added new work'),TopologyUnavailable('still added new work')];tx=self.tx(errors);commands=iter(['retry-owner-window-selected changed-condition-claimed','abort-before-effects'])
        self.assertFalse(cutover_retaining_prepared(tx,{},self.receipt,lambda _:next(commands)))
        self.assertEqual(tx.calls,2);self.assertEqual(tx.host.commands.action_count,0);self.assertTrue(Path(self.receipt+'.refusal-1').exists());self.assertTrue(Path(self.receipt+'.aborted').exists())
    def test_uncertain_or_post_effect_failure_never_enters_retry_hold(self):
        for partial in ['uncertain','effects','missing-capture']:
            with self.subTest(partial=partial):
                tx=self.tx([TopologyUnavailable('refusal')])
                if partial=='uncertain':tx.host.commands.uncertain=[object()]
                if partial=='effects':tx.host.commands.action_count=1
                if partial=='missing-capture':tx.captured=None
                with self.assertRaises(TopologyUnavailable):cutover_retaining_prepared(tx,{},self.receipt,lambda _:self.fail('must not offer retry'))
                self.assertFalse(Path(self.receipt).exists())
    def test_error_transport_clears_previous_diagnostic_for_new_error(self):
        record={'observerDiagnostic':{'stale':True}};error_record(record,RuntimeError('new failure'));self.assertNotIn('observerDiagnostic',record)
    def test_real_prepared_fixture_reuses_release_after_owner_changed_condition(self):
        if sys.platform!='darwin':self.skipTest('native maintenance counterpart requires macOS')
        from legacy_first_cutover_test import LegacyFirstCutoverTests
        fixture=LegacyFirstCutoverTests('test_mini_stages_current_closure_and_nonlive_plist_only')
        fixture.setUp()
        try:
            tx=fixture.make();tx.prepare()
            release_inode=tx.plan.release.stat().st_ino
            config=fixture.counterpart.values();config['sessionStatus']='running'
            fixture.counterpart.config.write_text(json.dumps(config))
            def decision(_):
                self.assertEqual(tx.host.commands.action_count,0)
                self.assertEqual(tx.plan.release.stat().st_ino,release_inode)
                config['sessionStatus']='idle';fixture.counterpart.config.write_text(json.dumps(config))
                return 'retry-owner-window-selected fixture-owned-turn-completed'
            # Repreparing would fail occupied targets; this is the SAME live tx.
            self.assertTrue(cutover_retaining_prepared(tx,{},self.receipt,decision))
            self.assertEqual(tx.state,'installed');self.assertEqual(tx.plan.release.stat().st_ino,release_inode)
            self.assertEqual([e['action'] for e in fixture.counterpart.events()],['stop','start'])
        finally:fixture.tearDown()

if __name__=='__main__':unittest.main()
