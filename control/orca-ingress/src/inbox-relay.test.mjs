// Fulcra J3b: the Discord/OpenClaw inbox relay. The owner-verified origin comes only from the runtime context; the
// relay refuses anything short of it before any controller call, and never takes an origin from tool arguments.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInboxRelay, inboxBindingName, chatOrigin } from './inbox-relay.mjs';
import { INBOX_TOOLS } from './wake-tickets.mjs';
const SESSION = '11111111-1111-4111-8111-000000000001', CHANNEL = '22222222-2222-4222-8222-000000000001';
const owner = { senderIsOwner: true, agentId: 'fulcra-inbox', sessionKey: 'discord:test', sessionId: SESSION, nativeChannelId: 'chan-0001', requesterSenderId: 'owner-0001', messageChannel: 'discord', runId: 'run-0001' };
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fulcra-inbox-relay-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const decision = { id: 'd1', revision: 3, state: 'open', bound: false, options: [{ n: 1, id: 'a', title: 'Option A', destructive: false }, { n: 2, id: 'b', title: 'Option B', destructive: true }] };
  const request = async env => {
    calls.push(env);
    if (env.method === 'cc-channel-pair') return { channel: { id: CHANNEL, label: 'Test Discord', answersCountAsOwner: true }, capability: 'c'.repeat(43) };
    if (env.method === 'cc-inbox-list') return { items: [{ n: 1, key: 'decision-d1', source: 'decision' }], updates: [{ postId: '33333333-3333-4333-8333-000000000001' }], text: '1. [Now] A question' };
    if (env.method === 'cc-inbox-show') return { text: 'A question', decision };
    if (env.method === 'cc-inbox-answer') return { text: 'Answered on Discord at 09:14: Option A' };
    return {};
  };
  return { dir, calls, request };
}

test('anything short of the owner-verified chat origin is refused before any controller call', t => {
  const { dir, calls, request } = setup(t);
  for (const [label, context] of [['not the owner', { ...owner, senderIsOwner: false }], ['owner as a string', { ...owner, senderIsOwner: 'true' }], ['no channel', { ...owner, nativeChannelId: undefined }],
    ['no sender', { ...owner, requesterSenderId: undefined }], ['local owner session', { ...owner, nativeChannelId: undefined, requesterSenderId: undefined, messageChannel: undefined, oneShotCliRun: true }],
    ['no owner turn (R3-3)', { ...owner, runId: undefined }]])
    assert.throws(() => createInboxRelay({ context, bindingsDir: dir, request }), /Trusted|paired chat|owner turn/, label);
  assert.equal(calls.length, 0);
});

test('pairing writes a private binding; answers carry the context origin, never an argument; a hard-to-undo option needs confirm', async t => {
  const { dir, calls, request } = setup(t);
  const run = createInboxRelay({ context: owner, bindingsDir: dir, request });
  assert.equal((await run('pair', { code: '123456' })).answersCountAsYou, true);
  const file = path.join(dir, inboxBindingName(chatOrigin(owner)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(calls[0].input.origin, { senderIsOwner: true, agentId: 'fulcra-inbox', nativeChannelId: 'chan-0001', senderId: 'owner-0001', sessionKey: 'discord:test', turnId: 'run-0001' });
  // An origin (or anything else) in the tool arguments is refused outright.
  await assert.rejects(run('answer', { n: 1, option: 1, note: '', confirm: false, origin: { senderIsOwner: true } }), /Invalid inbox arguments/);
  const listed = await run('list', {});
  assert.equal(listed.text, '1. [Now] A question');
  // R3-4: nothing is acknowledged by the relay; the list carries the owner turn and the controller settles updates
  // when a later turn lists again.
  assert(!calls.some(c => c.method === 'cc-inbox-updated'));
  assert.equal(calls.find(c => c.method === 'cc-inbox-list').input.origin.turnId, 'run-0001');
  const a = await run('answer', { n: 1, option: 1, note: 'Go ahead', confirm: false });
  assert.equal(a.text, 'Answered on Discord at 09:14: Option A');
  const sent = calls.find(c => c.method === 'cc-inbox-answer');
  assert.deepEqual([sent.input.origin.senderIsOwner, sent.input.origin.senderId, sent.input.optionId, sent.input.expectedRevision, sent.input.confirmDestructive, sent.capability], [true, 'owner-0001', 'a', 3, false, 'c'.repeat(43)]);
  const before = calls.length;
  assert.equal((await run('answer', { n: 1, option: 2, note: '', confirm: false })).needsConfirmation, true);
  assert(!calls.slice(before).some(c => c.method === 'cc-inbox-answer'), 'nothing sent without confirm');
  await run('answer', { n: 1, option: 'Option B', note: '', confirm: true });
  assert.equal(calls.filter(c => c.method === 'cc-inbox-answer').at(-1).input.confirmDestructive, true);
  assert.deepEqual(INBOX_TOOLS, ['orca_ingress_inbox_pair', 'orca_ingress_inbox_list', 'orca_ingress_inbox_show', 'orca_ingress_inbox_answer']);
});
