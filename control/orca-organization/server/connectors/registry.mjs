// Fulcra J4 connector registry (CONTRACTS.md §7.1). A new tracker is one module that passes this check;
// nothing else in the core changes. Each module is validated once, at registration, so a module missing
// token sign-in (required for every connector) or an operation never reaches a screen.
import { connectorProblem } from '../../shared/cc/connector-rules.mjs';
export function createRegistry(modules) {
  const byId = new Map();
  for (const c of modules) {
    const problem = connectorProblem(c);
    if (problem) throw new Error(`Connector ${typeof c?.id === 'string' ? c.id : '?'} is invalid: ${problem}`);
    if (byId.has(c.id)) throw new Error(`Connector ${c.id} is registered twice`);
    byId.set(c.id, c);
  }
  return {
    get: id => byId.get(id) ?? null,
    ids: () => [...byId.keys()],
    // What the Integrations screen may offer. `token` always; `cli` where the connector has one; `device` and
    // `browser` only when the host says they work without a server-held secret (J5b: browser sign-in needs a
    // broker for every v1 cloud provider, so it stays hidden until the host reports it available).
    describe(hostMethods = null) {
      return [...byId.values()].map(c => {
        const host = hostMethods?.get(c.id) ?? null;
        const shown = c.auth.filter(m => m === 'token' || m === 'cli' || host?.some(h => h.method === m && h.status === 'available'));
        return { id: c.id, label: c.label, kinds: [...c.kinds], selfHosted: c.selfHosted, auth: shown, tokenHelp: { ...c.tokenHelp, scopes: [...c.tokenHelp.scopes] }, keyPatterns: [...c.keyPatterns], sync: { ...c.sync } };
      });
    },
  };
}
