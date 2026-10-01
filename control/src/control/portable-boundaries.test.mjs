import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readCredential } from './credential.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { catalogActivation } from './catalog-activation.mjs';
import { withManagementInvocation } from '../../orca-organization/server/management-context.mjs';
import { permissionProjection } from './permission-projection.mjs';
test('missing trusted host registration cannot authorise a portable controller', () => {
  const activation=catalogActivation({subscribeConnectionStatus:()=>()=>{},isConnected:false});
  assert.throws(()=>activation.require(),/Trusted host activation unavailable/);activation.close();
});
test('permission projection is pure and retains the wire shape', () => {
  const request = { id: 'request', input: { path: 'a', omitted: undefined }, metadata: {}, suggestions: [{}, { kind: 'allow' }], actions: [{ id: 'allow' }] };
  assert.deepEqual(permissionProjection(request), { ...request, input: { path: 'a' }, metadata: undefined, suggestions: [{ kind: 'allow' }], actions: [{ id: 'allow' }] });
});
test('plugin auth seam cannot read the daemon password or load host dependencies', () => {
  const source = fs.readFileSync(new URL('../../orca-organization/server/management.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /bcryptjs|daemonServerPackage|controller\.secret|daemon\?\.auth/);
  assert.doesNotMatch(source,/operator\.secret|assertManagementAuthentication/);
  assert.throws(()=>withManagementInvocation({},false,()=>{}),/Management unavailable/);
});

test('credentials must be private regular files, with no symlink following', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-secret-'));
  try {
    const file = path.join(home, 'credential'), value = randomBytes(32).toString('base64url');
    fs.writeFileSync(file, value, { mode: 0o600 }); assert.equal(readCredential(file), value);
    fs.chmodSync(file, 0o644); assert.throws(() => readCredential(file), /Private owned/);
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, value + 'x'); assert.throws(() => readCredential(file), /Private owned/);
    fs.writeFileSync(file, value);
    const originalStat = fs.fstatSync;
    const ownerMock = mock.method(fs, 'fstatSync', (...args) => { const stat = originalStat(...args); stat.uid = process.getuid() + 1; return stat; });
    try { assert.throws(() => readCredential(file), /Private owned/); } finally { ownerMock.mock.restore(); }
    fs.symlinkSync(file, path.join(home, 'link'));
    assert.throws(() => readCredential(path.join(home, 'link')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
