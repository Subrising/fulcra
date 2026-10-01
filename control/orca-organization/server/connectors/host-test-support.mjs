// Fulcra J4 test port: a fake of the host's `server.credentials.request` (J5b credential-request.ts, CONTRACTS §7.2
// v1.7/v1.10). It behaves like the host: the grant check, the safe-path rules, the provider's API base and allowed
// path prefixes, the header allow-list, per-account state and the host's own refusal sentences. The host keeps the
// account secret to itself, as the real one does: nothing a plugin receives or sends carries it, and tests assert so.
// No test reaches the network.
export const HOST_SECRET = 'CANARY-host-held-' + 'q'.repeat(24);
// Per provider, as J5b's providers.ts at the tested host revision. `devStatus` adds the v1.10 Jira read-only paths
// the contract allows and this host does not serve yet.
export const PROVIDERS = {
  github: { base: () => 'https://api.github.com', prefixes: ['/'] },
  jira: { base: site => `https://${site}`, prefixes: ['/rest/api/'] },
  'jira-dc': { base: site => `https://${site}`, prefixes: ['/rest/api/'] },
  bitbucket: { base: () => 'https://api.bitbucket.org', prefixes: ['/2.0/'] },
  'bitbucket-dc': { base: site => `https://${site}`, prefixes: ['/rest/'] },
};
const ALLOWED_HEADERS = new Set(['accept', 'content-type', 'if-none-match', 'if-modified-since', 'x-github-api-version', 'x-atlassian-token']);
export const reply = (status, body, headers = {}) => ({ status, body, headers });
// accounts: { [accountId]: { connector, site?, state? } }. routes: { [full url]: reply | (call, n) => reply | { throw } }.
export function fakeHost({ accounts, routes = {}, grants = Object.keys(PROVIDERS), devStatus = false } = {}) {
  const calls = [];
  async function request(accountId, connectorId, input) {
    calls.push({ accountId, connectorId, input: structuredClone(input) });
    if (!grants.includes(connectorId)) throw new Error(`This plugin did not declare "${connectorId}" in requirements.credentials`);
    const account = accounts[accountId];
    if (!account || account.connector !== connectorId) throw new Error(`No ${connectorId} account with that id`);
    if (account.state === 'revoked') throw new Error('This account is being disconnected');
    if (account.state && account.state !== 'connected') throw new Error('This account needs to be reconnected in Settings › Integrations');
    if (input.method !== 'GET') throw new Error('This plugin did not declare credentialsWrite');
    const path = input.path;
    if (typeof path !== 'string' || !path.startsWith('/') || /\/\/|\\|[?#@\s]/.test(path) || /%2e|%2f|%5c/i.test(path) || path.split('/').some(s => s === '.' || s === '..')) throw new Error('That path is not allowed');
    const provider = PROVIDERS[connectorId], prefixes = connectorId.startsWith('jira') && devStatus ? [...provider.prefixes, '/rest/dev-status/', '/rest/agile/1.0/'] : provider.prefixes;
    if (!prefixes.some(p => path.startsWith(p))) throw new Error(`Requests for this account must start with ${prefixes.join(' or ')}`);
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (!ALLOWED_HEADERS.has(name.toLowerCase())) throw new Error(`The ${name} header is set by the host, not by plugins`);
      if (String(value).includes(HOST_SECRET)) throw new Error('unreachable: a plugin cannot know the secret');
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(input.query ?? {})) for (const one of Array.isArray(v) ? v : [v]) qs.append(k, String(one));
    // Routes are written readable: looked up by the decoded URL.
    const url = decodeURIComponent(`${provider.base(account.site ?? null)}${path}${qs.size ? `?${qs}` : ''}`.replace(/\+/g, ' '));
    // The host would add `Authorization` here, from its own store. The plugin never sees it.
    const route = routes[url];
    const r = typeof route === 'function' ? route(input, calls.filter(c => c.url === url).length) : route;
    calls[calls.length - 1].url = url;
    if (r?.throw) throw new Error(r.throw);
    return r ?? reply(404, { message: 'Not Found' });
  }
  return { request, calls };
}
// The plugin-side proof: no call carried an auth header or the host's secret, and no answer returned it.
export function assertNoCredentialLeak(assert, host, ...values) {
  for (const c of host.calls) {
    const sent = JSON.stringify(c.input);
    assert.equal(sent.includes(HOST_SECRET), false);
    assert.ok(Object.keys(c.input.headers ?? {}).every(h => !/^(authorization|cookie|proxy-authorization|host)$/i.test(h)), `no auth header in ${sent}`);
    assert.equal(c.input.method, 'GET');
  }
  assert.equal(JSON.stringify(values).includes(HOST_SECRET), false);
}
