"""Caller-level terminal reporting regressions; main runs with fake lifecycle only."""
import contextlib,io,json,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import executor
from legacy_first_cutover import TopologyUnavailable,CommandUncertain

class FakeTx:
    def __init__(self,outcome):
        self.state='new';self.captured=object();self.outcome=outcome;self.calls=0;self.prepare_calls=0;self.charges=[]
        self.host=SimpleNamespace(commands=SimpleNamespace(action_count=0,uncertain=[]))
    def prepare(self):self.prepare_calls+=1;self.state='prepared'
    def _charge_output(self,n):
        self.charges.append(n)
        if self.outcome=='reserve-failure':raise RuntimeError('original report reserve failure')
        if self.outcome=='budget-after-failure' and self.host.commands.action_count:
            raise RuntimeError('secondary exhausted metadata budget')
    def cutover(self,*,owner_window_selected):
        self.calls+=1
        if self.calls==1:raise TopologyUnavailable('initial held observation')
        if self.outcome in ['partial','uncertain','report-write-failure','budget-after-failure','collision']:
            self.state='legacy-recovery-required';self.host.commands.action_count=1
            if self.outcome=='uncertain':
                self.host.commands.uncertain=[object()];raise CommandUncertain('original uncertain stop failure')
            raise RuntimeError('original partial cutover failure')
        self.state='installed';self.host.commands.action_count=2
    def rollback(self,*,owner_window_selected):
        self.state='legacy-recovery-required';self.host.commands.action_count=4
        raise RuntimeError('original rollback failure')

class TerminalOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.spec=self.root/'spec.json';self.spec.write_text('{"old_root_pids":[]}')
        self.receipt=str(self.root/'receipt.json');self.snapshots={}
    def tearDown(self):self.temp.cleanup()
    def run_main(self,outcome):
        tx=FakeTx(outcome);original=executor.cutover_retaining_prepared;real_write=executor.write_receipt;stderr=io.StringIO()
        def retry(_):
            self.snapshots['initial']=Path(self.receipt).read_bytes()
            return 'retry-owner-window-selected fixture-owned-work-checkpoint'
        def opened(path,*args,**kwargs):
            if str(path)==self.receipt+'.control':
                self.snapshots['installed']=Path(self.receipt+'.installed').read_bytes()
                if outcome=='control-failure':raise OSError('original control read failure')
                return io.StringIO('rollback-owner-window-selected\n')
            return open(path,*args,**kwargs)
        def writer(path,record,max_bytes=None):
            if outcome=='report-write-failure' and '.terminal' in str(path):raise OSError('secondary terminal storage failure')
            return real_write(path,record,max_bytes=max_bytes)
        if outcome=='collision':
            Path(self.receipt+'.terminal').write_bytes(b'older terminal evidence\n')
        argv=['executor','--spec',str(self.spec),'--receipt',self.receipt,'--mode','cutover','--owner-window-selected']
        with patch.object(sys,'argv',argv),patch.object(executor,'independent',return_value=[1]),patch.object(executor,'transaction',return_value=tx),patch.object(executor,'cutover_retaining_prepared',side_effect=lambda t,r,p:original(t,r,p,retry)),patch.object(executor,'open',opened,create=True),patch.object(executor,'write_receipt',writer),contextlib.redirect_stderr(stderr):
            status=executor.main()
        self.assertEqual(status,2);self.assertEqual(tx.prepare_calls,1)
        if 'initial' in self.snapshots:self.assertEqual(Path(self.receipt).read_bytes(),self.snapshots['initial'])
        if 'installed' in self.snapshots:self.assertEqual(Path(self.receipt+'.installed').read_bytes(),self.snapshots['installed'])
        return tx,stderr.getvalue()
    def terminal(self,suffix=''):
        p=Path(self.receipt+'.terminal'+suffix);self.assertLessEqual(p.stat().st_size,executor.TERMINAL_LIMIT);return json.loads(p.read_text())
    def test_main_fatal_retry_after_effects_preserves_held_receipt_and_original_error(self):
        tx,_=self.run_main('partial');r=self.terminal()
        self.assertEqual(r['phase'],'cutover');self.assertEqual(r['transaction_state'],'legacy-recovery-required');self.assertEqual(r['serviceActions'],1)
        self.assertEqual(r['error'],'original partial cutover failure');self.assertTrue(r['ownerWillExit']);self.assertFalse(r['automaticRetry']);self.assertEqual(tx.calls,2)
    def test_main_uncertain_retry_writes_terminal_without_replay(self):
        tx,_=self.run_main('uncertain');r=self.terminal()
        self.assertEqual(r['errorType'],'CommandUncertain');self.assertEqual(r['error'],'original uncertain stop failure');self.assertEqual(r['uncertainCommandCount'],1);self.assertEqual(tx.calls,2)
    def test_main_rollback_failure_preserves_initial_and_installed_bytes(self):
        _,_=self.run_main('rollback');r=self.terminal()
        self.assertEqual(r['phase'],'rollback');self.assertEqual(r['serviceActions'],4);self.assertEqual(r['error'],'original rollback failure')
        self.assertFalse(Path(self.receipt+'.rollback').exists())
    def test_main_control_failure_gets_its_own_terminal_phase(self):
        self.run_main('control-failure');r=self.terminal()
        self.assertEqual(r['phase'],'installed-control');self.assertEqual(r['transaction_state'],'installed');self.assertEqual(r['serviceActions'],2);self.assertEqual(r['error'],'original control read failure')
    def test_terminal_storage_failure_cannot_mask_original_partial_failure(self):
        _,stderr=self.run_main('report-write-failure')
        r=json.loads(stderr.splitlines()[0]);self.assertEqual(r['error'],'original partial cutover failure');self.assertEqual(r['serviceActions'],1);self.assertEqual(r['terminalReportErrorType'],'OSError')
    def test_report_reserve_failure_is_terminal_before_any_effect(self):
        tx,_=self.run_main('reserve-failure');r=self.terminal()
        self.assertEqual(r['phase'],'terminal-report-reservation');self.assertEqual(r['error'],'original report reserve failure');self.assertEqual(r['serviceActions'],0);self.assertEqual(tx.calls,0);self.assertLessEqual(Path(self.receipt+'.terminal').stat().st_size,executor.EARLY_TERMINAL_LIMIT)
    def test_precharged_terminal_budget_survives_later_budget_exhaustion(self):
        tx,_=self.run_main('budget-after-failure');r=self.terminal()
        self.assertEqual(tx.charges[0],executor.TERMINAL_LIMIT)
        self.assertEqual(len(tx.charges),2)  # Reserve + initial held report; no fatal re-charge.
        self.assertEqual(r['reportBudget'],'precharged32KiB');self.assertEqual(r['error'],'original partial cutover failure')
    def test_terminal_collision_preserves_existing_evidence(self):
        self.run_main('collision');r=self.terminal('-1')
        self.assertEqual(Path(self.receipt+'.terminal').read_bytes(),b'older terminal evidence\n');self.assertEqual(r['error'],'original partial cutover failure')

if __name__=='__main__':unittest.main()
