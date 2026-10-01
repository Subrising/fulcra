"""Deliver an exact pre-reviewed private Orca bundle; no provider/server operations."""
from pathlib import Path
import hashlib,json,os,subprocess,sys,time

def sha(file):return hashlib.sha256(Path(file).read_bytes()).hexdigest()
def inventory(root):
    result={}
    for base,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            p=Path(base)/name;s=p.lstat();key=str(p.relative_to(root))
            if p.is_symlink():result[key]={'link':os.readlink(p),'mode':s.st_mode&0o777}
            elif p.is_file():result[key]={'sha256':sha(p),'size':s.st_size,'mode':s.st_mode&0o777}
    return result

def run(args):return subprocess.run(args,capture_output=True,text=True,check=True,timeout=60).stdout

def process(pid):
    r=subprocess.run(['ps','-p',str(pid),'-o','args='],capture_output=True,text=True)
    if r.returncode:return None
    return {'pid':pid,'args':r.stdout.strip(),'birth':run(['ps','-p',str(pid),'-o','lstart=']).strip()}

def quit_owned(record):
    live=process(record['pid'])
    if live is None:return
    assert live['args']==record['args'] and live['birth']==record['birth'],'Process identity changed'
    assert record['args'].startswith(record['executable']) and record['executable'].endswith('/Orca.app/Contents/MacOS/Orca')
    # Cocoa termination sends the ordinary app quit event; never force-kills or matches by name.
    code="ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier("+str(record['pid'])+").terminate;"
    run(['/usr/bin/osascript','-l','JavaScript','-e',code])
    until=time.monotonic()+30
    while time.monotonic()<until:
        if process(record['pid']) is None:return
        time.sleep(.2)
    raise RuntimeError('Owned app did not exit; no force kill')

def inactive(profile):
    assert not any((profile/x).exists() or (profile/x).is_symlink() for x in ['SingletonLock','SingletonCookie','SingletonSocket']),'Singleton anomaly requires inspection'
    r=subprocess.run(['/usr/sbin/lsof','-t','+D',str(profile)],capture_output=True,text=True,timeout=30)
    assert r.returncode==1 and not r.stdout.strip(),'Profile still open or process inspection failed'

def settings(profile):
    s=json.loads((profile/'desktop-settings.json').read_text())
    assert s['settings']['daemon']=={'manageBuiltInDaemon':False,'keepRunningAfterQuit':False},'Built-in daemon must remain disabled'

def copy_exact(source,target,expected):
    assert not target.exists() and not target.is_symlink(),'Target already exists'
    run(['/usr/bin/ditto',str(source),str(target)]);assert inventory(target)==expected,'Copied inventory differs'

def main():
    assert len(sys.argv)==4 and sys.argv[1] in ['install','rollback','reinstall']
    mode=sys.argv[1];package=Path(sys.argv[2]);assert sha(package)==sys.argv[3];p=json.loads(package.read_text());E=package.parent
    for file,digest in p['pins'].items():assert sha(file)==digest,file
    A=Path(p['bundle']);target=Path(p['target']);profile=Path(p['profile']);assert target==Path('/Applications/Orca.app') and profile==Path.home()/'Library/Application Support/Orca';assert E.stat().st_uid==os.getuid() and not E.is_symlink()
    expected=json.loads(Path(p['inventory']).read_text())['files'];assert inventory(A)==expected;run(['/usr/bin/codesign','--verify','--deep','--strict',str(A)])
    marker=E/(mode+'.started');fd=os.open(marker,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
    def record(name,value):
        f=E/(name+'.json');fd=os.open(f,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'w') as out:json.dump(value,out,indent=2);out.flush();os.fsync(out.fileno())
    if mode=='install':
        assert not target.exists() and not target.is_symlink();settings(profile)
        assert profile.is_dir() and not profile.is_symlink() and profile.stat().st_uid==os.getuid(),'Unexpected normal profile directory'
        for owned in json.loads(Path(p['ownedProcesses']).read_text()):quit_owned(owned)
        inactive(profile);settings(profile);data=inventory(profile);copy_exact(profile,E/'profile-before',data);record('profile-before-inventory',data)
        stage=target.with_name('Orca.installing-'+p['source'][:8]+'.app');copy_exact(A,stage,expected);run(['/usr/bin/codesign','--verify','--deep','--strict',str(stage)]);assert not target.exists();os.rename(stage,target)
    elif mode=='rollback':
        assert inventory(target)==expected;quit_owned(json.loads((E/'verification-process.json').read_text()));inactive(profile);settings(profile)
        data=inventory(profile);record('profile-after-inventory',data);assert not (E/'profile-after').exists();os.rename(profile,E/'profile-after');assert inventory(E/'profile-before')==json.loads((E/'profile-before-inventory.json').read_text());copy_exact(E/'profile-before',profile,json.loads((E/'profile-before-inventory.json').read_text()));assert not (E/'Orca.retained.app').exists();os.rename(target,E/'Orca.retained.app')
    else:
        assert not target.exists() and not target.is_symlink();inactive(profile);assert inventory(profile)==json.loads((E/'profile-before-inventory.json').read_text());assert inventory(E/'profile-after')==json.loads((E/'profile-after-inventory.json').read_text());assert inventory(E/'Orca.retained.app')==expected
        assert not (E/'profile-before-restored').exists();os.rename(profile,E/'profile-before-restored');os.rename(E/'profile-after',profile);os.rename(E/'Orca.retained.app',target)
    settings(profile)
    if mode!='rollback':assert inventory(target)==expected;run(['/usr/bin/codesign','--verify','--deep','--strict',str(target)])
    record(mode+'-complete',{'source':p['source'],'mode':mode,'appPresent':target.exists(),'target':str(target),'profilePreserved':True,'serverOrProviderOperations':0,'at':time.time()});print(json.dumps({'mode':mode,'appPresent':target.exists(),'serverOrProviderOperations':0}))
if __name__=='__main__':main()
