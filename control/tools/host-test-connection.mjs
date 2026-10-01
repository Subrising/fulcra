// Real Session/manager/client/channel; only the physical child/socket transport is in-memory.
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Session, MessageReceipts, ControllerChannel } from '@fulcra/test-host';
import { DaemonClient } from '../src/control/client-sdk.mjs';
import { catalogActivation } from '../src/control/catalog-activation.mjs';
import { boundNativeInputs } from '../src/control/trusted-native-input.mjs';
export async function controllerTestConnection({ host, manager, storage, logger, home, api }) {
  const daemon = new DaemonClient({ clientId: randomUUID(), clientType: 'cli', url: 'ws://127.0.0.1:1' });
  daemon.connectionState = { status: 'connected' };
  daemon.lastServerInfoMessage = { features: { explicitEventSubscriptions: true } };
  const child = {}, session = Object.create(Session.prototype);
  const replies = new AsyncLocalStorage();
  const emit = message => { replies.getStore()?.push(message); };
  Object.assign(session, {
    agentManager: manager, agentStorage: storage, sessionLogger: logger,
    authorization: { allowsInbound: () => true }, inflightRequests: 0, peakInflightRequests: 0,
    messageReceipts: new MessageReceipts(path.join(home, 'message-receipts')),
    pluginRuntime: { catalog: () => [] }, emit,
    delivery: { request: (_source, _message, run) => run(), requestSignal: new AbortController().signal, isModern: () => true, reply: emit },
  });
  const channel = new ControllerChannel({ child, issue: binding => api.issueProvenance(binding), revoke: () => host.revokeProvenance('orca-organization-next'), send: async () => { throw Error('No management command transport in this input fixture'); },
    rpc: async frame => {
      const sent = [];
      await replies.run(sent, () => session.handleMessage(frame));
      const response = sent.find(message => message.payload?.requestId === frame.requestId);
      if (!response) throw Error('Host did not return a correlated response');
      return JSON.parse(JSON.stringify(response));
    },
  });
  daemon.transport = { close() {}, send(raw) {
    const { message } = JSON.parse(raw);
    void channel.receive(child, { type: 'daemon-rpc', id: randomUUID(), epoch: channel.epoch, frame: message }).then(reply => {
      if (reply.ok) daemon.deliverSessionMessage(reply.result);
      else daemon.deliverSessionMessage({ type: 'rpc_error', payload: { requestId: message.requestId, code: 'channel_unavailable', error: 'Controller channel unavailable' } });
    });
  } };
  const issueProvenance = async binding => {
    const reply = await channel.receive(child, { type: 'issue-provenance', id: randomUUID(), epoch: channel.epoch, binding });
    if (!reply.ok) throw Error('Controller provenance unavailable');
    return reply.result;
  };
  const activation = catalogActivation(daemon); await activation.refresh();
  return { daemon, channel, session, inputs: boundNativeInputs({ daemon, issueProvenance, verifyActivation: () => activation.require() }),
    close: async () => { activation.close(); channel.close(); await daemon.close(); },
  };
}
