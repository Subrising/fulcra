import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { createRelay } from './relay.mjs';
import { request } from './controller-client.mjs';
import { createWakeRuntime } from './wake-runtime.mjs';
import { activeRuntime, sharedService } from './active-runtime.mjs';
import { createInboxRelay } from './inbox-relay.mjs';
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const tools = [
  ['status', object({}), 'Inspect the explicitly bound saved Orca session and durable delivery states.'],
  ['assign', object({ text: { type: 'string', minLength: 1, maxLength: 16384 } }), 'Assign an instruction to the bound delegated session. Inspect an unconfirmed delivery before issuing another command.'],
  ['result', object({ messageId: { type: 'string', format: 'uuid', description: 'The worker delivery messageId (sourceMessageId). Never the internal notificationId. During a completion wake use only its explicitly authorized delivery.' } }), 'Read correlated native output for a delivery. Output and an ended turn do not establish independent acceptance.'],
  ['ack', object({ messageId: { type: 'string', format: 'uuid', description: 'The worker delivery messageId (sourceMessageId). Never the internal notificationId. During a completion wake use only its explicitly authorized delivery.' }, outputEvidenceHash: { anyOf: [{ type: 'string', pattern: '^[a-f0-9]{64}$' }, { type: 'null' }] } }), 'Acknowledge this completion after reading its result. Use its exact outputEvidenceHash, including null when no output was observed. Consumption is not independent acceptance.'],
];
// Fulcra J3b: the inbox in this paired chat. Owner turns only (never a completion wake), and the owner-verified
// origin comes from the runtime context, never from these arguments.
const inboxTools = [
  ['inbox_pair', object({ code: { type: 'string', pattern: '^\\d{6}$' } }), 'Pair this conversation with the Fulcra inbox using the 6-digit code the owner sees in the Fulcra app.'],
  ['inbox_list', object({}), 'List what is waiting in the Fulcra inbox, numbered, plus any updates on items already shown. Show the text as it is.'],
  ['inbox_show', object({ n: { type: 'integer', minimum: 1, maximum: 50 } }), 'Show one inbox item by its number: a decision with its options, examples and recommendation. Held messages are only read in the Fulcra app.'],
  ['inbox_answer', object({ n: { type: 'integer', minimum: 1, maximum: 50 }, option: { anyOf: [{ type: 'integer', minimum: 1, maximum: 3 }, { type: 'string', minLength: 1, maxLength: 80 }] }, note: { type: 'string', maxLength: 500 }, confirm: { type: 'boolean' } }),
    'Answer a decision with the option the owner chose in this conversation. Only the owner\u2019s own message counts; never answer on their behalf. A hard-to-undo option needs confirm true on a second request after the owner confirms.'],
];
const plugin = defineToolPlugin({
  id: 'orca-ingress', name: 'Fulcra Ingress', description: 'Scoped access to existing Fulcra saved sessions.',
  configSchema: { ...object({ bindingsDir: { type: 'string' }, agentId: { type: 'string', minLength: 1 }, trustedOwnerSessionKey: { type: 'string', minLength: 1 }, completionWakes: { type: 'boolean' } }), required: ['bindingsDir', 'agentId'] },
  tools: tool => [...tools.map(([action, parameters, description]) => tool({
    name: `orca_ingress_${action}`, parameters, description,
    factory: ({ api, config, toolContext: context }) => ({
      name: `orca_ingress_${action}`, label: `Fulcra ${action}`, description, parameters, executionMode: 'sequential',
      async execute(toolCallId, args, signal) {
        let boundary = 'agent-context';
        try {
          if (context?.agentId !== config.agentId) throw Error('Wrong ingress agent');
          const runtime = activeRuntime(config); boundary = runtime ? 'host-call-permit' : 'no-active-service';
          const permit = runtime?.tickets.take(toolCallId, `orca_ingress_${action}`, args, context);
          if (!permit) { boundary = 'no-host-permit'; throw Error('Current host call permit required'); }
          const wake = permit.owner ? undefined : permit;
          boundary = wake ? 'scoped-relay' : 'owner-relay';
          const run = createRelay({ context, bindingsDir: config.bindingsDir, trustedOwnerSessionKey: config.trustedOwnerSessionKey, request, wake, checkCall: permit.check });
          const result = await run(action, args, toolCallId, signal);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch { api.logger?.warn?.(`Orca ${action} refused (${boundary})`); return { content: [{ type: 'text', text: 'Orca request refused or unavailable. Inspect current ownership and conversation binding; do not retry an assignment blindly.' }], isError: true }; }
      },
    }),
  })), ...inboxTools.map(([action, parameters, description]) => tool({
    name: `orca_ingress_${action}`, parameters, description,
    factory: ({ api, config, toolContext: context }) => ({
      name: `orca_ingress_${action}`, label: `Fulcra ${action.replace('_', ' ')}`, description, parameters, executionMode: 'sequential',
      async execute(toolCallId, args, signal) {
        try {
          if (context?.agentId !== config.agentId) throw Error('Wrong ingress agent');
          const permit = activeRuntime(config)?.tickets.take(toolCallId, `orca_ingress_${action}`, args, context);
          if (!permit?.owner) throw Error('Owner turn required');
          const run = createInboxRelay({ context, bindingsDir: config.bindingsDir, request });
          const result = await run(action.slice('inbox_'.length), args, signal);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (e) {
          api.logger?.warn?.(`Fulcra ${action} refused`);
          // Refusals are plain sentences for the owner ("Already answered on Mac at 09:14", "I can't confirm this came from you").
          return { content: [{ type: 'text', text: String(e.message).slice(0, 300) }], isError: true };
        }
      },
    }),
  }))],
});
const register = plugin.register;
plugin.register = api => {
  const hooks = api.config?.plugins?.entries?.['orca-ingress']?.hooks;
  if (hooks?.allowConversationAccess !== true || hooks.allowPromptInjection === false) throw Error('Ingress requires its native tool restriction hook grant');
  const runtime = createWakeRuntime(api), current = () => activeRuntime(api.pluginConfig);
  {
    api.registerService(sharedService(api.pluginConfig, runtime));
    api.on('agent_turn_prepare', (event, context) => current()?.tickets.prepare(event, context));
    api.on('before_agent_run', (event, context) => { if (context.agentId === api.pluginConfig.agentId) current()?.tickets.gate(event, context); });
    api.on('before_tool_call', (event, context) => current()?.tickets.before(event, context));
    api.on('agent_end', (_event, context) => current()?.tickets.clear(context.runId));
  }
  register(api);
  api.on('before_prompt_build', (_event, context) => context.agentId === api.pluginConfig.agentId ? { toolsAllow: current()?.tickets.available(context) ? [...tools, ...inboxTools].map(([action]) => `orca_ingress_${action}`) : [] } : undefined);
};
export default plugin;
