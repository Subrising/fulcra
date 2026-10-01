import datetime,json,os,shutil,signal,subprocess,sys,time
from pathlib import Path
ROOT=Path(os.environ['FIX_RELEASE_ROOT'])
INTERNAL_MIN=int(os.environ['FIX_INTERNAL_MIN_GIB'])
extra=os.environ.get('FIX_E1_ROOT')
paths=[ROOT]+([Path(extra)] if extra else [])
limit=5*2**30
receipt=Path(os.environ['FIX_RESOURCE_RECEIPT'])
log=receipt.with_suffix('.samples.jsonl')
env=os.environ.copy()
if extra:
 for key in ['TMPDIR','TMP','TEMP']:env[key]=extra+'/tmp'
 env['npm_config_cache']=extra+'/cache/npm'
 env['XDG_CACHE_HOME']=extra+'/cache'
p=subprocess.Popen(sys.argv[1:],start_new_session=True,env=env)
peak=0;reason=None;crossing=None
try:
 with log.open('x') as f:
  while p.poll() is None:
   allocations={}
   for x in paths:
    if x.exists():
     d=subprocess.run(['du','-sk',str(x)],capture_output=True,text=True)
     if d.returncode==0:allocations[str(x)]=int(d.stdout.split()[0])*1024
   used=sum(allocations.values());peak=max(peak,used)
   sample={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'internalFreeBytes':shutil.disk_usage('/').free,'externalFreeBytes':shutil.disk_usage(os.environ['SPACE_VOLUME']).free,'allocatedBytes':used,'paths':allocations}
   f.write(json.dumps(sample)+'\n');f.flush()
   if sample['internalFreeBytes']<INTERNAL_MIN*2**30:reason=f'internal free space below {INTERNAL_MIN} GiB'
   elif sample['externalFreeBytes']<int(os.environ['EXTERNAL_MIN_GIB'])*2**30:reason='external free space below configured floor'
   elif used>limit:reason='batch allocation exceeded 5 GiB budget'
   if reason:
    crossing=sample;os.killpg(p.pid,signal.SIGTERM)
    try:p.wait(timeout=10)
    except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
    break
   time.sleep(1)
finally:
 receipt.write_text(json.dumps({'peakAllocatedBytes':peak,'limitBytes':limit,'stopReason':reason,'crossing':crossing,'samples':str(log),'exitCode':p.poll()},indent=2)+'\n')
sys.exit(75 if reason else p.returncode)
