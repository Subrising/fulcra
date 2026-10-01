import { fileURLToPath } from 'node:url';
// OpenClaw can cold-load tool registrations separately from its active service.
// Only a started service owns tickets; discovery registrations hold no authority.
const registry = globalThis[Symbol.for('orca-ingress.active-completion-services.v1')] ??= new Map();
const source = fileURLToPath(import.meta.url);
const key = config => JSON.stringify([source, config.bindingsDir, config.agentId, config.trustedOwnerSessionKey ?? null, config.completionWakes === true]);
export function activeRuntime(config) { const lease = registry.get(key(config)); return lease?.ready ? lease.runtime : undefined; }
export function sharedService(config, runtime) {
  const scope = key(config); let lease, starting = false, stopping;
  const stop = async () => {
    if (registry.get(scope) === lease) registry.delete(scope); if (lease) lease.ready = false;
    if (stopping) return await stopping;
    const pending = Promise.resolve().then(() => runtime.service.stop()); stopping = pending;
    try { await pending; } finally { if (stopping === pending) stopping = undefined; }
  };
  return { id: runtime.service.id,
    async start(context) {
      if (starting || stopping || registry.has(scope) || registry.size >= 32) throw Error('Completion service scope already active, starting, stopping or saturated');
      starting = true; lease = { runtime, ready: false };
      registry.set(scope, lease);
      try { await runtime.service.start(context); if (registry.get(scope) !== lease) throw Error('Completion service stopped during start'); lease.ready = true; }
      catch (error) { await stop(); throw error; }
      finally { starting = false; }
    },
    stop,
  };
}
