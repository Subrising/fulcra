// Cutover A1: the Book ssh target is pinned by the owner-only portable config, never by a literal in shipped code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pinnedBookTarget, sshExchange } from './transport.mjs';
const profile = { host: 'macbook', sshTarget: 'owner@book.example', command: ['/a', '/b', '/c'] };
const config = hosts => () => ({ hosts });
test('the pinned target is the configured Book host entry (macbook, or the only remote host); otherwise none', () => {
  assert.equal(pinnedBookTarget(config([{ name: 'macbook', serverId: 'srv_x', sshTarget: 'owner@book.example' }])), 'owner@book.example');
  assert.equal(pinnedBookTarget(config([{ name: 'studio', serverId: 'srv_x', sshTarget: 'owner@studio.example' }])), 'owner@studio.example');
  assert.equal(pinnedBookTarget(config([{ name: 'a', serverId: 's', sshTarget: 'u@a' }, { name: 'b', serverId: 't', sshTarget: 'u@b' }])), null);
  assert.equal(pinnedBookTarget(config([{ name: 'macbook', serverId: 'srv_x' }])), null);
  assert.equal(pinnedBookTarget(config([{ name: 'macbook', serverId: 'srv_x', sshTarget: '-oProxyCommand=x' }])), null);
  assert.equal(pinnedBookTarget(() => { throw Error('no config'); }), null);
});
test('no ssh runs unless the profile target equals the pinned one', () => {
  assert.throws(() => sshExchange(profile, {}, null), /Unsupported Book transport profile/);
  assert.throws(() => sshExchange(profile, {}, 'other@book.example'), /Unsupported Book transport profile/);
  assert.throws(() => sshExchange({ ...profile, host: 'studio' }, {}, 'owner@book.example'), /Unsupported Book transport profile/);
  assert.throws(() => sshExchange({ ...profile, command: ['a', '/b', '/c'] }, {}, 'owner@book.example'), /Unsupported Book transport profile/);
});
test('shipped transport source carries no personal ssh address', () => {
  const source = fs.readFileSync(new URL('./transport.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /gray@|100\.90\./);
});
