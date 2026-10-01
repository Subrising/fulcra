import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { provenance } from './provenance.mjs';
import { sealBundle, verifyBundle } from './contract.mjs';

test('one-checkout provenance retains gate aliases and rejects dirty or unexpected source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fulcra-provenance-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {stdio:['ignore','pipe','pipe'], encoding:'utf8'}).trim();
  const expected = process.env.EXPECTED_REPO_COMMIT;
  const ancestors = process.env.REQUIRED_ANCESTORS;
  try {
    git('init'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(root, 'source'), 'reviewed source'); git('add','.'); git('commit','-m','fixture');
    const head = git('rev-parse','HEAD');
    process.env.EXPECTED_REPO_COMMIT = head; process.env.REQUIRED_ANCESTORS = head;
    const p = provenance(root);
    assert.equal(p.repoCommit, head); assert.equal(p.productCommit, head); assert.equal(p.controlCommit, head);
    assert.deepEqual(p.heads, {product:head, control:head});
    process.env.EXPECTED_REPO_COMMIT = '0'.repeat(40);
    assert.throws(() => provenance(root), /Unexpected repo commit/);
    process.env.EXPECTED_REPO_COMMIT = head;
    fs.writeFileSync(path.join(root, 'source'), 'unreviewed source');
    assert.throws(() => provenance(root), /clean checkout/);
  } finally {
    if (expected === undefined) delete process.env.EXPECTED_REPO_COMMIT; else process.env.EXPECTED_REPO_COMMIT = expected;
    if (ancestors === undefined) delete process.env.REQUIRED_ANCESTORS; else process.env.REQUIRED_ANCESTORS = ancestors;
    fs.rmSync(root, {recursive:true, force:true});
  }
});

test('retained bundle seal detects mutations and links escaping the app', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fulcra-seal-'));
  const app = path.join(scratch, 'Fulcra.app');
  try {
    fs.mkdirSync(path.join(app,'Contents/MacOS'), {recursive:true});
    fs.mkdirSync(path.join(app,'Contents/Resources'), {recursive:true});
    fs.writeFileSync(path.join(app,'Contents/MacOS/Fulcra'), 'binary fixture');
    const asar = path.join(app,'Contents/Resources/app.asar');
    fs.writeFileSync(asar, 'archive fixture');
    const pin = sealBundle(app); assert.equal(verifyBundle(app,pin).sha256, pin.sha256);
    fs.writeFileSync(asar,'mutated archive');
    assert.throws(() => verifyBundle(app,pin), /digest mismatch/);
    fs.writeFileSync(path.join(scratch,'outside'),'outside');
    fs.symlinkSync(path.join(scratch,'outside'),path.join(app,'escape'));
    assert.throws(() => sealBundle(app), /escapes root/);
  } finally { fs.rmSync(scratch, {recursive:true, force:true}); }
});

test('portable setup prepares one clone with all control components pinned to its SHA', async () => {
  const { install } = await import('../scripts/orca/bootstrap.mjs');
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'fulcra-single-'));
  const source = path.join(scratch, 'source');
  fs.mkdirSync(path.join(source,'control/src'), {recursive:true});
  const git = (...args) => execFileSync('git',['-C',source,...args],{stdio:['ignore','pipe','pipe'],encoding:'utf8'}).trim();
  try {
    git('init'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(source,'control/src/portable-config.mjs'),'export const fixture = true;');
    git('add','.'); git('commit','-m','fixture');
    const head = git('rev-parse','HEAD'), home = path.join(scratch,'install');
    assert.equal((await install(home,{source,prepareOnly:true})).state,'sources-prepared');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home,'sources.json'))), {native:head,runtime:head,conversation:head,workspace:head});
    for (const name of ['runtime','conversation','workspace'])
      assert.equal(fs.realpathSync(path.join(home,'sources',name)),fs.realpathSync(path.join(home,'sources/native/control')));
    assert.ok(fs.existsSync(path.join(home,'sources/native/.git')));
  } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
});

test('legacy component setup refuses missing local pins before creating a home', async () => {
  const { pathToFileURL } = await import('node:url');
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'fulcra-pins-'));
  try {
    const script = path.join(scratch, 'scripts/orca/bootstrap.mjs');
    fs.mkdirSync(path.dirname(script), {recursive:true});
    fs.copyFileSync(new URL('../scripts/orca/bootstrap.mjs', import.meta.url), script);
    const { install } = await import(pathToFileURL(script));
    const home = path.join(scratch, 'install');
    await assert.rejects(install(home, {runtime:'/fixture/runtime', prepareOnly:true}), /Populate local\/components.json/);
    assert.equal(fs.existsSync(home), false);
  } finally { fs.rmSync(scratch, {recursive:true, force:true}); }
});
