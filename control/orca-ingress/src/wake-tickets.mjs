import { createHash } from 'node:crypto';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Fulcra J3b inbox tools: owner turns only, never a completion wake.
export const INBOX_TOOLS = Object.freeze(['orca_ingress_inbox_pair', 'orca_ingress_inbox_list', 'orca_ingress_inbox_show', 'orca_ingress_inbox_answer']);
const sameSession = (a, b) => ['agentId', 'sessionKey', 'sessionId'].every(k => a[k] === b[k]);
// Host-hook metadata, never model-provided arguments, selects the pending completion.
export class WakeTickets {
  constructor({ agentId, validate, completionWakes = true, now = Date.now }) { Object.assign(this, { agentId, validate, completionWakes, now }); this.runs = new Map(); this.calls = new Map(); }
  clear(runId) { this.runs.delete(runId); for (const [id, call] of this.calls) if (call.runId === runId) this.calls.delete(id); }
  prune() { for (const [id, run] of this.runs) if (this.now() >= run.expires) this.clear(id); }
  async prepare(event, context) {
    this.prune();
    if (!uuid(context.runId) || context.agentId !== this.agentId || !uuid(context.sessionId) || typeof context.sessionKey !== 'string') return;
    // An owner turn or another run in this conversation invalidates retained wake tickets.
    for (const [id, run] of this.runs) if (sameSession(run.context, context)) this.clear(id);
    if (context.trigger === 'user' && ![context.channel, context.channelId].includes('internal') && (event.queuedInjections ?? []).length === 0 && this.runs.size < 32) {
      this.runs.set(context.runId, { context: { ...context }, owner: true, expires: this.now() + 14400000, ready: true, seen: new Set() }); return;
    }
    if (!this.completionWakes || context.trigger !== 'heartbeat' || context.channelId !== 'heartbeat' || context.senderId || context.channel || this.runs.size >= 32) return;
    const injections = (event.queuedInjections ?? []).filter(i => i.pluginId === 'orca-ingress' && uuid(i.metadata?.notificationId));
    if (injections.length !== 1) return;
    const candidate = { context: { ...context }, notificationId: injections[0].metadata.notificationId, expires: this.now() + 180000, ready: false, seen: new Set() };
    this.runs.set(context.runId, candidate);
    try {
      const binding = await this.validate(injections[0], context);
      if (this.runs.get(context.runId) !== candidate || this.now() >= candidate.expires) return;
      candidate.binding = binding; candidate.ready = true;
    } catch { if (this.runs.get(context.runId) === candidate) this.clear(context.runId); }
  }
  gate(event, context) {
    this.prune(); const run = this.runs.get(context.runId);
    if (!run?.ready || !sameSession(run.context, context)) return false;
    if (!run.owner) return true;
    // Only the pinned host exports current provenance; absence never means external input.
    const input = event.orcaInputProvenance;
    if (input?.version !== 1 || input.kind !== 'external_user' || input.sourceChannel !== 'orca' || input.sourceTool !== 'orca_operator' || event.senderIsOwner !== true || typeof event.prompt !== 'string' || !event.prompt.trim() || event.prompt.includes('[Inter-session message]') ||
        ['trigger', 'channel', 'channelId', 'senderId'].some(k => (context[k] ?? null) !== (run.context[k] ?? null)) ||
        (event.senderId ?? null) !== (context.senderId ?? null) || (event.channelId ?? null) !== (context.channelId ?? null)) { this.clear(context.runId); return false; }
    run.gated = true; return true;
  }
  before(event, context) {
    this.prune(); const run = this.runs.get(context.runId);
    if (!run?.ready || (run.owner && !run.gated) || !sameSession(run.context, context) || event.runId !== context.runId || event.toolCallId !== context.toolCallId || event.toolName !== context.toolName || typeof context.toolCallId !== 'string' || !/^mcp-[a-f0-9-]{36}$/.test(context.toolCallId) || context.abortSignal?.aborted || (!run.owner && context.requester && Object.keys(context.requester).length > 0) || this.calls.size >= 128) return;
    if (!['orca_ingress_status', 'orca_ingress_result', 'orca_ingress_assign', 'orca_ingress_ack'].includes(event.toolName) && !(run.owner && INBOX_TOOLS.includes(event.toolName))) return;
    if (run.seen.has(context.toolCallId)) { this.calls.delete(context.toolCallId); return; }
    if (run.seen.size >= 128) return; run.seen.add(context.toolCallId);
    this.calls.set(context.toolCallId, { runId: context.runId, run, tool: event.toolName, args: digest(event.params), signal: context.abortSignal });
  }
  available(context) { this.prune(); const run = this.runs.get(context.runId); return !!run?.ready && sameSession(run.context, context) && run.context.trigger === context.trigger; }
  take(toolCallId, tool, args, context) {
    this.prune(); const call = this.calls.get(toolCallId); this.calls.delete(toolCallId);
    if (!call || call.tool !== tool || call.args !== digest(args) || !sameSession(call.run.context, context)) return;
    const check = () => { if (this.runs.get(call.runId) !== call.run || !call.run.ready || this.now() >= call.run.expires || call.signal?.aborted) throw Object.assign(Error('Host call run is no longer active'), { code: 'ORCA_HOST_CALL_ENDED' }); };
    if (call.run.owner) {
      const c = call.run.context;
      if ([context.messageChannel, context.nativeChannelId].includes('internal') || context.senderIsOwner !== true || (c.senderId ?? null) !== (context.requesterSenderId ?? null) ||
          (c.channel && c.channel !== 'webchat' ? c.channel !== context.messageChannel || c.channelId !== context.nativeChannelId : (context.messageChannel ?? null) !== (c.channel ?? null) || context.nativeChannelId || c.channelId && c.channelId !== 'webchat')) return;
      check(); return { owner: true, check };
    }
    check(); return { notificationId: call.run.notificationId, binding: call.run.binding, check };
  }
}
