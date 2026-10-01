import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('../../',import.meta.url));
test('fresh distribution imports without config, then creates private first-run state',()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cc-first-run-'))),home=path.join(root,'command-centre');
 try {
  const result=spawnSync(process.execPath,['--loader',path.join(repo,'tools/host-test-loader.mjs'),'--input-type=module','-e',`const {createDistribution}=await import('./src/control/distribution-host.mjs');createDistribution({home:process.env.ORCA_HOME,bundleDirectory:process.cwd()});`],{cwd:repo,env:{...process.env,PASEO_HOME:root,ORCA_HOME:home},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(fs.statSync(path.join(home,'config.json')).mode&0o777,0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'config.json'))).worktreeLifecycle.retentionDays,'never');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
