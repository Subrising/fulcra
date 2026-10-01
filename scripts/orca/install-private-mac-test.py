from pathlib import Path
import importlib.util,tempfile,unittest,os,json
spec=importlib.util.spec_from_file_location('install',Path(__file__).with_name('install-private-mac.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class DeliveryTests(unittest.TestCase):
    def test_symlink_inventory_never_follows_outside_target(self):
        with tempfile.TemporaryDirectory() as d:
            r=Path(d);(r/'source').mkdir();(r/'outside').mkdir();(r/'outside/private').write_text('not distributed');os.symlink(r/'outside',r/'source/link');x=m.inventory(r/'source');self.assertEqual(set(x),{'link'});self.assertEqual(x['link']['link'],str(r/'outside'))
    def test_exact_copy_refuses_existing_target_and_detects_tamper(self):
        with tempfile.TemporaryDirectory() as d:
            r=Path(d);a=r/'a';a.mkdir();(a/'file').write_text('pinned');x=m.inventory(a);m.copy_exact(a,r/'b',x);self.assertEqual(m.inventory(r/'b'),x)
            with self.assertRaises(AssertionError):m.copy_exact(a,r/'b',x)
            (a/'file').write_text('changed')
            with self.assertRaises(AssertionError):m.copy_exact(a,r/'c',x)
    def test_process_birth_mismatch_never_requests_quit(self):
        original=m.process;quit_call=m.run;calls=[];observations=iter([{'args':'/x/Orca.app/Contents/MacOS/Orca','birth':'new'},None]);m.process=lambda _:next(observations);m.run=lambda a:calls.append(a)
        try:
            with self.assertRaises(AssertionError):m.quit_owned({'pid':123,'args':'/x/Orca.app/Contents/MacOS/Orca','executable':'/x/Orca.app/Contents/MacOS/Orca','birth':'old'})
        finally:m.process=original;m.run=quit_call
        self.assertEqual(calls,[])
    def test_singleton_anomaly_refuses_even_if_dangling(self):
        with tempfile.TemporaryDirectory() as d:
            r=Path(d);os.symlink('/nonexistent',r/'SingletonLock')
            with self.assertRaises(AssertionError):m.inactive(r)
    def test_daemon_setting_cannot_be_enabled(self):
        with tempfile.TemporaryDirectory() as d:
            r=Path(d);p=r/'desktop-settings.json';p.write_text(json.dumps({'settings':{'daemon':{'manageBuiltInDaemon':False,'keepRunningAfterQuit':False}}}));m.settings(r);p.write_text(json.dumps({'settings':{'daemon':{'manageBuiltInDaemon':True,'keepRunningAfterQuit':False}}}))
            with self.assertRaises(AssertionError):m.settings(r)
    def test_process_probe_and_inactive_empty_profile(self):
        self.assertEqual(m.process(os.getpid())['pid'],os.getpid());self.assertIsNone(m.process(2147483647))
        with tempfile.TemporaryDirectory() as d:m.inactive(Path(d))
    def test_exact_graceful_quit_and_refused_timeout_never_force_kill(self):
        record={'pid':123,'args':'/x/Orca.app/Contents/MacOS/Orca','executable':'/x/Orca.app/Contents/MacOS/Orca','birth':'same'};original=(m.process,m.run,m.time.monotonic,m.time.sleep);calls=[]
        try:
            states=iter([record,None]);m.process=lambda _:next(states);m.run=lambda a:calls.append(a);m.quit_owned(record);self.assertEqual(calls[0][:3],['/usr/bin/osascript','-l','JavaScript'])
            m.process=lambda _:None;m.quit_owned(record);self.assertEqual(len(calls),1)
            m.process=lambda _:record;times=iter([0,31]);m.time.monotonic=lambda:next(times)
            with self.assertRaisesRegex(RuntimeError,'no force kill'):m.quit_owned(record)
            self.assertEqual(len(calls),2)
        finally:m.process,m.run,m.time.monotonic,m.time.sleep=original
    def test_private_install_rollback_reinstall_preserves_profiles_and_bundle(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);e=root/'evidence';e.mkdir();home=root/'home';profile=home/'Library/Application Support/Orca';profile.mkdir(parents=True);(profile/'desktop-settings.json').write_text(json.dumps({'settings':{'daemon':{'manageBuiltInDaemon':False,'keepRunningAfterQuit':False}}}));(profile/'retained-note').write_text('old profile')
            app=root/'candidate/Orca.app';app.mkdir(parents=True);(app/'reviewed-bytes').write_text('accepted app');target=root/'Applications/Orca.app';target.parent.mkdir()
            inv=e/'inventory.json';inv.write_text(json.dumps({'files':m.inventory(app),'profileFiles':m.inventory(profile)}));owned=e/'owned.json';owned.write_text('[]');package=e/'package.json';package.write_text(json.dumps({'source':'a'*40,'bundle':str(app),'target':'/Applications/Orca.app','profile':str(profile),'inventory':str(inv),'ownedProcesses':str(owned),'pins':{str(inv):m.sha(inv),str(owned):m.sha(owned)}}))
            originalPath=m.Path;originalRun=m.run;originalInactive=m.inactive;originalQuit=m.quit_owned;originalArgs=m.sys.argv;calls=[]
            def mapped(p):return target if str(p)=='/Applications/Orca.app' else Path(p)
            mapped.home=lambda:home
            def run(args):
                calls.append(args)
                if args[0]=='/usr/bin/codesign':return ''
                return originalRun(args)
            (profile/'retained-note').write_text('newer current profile');owned.write_text('[{}]');p=json.loads(package.read_text());p['pins'][str(owned)]=m.sha(owned);package.write_text(json.dumps(p));events=[]
            def quit_owned(r):events.append('quit');(profile/'DIPS-wal').write_text('final flushed bytes')
            def inactive(p):events.append('inactive')
            m.Path=mapped;m.run=run;m.inactive=inactive;m.quit_owned=quit_owned
            try:
                def invoke(mode):m.sys.argv=['test',mode,str(package),m.sha(package)];m.main()
                invoke('install');self.assertEqual(events,['quit','inactive']);self.assertEqual((target/'reviewed-bytes').read_text(),'accepted app');self.assertEqual((profile/'retained-note').read_text(),'newer current profile');self.assertEqual((e/'profile-before/retained-note').read_text(),'newer current profile');self.assertEqual((e/'profile-before/DIPS-wal').read_text(),'final flushed bytes')
                (profile/'new-preference').write_text('new profile retained');(e/'verification-process.json').write_text('{}');invoke('rollback');self.assertFalse(target.exists());self.assertFalse((profile/'new-preference').exists());self.assertEqual((e/'profile-after/new-preference').read_text(),'new profile retained')
                invoke('reinstall');self.assertEqual((profile/'new-preference').read_text(),'new profile retained');self.assertEqual((profile/'retained-note').read_text(),'newer current profile');self.assertTrue(target.exists());self.assertEqual((e/'profile-before-restored/retained-note').read_text(),'newer current profile')
                with self.assertRaises(FileExistsError):invoke('reinstall')
                self.assertTrue(all(x[0] in ['/usr/bin/ditto','/usr/bin/codesign'] for x in calls))
            finally:m.Path=originalPath;m.run=originalRun;m.inactive=originalInactive;m.quit_owned=originalQuit;m.sys.argv=originalArgs
if __name__=='__main__':unittest.main()
