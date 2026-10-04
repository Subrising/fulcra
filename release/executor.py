#!/usr/bin/env python3
"""One-shot user-launchd maintenance driver. Probe is read-only except its receipt.

No service action by default. Execute only after delivery's reviewed release and
an actual parent-selected owner window. Reuses LegacyFirstCutover, never creates
an admission lease or interprets this receipt as a permission grant.
"""
import argparse,base64,dataclasses,datetime,hashlib,json,os,pathlib,plistlib,stat,subprocess,sys

def parent_of(pid):
    result=subprocess.run(['/bin/ps','-p',str(pid),'-o','ppid='],capture_output=True,text=True,timeout=3)
    text=result.stdout.strip()
    if result.returncode or not text.isdigit():raise RuntimeError('Executor ancestry unavailable')
    return int(text)

def independent(pid,old_roots,parent=parent_of):
    roots=set(old_roots);seen=set();chain=[]
    while pid!=1:
        if pid<=1 or pid in seen:raise RuntimeError('Executor ancestry incomplete/cyclic')
        if pid in roots:raise RuntimeError('Executor is inside selected old daemon ancestry')
        seen.add(pid);chain.append(pid);pid=parent(pid)
        if len(chain)>32:raise RuntimeError('Executor ancestry exceeds bound')
    return chain+[1]

def owned_json(path):
    path=pathlib.Path(path);info=path.lstat()
    if path.resolve()!=path or not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o022 or info.st_size>1024*1024:
        raise RuntimeError('Bounded canonical owned specification required')
    return json.loads(path.read_text())

def transaction(spec):
    adapter=pathlib.Path(spec['adapter_directory'])
    if adapter.resolve()!=adapter or set(spec['adapter_sha256'])!={'legacy_first_cutover.py','upgrade_existing_mac.py','upgrade_space.py'}:raise RuntimeError('Pinned reviewed adapter set required')
    for rel,expected in spec['adapter_sha256'].items():
        if hashlib.sha256((adapter/rel).read_bytes()).hexdigest()!=expected:raise RuntimeError('Reviewed adapter bytes changed')
    sys.path.insert(0,str(adapter))
    # These reviewed production ports already enforce byte/selector/identity,
    # capacity, no-force/uncertainty and binary-only rollback constraints.
    from upgrade_existing_mac import Plan,Selector,FileState,ProcessIdentity
    from upgrade_space import Footprint
    from legacy_first_cutover import FilePin,CommandPrefix,BundlePin,HostSelection,MiniRuntimeStage,MacProcessTable,MacLegacyHost,LegacyFirstCutover
    p=dict(spec['plan'])
    for name in ['source','release','install_stage','installed','rollback','metadata','home']:p[name]=pathlib.Path(p[name])
    p['preserve_roots']=tuple(map(pathlib.Path,p['preserve_roots']));p['settings']=tuple(map(pathlib.Path,p.get('settings',[])))
    p['measured']=Footprint(**p['measured'])
    p['selectors']=tuple(Selector(pathlib.Path(x['path']),FileState(x['kind'],base64.b64decode(x['data_base64'],validate=True),x['mode'])) for x in p.get('selectors',[]))
    if p.get('incoming') is not None:p['incoming']=pathlib.Path(p['incoming'])
    plan=Plan(**p)
    info=plistlib.loads((plan.source/'Contents/Info.plist').read_bytes())
    if info.get('CFBundleShortVersionString')!='0.2.3':raise RuntimeError('Source artifact is not actual release0.2.3')
    def pin(x):return FilePin(pathlib.Path(x['path']),pathlib.Path(x['resolved']),x['sha256'],tuple(x['inode']) if x.get('inode') else None)
    def command(x):return CommandPrefix(tuple(x['argv']),tuple(pin(y) for y in x['pins']))
    def process(x):return ProcessIdentity(x['pid'],x['started'],pathlib.Path(x['executable']),tuple(x['file_identity']))
    h=dict(spec['selection'])
    for k in ['old_cli','new_cli','open_command','launchctl']:
        if h.get(k) is not None:h[k]=command(h[k])
    h['selected_roots']=tuple(process(x) for x in h['selected_roots'])
    for k in ['old_bundles','new_bundles']:h[k]=tuple(BundlePin(pathlib.Path(x['path']),x['seal']) for x in h[k])
    h['listen']=tuple(h['listen'])
    if h.get('app_process') is not None:h['app_process']=process(h['app_process'])
    if h.get('plist_selector') is not None:h['plist_selector']=pathlib.Path(h['plist_selector'])
    for k in ['old_program_argv','new_program_argv']:h[k]=tuple(h.get(k,[]))
    for k in ['old_runtime_pins','new_runtime_pins']:h[k]=tuple(pin(x) for x in h.get(k,[]))
    selection=HostSelection(**h)
    runtime=None
    if spec.get('mini_runtime'):
        r=dict(spec['mini_runtime'])
        for k in ['old_root','new_root','selector']:r[k]=pathlib.Path(r[k])
        for k in ['launch','runtime_launch','profiles','manifest','python']:r[k]=pin(r[k])
        runtime=MiniRuntimeStage(**r)
    if selection.topology=='book-desktop':
        expected=pathlib.Path('/Users/Example User/.openclaw/owned-work/orca-paseo-6506a206b-20260927/home')
        if plan.home!=pathlib.Path('/Users/Example User/Library/Application Support/Orca/daemon') or expected not in plan.preserve_roots:raise RuntimeError('Book selected/protected home binding differs')
    host=MacLegacyHost(selection,table=MacProcessTable(command(spec['ps_command']),resource_command=command(spec['resource_command'])))
    tx=LegacyFirstCutover(plan,host,mini_runtime=runtime,external_report=pathlib.Path(spec['external_report']))
    return tx

TERMINAL_LIMIT=32768
EARLY_TERMINAL_LIMIT=4096

def write_receipt(path,record,max_bytes=None):
    path=pathlib.Path(path)
    raw=(json.dumps(record,indent=2)+'\n').encode()
    if max_bytes is not None and len(raw)>max_bytes:raise RuntimeError('Bounded receipt exceeds reserved report budget')
    if path.exists() or path.is_symlink():raise RuntimeError('Receipt already exists; never overwrite an earlier attempt')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())

def error_record(record,error):
    record['errorType']=type(error).__name__
    try:record['error']=str(error)[:500]
    except Exception:record['error']='Original error text unavailable';record['errorTextUnavailable']=True
    record.pop('observerDiagnostic',None)
    diagnostic=getattr(error,'observer_diagnostic',None)
    try:
        if isinstance(diagnostic,dict) and len(json.dumps(diagnostic).encode())<=16384:
            record['observerDiagnostic']=diagnostic
    except Exception as transport_error:
        record['observerDiagnosticTransportError']=type(transport_error).__name__


def terminal_failure(receipt,record,tx,error):
    # Preserve the primary error even if its report cannot be committed. A
    # reserved32KiB is charged BEFORE cutover; no effects start without it.
    outcome={k:record[k] for k in ['mode','pid','ppid','uid','observedAtUTC','spec_sha256',
        'ownerWindowSelected','phase','control_fifo','installedReceipt','priorRefusalReceipt'] if k in record}
    outcome.update(state='terminal-failure-or-recovery-required',ownerWillExit=True,
        serviceActions=record.get('serviceActions',0),transaction_state=getattr(tx,'state',None),
        originalReceipt=receipt,automaticRetry=False,preparedTransactionReconstructed=False)
    error_record(outcome,error)
    commands=getattr(getattr(tx,'host',None),'commands',None)
    if commands is not None:
        outcome['serviceActions']=commands.action_count
        outcome['uncertainCommandCount']=len(commands.uncertain)
    reserved=record.get('terminalReportReserved') is True
    outcome['reportBudget']='precharged32KiB' if reserved else 'bounded4KiB-pre-effect-driver-report'
    limit=TERMINAL_LIMIT if reserved else EARLY_TERMINAL_LIMIT
    if len((json.dumps(outcome,indent=2)+'\n').encode())>limit:
        outcome.pop('observerDiagnostic',None);outcome['observerDiagnosticOmittedForBudget']=True
    if len((json.dumps(outcome,indent=2)+'\n').encode())>limit:
        for key in ['control_fifo','installedReceipt','priorRefusalReceipt','originalReceipt']:
            if key in outcome:outcome[key]=str(outcome[key])[:256]
        outcome['pathsTruncatedForReportBudget']=True
    while len((json.dumps(outcome,indent=2)+'\n').encode())>limit:
        # Preserve error type, actual phase/state/counts; make any textual loss
        # explicit rather than losing the entire durable terminal outcome.
        candidates=[key for key,value in outcome.items() if isinstance(value,str) and len(value)>64]
        if not candidates:break
        key=max(candidates,key=lambda k:len(json.dumps(outcome[k]).encode()))
        outcome[key]=outcome[key][:max(64,len(outcome[key])//2)]
        outcome['terminalTextTruncatedForBudget']=True
    for ordinal in range(16):
        path=receipt+'.terminal'+('' if ordinal==0 else '-'+str(ordinal))
        if pathlib.Path(path).exists() or pathlib.Path(path).is_symlink():continue
        try:
            write_receipt(path,outcome,max_bytes=limit)
            record['terminalReceipt']=path
            return
        except Exception as report_error:
            # O_EXCL races can select another fresh name, never overwrite.
            if isinstance(report_error,FileExistsError):continue
            outcome['terminalReportErrorType']=type(report_error).__name__
            break
    else:outcome['terminalReportErrorType']='TerminalReceiptNamesOccupied'
    # Reporting failure is secondary. Keep the original type/message/phase/state
    # observable on launcher stderr and preserve main's original nonzero result.
    fallback={k:outcome.get(k) for k in ['state','phase','transaction_state','serviceActions',
        'errorType','error','uncertainCommandCount','terminalReportErrorType']}
    try:sys.stderr.write(json.dumps(fallback)+'\n');sys.stderr.flush()
    except Exception:pass

def control_decision(path):
    with open(path,'r') as control:return control.readline(512).strip()

def cutover_retaining_prepared(tx,record,receipt,read_decision=control_decision):
    """No automatic retry/reprepare; retain the SAME prepared owner after no effects.

    An explicit owner command must state a genuinely changed condition. Its
    reason is recorded, never interpreted as proof: every original cutover
    byte/capacity/lifetime/busy/resource/survivor guard still runs unchanged.
    Earlier exited v1/v2 objects cannot be reconstructed through this path.
    """
    attempt=0
    while True:
        try:
            record['phase']='cutover'
            tx.cutover(owner_window_selected=True)
            record['phase']='installed-report'
            record.update(state=tx.state,serviceActions=tx.host.commands.action_count,
                          rollbackAvailableInThisProcess=True,preparedTransactionRetained=True)
            if not record.get('control_fifo'):
                record['control_fifo']=receipt+'.control';os.mkfifo(record['control_fifo'],0o600)
            path=receipt if not pathlib.Path(receipt).exists() else receipt+'.installed'
            record['installedReceipt']=path
            for key in ['errorType','error','observerDiagnostic']:record.pop(key,None)
            tx._charge_output(len(json.dumps(record).encode()))
            write_receipt(path,record)
            return True
        except Exception as error:
            error_record(record,error)
            commands=tx.host.commands
            if tx.state!='prepared' or getattr(tx,'captured',None) is None or commands.action_count!=0 or commands.uncertain:
                raise
            record.update(state='prepared-held-no-service-effects',transaction_state=tx.state,
                          serviceActions=0,ownerWindowSelected=False,preparedTransactionRetained=True,
                          automaticRetry=False,prepareCalledAgain=False,retainedAttempt=attempt)
            fifo=receipt+'.control'
            if not record.get('control_fifo'):
                os.mkfifo(fifo,0o600);record['control_fifo']=fifo
            path=receipt if not pathlib.Path(receipt).exists() else receipt+'.refusal-'+str(attempt)
            raw=json.dumps(record).encode()
            tx._charge_output(len(raw))
            write_receipt(path,record)
            while True:
                record['phase']='prepared-control'
                decision=read_decision(fifo)
                if decision=='abort-before-effects':
                    record.update(state='owner-aborted-before-effects',ownerWindowSelected=False)
                    tx._charge_output(len(json.dumps(record).encode()))
                    write_receipt(receipt+'.aborted',record);return False
                prefix='retry-owner-window-selected '
                if decision.startswith(prefix) and decision[len(prefix):].strip():
                    reason=decision[len(prefix):].strip()
                    if len(reason.encode())>256:continue
                    record.update(ownerWindowSelected=True,ownerChangedConditionReason=reason,
                                  priorRefusalReceipt=path)
                    attempt+=1
                    break
                # EOF, bare retry, finish and unknown input do not replay or drop tx.


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec',required=True);parser.add_argument('--receipt',required=True)
    parser.add_argument('--mode',choices=['probe','cutover'],default='probe')
    parser.add_argument('--owner-window-selected',action='store_true')
    args=parser.parse_args();record={'mode':args.mode,'pid':os.getpid(),'ppid':os.getppid(),'uid':os.getuid(),'observedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'ownerWindowSelected':False,'serviceActions':0}
    tx=None;fatal=False;record['phase']='configuration'
    try:
        spec=owned_json(args.spec);record['ancestry']=independent(os.getpid(),spec['old_root_pids']);record['outsideOldAncestry']=True
        record['spec_sha256']=hashlib.sha256(pathlib.Path(args.spec).read_bytes()).hexdigest()
        if args.mode=='probe':
            record['state']='independent-executor-proven-no-service-action';record['executionInputsReady']=all(k in spec for k in ['plan','selection','adapter_directory','adapter_sha256','ps_command','external_report'])
            return 0
        if not args.owner_window_selected:raise RuntimeError('Actual parent-selected owner window required; receipt is not authority')
        record['ownerWindowSelected']=True
        record['phase']='construction';tx=transaction(spec)
        # Public legacy inspection can restore providers: do not invoke it in a
        # live preparation probe. It runs only inside the actual owner window.
        record['phase']='preparation';tx.prepare();record['prepared']=True
        record['phase']='terminal-report-reservation'
        tx._charge_output(TERMINAL_LIMIT);record['terminalReportReserved']=True
        if not cutover_retaining_prepared(tx,record,args.receipt):return 2
        # Retain the owning transaction while delivery verifies loaded bytes and
        # selects finish or a separate actual rollback window. No automatic replay.
        if not record.get('control_fifo'):
            record['control_fifo']=args.receipt+'.control';os.mkfifo(record['control_fifo'],0o600)
        # Installed receipt was already written, preserving any initial refusal.
        # No existing receipt is overwritten or relabelled as installed.
        while True:
            record['phase']='installed-control'
            with open(record['control_fifo'],'r') as control:
                decision=control.readline(128).strip()
            if decision=='finish':return 0
            if decision=='rollback-owner-window-selected':
                record['phase']='rollback';tx.rollback(owner_window_selected=True)
                record['phase']='rollback-report';write_receipt(args.receipt+'.rollback',{'state':tx.state,'ownerWindowSelected':True});return 0
            # EOF/unknown input does not drop the live transaction or replay work.
            # Only an actual owner decision through the owned control FIFO finishes.

    except Exception as error:
        fatal=True
        record['state']='refused-or-recovery-required';error_record(record,error)
        if tx is not None:
            record['transaction_state']=tx.state;record['serviceActions']=tx.host.commands.action_count if tx.host.commands else 0
        try:terminal_failure(args.receipt,record,tx,error)
        except Exception as reporting_error:
            # Even a reporter implementation/storage failure cannot replace the
            # original terminal reason or successful earlier immutable records.
            fallback={k:record.get(k) for k in ['phase','transaction_state','serviceActions','errorType','error']}
            fallback['terminalReportErrorType']=type(reporting_error).__name__
            try:sys.stderr.write(json.dumps(fallback)+'\n');sys.stderr.flush()
            except Exception:pass
        return 2
    finally:
        if not pathlib.Path(args.receipt).exists():
            try:write_receipt(args.receipt,record,max_bytes=TERMINAL_LIMIT if record.get('terminalReportReserved') else EARLY_TERMINAL_LIMIT)
            except Exception as report_error:
                if not fatal:raise
                # A terminal outcome or its stderr fallback already exposes the
                # original failure; initial-report failure cannot replace it.
                try:sys.stderr.write('Initial receipt reporting failed: '+type(report_error).__name__+'\n')
                except Exception:pass

if __name__=='__main__':raise SystemExit(main())
