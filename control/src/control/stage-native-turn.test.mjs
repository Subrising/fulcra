import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validateStagePaths, NATIVE_SOURCES, resolveNativeSource, resolveStageSelection, stageDestinations, assertStageDestinations, stageNativeTurn } from './stage-native-turn.mjs';

test('runtime upgrades retain one private controller journal without cloning or aliasing authority', t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'orca-runtime-stage-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=root+'/state',out=root+'/new-runtime',journal=home+'/journal.sqlite';
  fs.mkdirSync(home,{mode:0o700});fs.writeFileSync(journal,'existing authority',{mode:0o600});
  validateStagePaths(out,home,journal);assert.equal(fs.readFileSync(journal,'utf8'),'existing authority');assert(!fs.existsSync(out));
  validateStagePaths(out,out,out+'/journal.sqlite');
  assert.throws(()=>validateStagePaths(out,home,root+'/other.sqlite'),/exact controller journal/);
  assert.throws(()=>validateStagePaths(out,home,home+'/sub/../journal.sqlite'),/exact controller journal/);
  fs.chmodSync(journal,0o644);assert.throws(()=>validateStagePaths(out,home,journal),/private/);fs.chmodSync(journal,0o600);
  fs.chmodSync(home,0o755);assert.throws(()=>validateStagePaths(out,home,journal),/private/);fs.chmodSync(home,0o700);
  fs.linkSync(journal,home+'/alias');assert.throws(()=>validateStagePaths(out,home,journal),/unaliased/);fs.unlinkSync(home+'/alias');
  fs.renameSync(journal,home+'/real');fs.symlinkSync(home+'/real',journal);assert.throws(()=>validateStagePaths(out,home,journal),/unaliased/);fs.unlinkSync(journal);fs.renameSync(home+'/real',journal);
  fs.symlinkSync(home,root+'/linked');assert.throws(()=>validateStagePaths(out,root+'/linked',root+'/linked/journal.sqlite'),/unaliased/);
  fs.mkdirSync(out);assert.throws(()=>validateStagePaths(out,home,journal),/New private staging/);
});

test('reviewed source selection stays pinned and independent of the staging layout',()=>{
  const names=Object.keys(NATIVE_SOURCES.maintained.durableFiles);
  assert.deepEqual(Object.keys(NATIVE_SOURCES.reviewed.durableFiles),names);
  assert.notDeepEqual(NATIVE_SOURCES.reviewed.durableFiles,NATIVE_SOURCES.maintained.durableFiles);
  assert.equal(resolveNativeSource().head,NATIVE_SOURCES.maintained.head);
  assert.deepEqual(resolveNativeSource('reviewed'),{head:NATIVE_SOURCES.reviewed.head,durableFiles:{...NATIVE_SOURCES.reviewed.durableFiles}});
  assert.throws(()=>resolveNativeSource('portable'),/exact commit/);
  assert.throws(()=>resolveNativeSource({head:NATIVE_SOURCES.reviewed.head.slice(1),durableFiles:NATIVE_SOURCES.reviewed.durableFiles}),/exact commit/);
  assert.throws(()=>resolveNativeSource({head:NATIVE_SOURCES.reviewed.head}),/hash every durable/);
  const partial={...NATIVE_SOURCES.reviewed.durableFiles,extra:'0'.repeat(64)};delete partial[names[0]];
  assert.throws(()=>resolveNativeSource({head:NATIVE_SOURCES.reviewed.head,durableFiles:partial}),/hash every durable/);
  const short={...NATIVE_SOURCES.reviewed.durableFiles};short[names[0]]='abc';
  assert.throws(()=>resolveNativeSource({head:NATIVE_SOURCES.reviewed.head,durableFiles:short}),/hash every durable/);
});

test('each layout stages portable-config beside its guards and refuses occupied destinations',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'orca-runtime-layout-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=root+'/state',out=root+'/new-runtime';
  fs.mkdirSync(home,{mode:0o700});fs.writeFileSync(home+'/journal.sqlite','existing authority',{mode:0o600});
  assert.throws(()=>stageDestinations({outputRoot:out,controllerHome:home,layout:'portableSourceHead'}),/legacy or portable/);
  const legacy=stageDestinations({outputRoot:out,controllerHome:home,layout:'legacy'});
  assert.deepEqual(legacy,{layout:'legacy',guards:out+'/control',configFile:out+'/portable-config.mjs',activeFile:null});
  const portable=stageDestinations({outputRoot:out,controllerHome:home,layout:'portable'});
  assert.deepEqual(portable,{layout:'portable',guards:home+'/admission',configFile:home+'/portable-config.mjs',activeFile:home+'/admission/active.json'});
  for(const d of [legacy,portable])assert.equal(path.resolve(d.guards,'../portable-config.mjs'),d.configFile);
  assertStageDestinations(legacy);assertStageDestinations(portable);
  // An installed legacy controller already owns admission/; portable layout must refuse it
  // before anything is staged, while legacy layout stays inside the new staging root.
  fs.mkdirSync(home+'/admission',{mode:0o700});
  assert.throws(()=>assertStageDestinations(portable),/already exists: .*\/state\/admission$/);
  assertStageDestinations(legacy);
  assert.throws(()=>stageNativeTurn({sourceRoot:root,outputRoot:out,journalFile:home+'/journal.sqlite',controllerHome:home,layout:'legacy',nativeSource:'reviewed',portableSourceHead:NATIVE_SOURCES.reviewed.head}),/either portableSourceHead or explicit/);
  assert(!fs.existsSync(out));
});

test('a currently selected portable commit stages without a registry edit while pinned paths stay pinned',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'orca-runtime-selected-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  // scripts/orca/components.json currently selects this native commit; upstream updates move it,
  // so the installer call must not depend on this module knowing the commit in advance.
  const current='f590094b61ce092bc2b21c883404706feb891ce3';
  assert(!Object.values(NATIVE_SOURCES).some(p=>p.head===current));
  assert.deepEqual(resolveStageSelection({portableSourceHead:current}),{layout:'portable',nativeSource:null,selectedHead:current});
  assert.deepEqual(resolveStageSelection({}),{layout:'legacy',nativeSource:'maintained',selectedHead:null});
  assert.deepEqual(resolveStageSelection({layout:'legacy',nativeSource:'reviewed'}),{layout:'legacy',nativeSource:'reviewed',selectedHead:null});
  assert.throws(()=>resolveStageSelection({portableSourceHead:'0'.repeat(41)}),/exact commit/);
  assert.throws(()=>resolveStageSelection({layout:'portable',portableSourceHead:current}),/either portableSourceHead or explicit/);

  const source=root+'/native',server=source+'/packages/server';
  for(const file of Object.keys(NATIVE_SOURCES.maintained.durableFiles)){
    fs.mkdirSync(path.join(server,path.dirname(file)),{recursive:true});fs.writeFileSync(path.join(server,file),'// '+file+'\n');
  }
  fs.writeFileSync(server+'/package.json','{}\n');fs.writeFileSync(source+'/package.json','{}\n');
  fs.mkdirSync(source+'/node_modules');fs.writeFileSync(source+'/node_modules/.keep','');
  const git=(...a)=>execFileSync('git',a,{cwd:source,encoding:'utf8'}).trim();
  git('init','-q','-b','main');git('config','user.email','stage@test');git('config','user.name','stage');
  git('add','-A');git('-c','commit.gpgsign=false','commit','-q','-m','fixture');
  const head=git('rev-parse','HEAD');
  assert(!Object.values(NATIVE_SOURCES).some(p=>p.head===head));
  const home=root+'/home';fs.mkdirSync(home,{mode:0o700});fs.writeFileSync(home+'/journal.sqlite','x',{mode:0o600});
  const call=(n,extra)=>stageNativeTurn({sourceRoot:source,outputRoot:root+'/out-'+n,journalFile:home+'/journal.sqlite',controllerHome:home,...extra});
  // Accepted: selection and durable recording pass, staging proceeds to the native patch anchors.
  assert.throws(()=>call('selected',{portableSourceHead:head}),/Native manager anchor changed/);
  assert.equal(fs.readFileSync(home+'/portable-config.mjs','utf8'),fs.readFileSync(new URL('../portable-config.mjs',import.meta.url),'utf8'));
  assert(fs.existsSync(home+'/admission/authority.mjs'));
  // Refused: mismatched commit, unclean checkout, and every pinned selection against this source.
  assert.throws(()=>call('other',{portableSourceHead:'a'.repeat(40)}),/Exact clean selected/);
  assert.throws(()=>call('legacy-pin',{layout:'legacy',nativeSource:'reviewed'}),/Exact clean selected/);
  const wrong={head,durableFiles:Object.fromEntries(Object.keys(NATIVE_SOURCES.maintained.durableFiles).map(f=>[f,'b'.repeat(64)]))};
  assert.throws(()=>call('legacy-drift',{layout:'legacy',nativeSource:wrong}),/Pinned durable native build drift/);
  fs.appendFileSync(server+'/package.json','\n');
  assert.throws(()=>call('dirty',{portableSourceHead:head}),/Exact clean selected/);
  assert.deepEqual(fs.readdirSync(root).filter(n=>n.startsWith('out-')),['out-selected']);
});
