import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HostNative } from './host-native.mjs';
import { boundNativeInputs } from './trusted-native-input.mjs';
import { parseControllerRequest } from '@getpaseo/protocol/controller-frames';
function fixture() {
 const observations = { bindings: [], nativeCalls: 0 };
 const inputs = boundNativeInputs({
  daemon: { invokeRawInput: async () => { observations.nativeCalls++; return { accepted: true }; } },
  verifyActivation: () => {},
  issueProvenance: async binding => {
   observations.bindings.push(binding);
   parseControllerRequest({ id: randomUUID(), epoch: randomUUID(), type: 'issue-provenance', binding });
   return 'test-only-provenance';
  },
 });
 const host = Object.create(HostNative.prototype); host.route = () => null; host.local = inputs;
 return { host, observations };
}
test('local HostNative preserves the journaled attempt UUID through the real provenance parser', async () => {
 const { host, observations } = fixture();
 const agent = randomUUID(), message = randomUUID(), attempt = randomUUID();
 await host.send(agent, 'disposable regression', message, attempt);
 assert.equal(observations.bindings[0].attemptId, attempt);
 assert.equal(observations.bindings[0].agentId, agent);
 assert.equal(observations.nativeCalls, 1);
});
test('missing local attempt UUID remains refused before native dispatch', async () => {
 const { host, observations } = fixture();
 await assert.rejects(host.send(randomUUID(), 'disposable regression', randomUUID()), /^Error: Controller frame invalid$/);
 assert.equal(observations.bindings[0].attemptId, undefined);
 assert.equal(observations.nativeCalls, 0);
});
test('Book route retains its three-argument remote dispatch contract', async () => {
 const host = Object.create(HostNative.prototype); host.route = () => ({ phase: 'active' });
 let args; host.remoteSend = async (...values) => { args = values; };
 const id = randomUUID(), message = randomUUID();
 await host.send(id, 'remote regression', message, randomUUID());
 assert.deepEqual(args, [id, 'remote regression', message]);
});
