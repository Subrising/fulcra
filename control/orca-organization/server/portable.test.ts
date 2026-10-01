import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { firstRun } from '../../src/config.mjs';
import { readNativeHostBindings } from './host-binding';
import { installationPath } from './installation';
import { conversationLink } from '../client/conversation-link';
import { readSelectedTask, rememberSelectedTask } from '../client/selected-task';
test('plugin uses shared config, named hosts and explicit navigation identity', () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cc-plugin-')), old = process.env.ORCA_HOME;
  try {
    firstRun({ ORCA_HOME: home }); process.env.ORCA_HOME = home;
    assert.deepEqual(readNativeHostBindings(), { 'This Mac': null });
    const file = path.join(home, 'config.json'), c = JSON.parse(fs.readFileSync(file, 'utf8'));
    c.localHost = { name: 'Desk', serverId: 'srv_abcdefgh' };
    c.hosts = [{ name: 'Workshop', serverId: 'srv_ijklmnop', sshTarget: 'user@workshop.example' }, { name: 'Studio', serverId: null }];
    fs.writeFileSync(file, JSON.stringify(c));
    assert.deepEqual(readNativeHostBindings(), { Desk: 'srv_abcdefgh', Workshop: 'srv_ijklmnop', Studio: null });
    assert.equal(installationPath('controllerHome'), home);
    assert.equal(installationPath('tasks'), path.join(home, 'tasks'));
    const id = '11111111-1111-4111-8111-111111111111';
    assert.equal(conversationLink('Workshop', id, undefined, undefined).open, undefined);
    const seen: unknown[] = [];
    const link = conversationLink('Workshop', id, undefined, { openAgentOnHost: (input: { serverId: string; agentId: string }) => { seen.push(input); return 'requested'; } } as any, 'srv_ijklmnop');
    assert.equal(link.label, 'Workshop'); assert.equal(link.open?.(), 'requested');
    assert.deepEqual(seen, [{ serverId: 'srv_ijklmnop', agentId: id }]);
    assert.equal(readSelectedTask('new-host', false), '');
    rememberSelectedTask('new-host', false, id); assert.equal(readSelectedTask('new-host', false), id);
  } finally { if (old === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = old; fs.rmSync(home, { recursive: true, force: true }); }
});
