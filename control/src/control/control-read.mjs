// The read-only side of talking to a running controller, extracted from role-state.mjs so a second
// operator report does not copy a socket client and, with it, the chance of quietly copying a write.
//
// The allowlist is a PARAMETER, not a constant here. Each tool declares the reads it makes, so
// role-state's guarantee -- "every method below is a pure read, nothing else may be added" -- stays that
// tool's own guarantee rather than becoming a shared list anyone can widen for someone else.
import fs from 'node:fs';
import net from 'node:net';
import { resolveSocketPath } from './socket-location.mjs';
import path from 'node:path';
import { controlHome as configuredHome } from './home.mjs';
import { portable } from '../portable-config.mjs';

export const controlHome = (env = process.env) => configuredHome(env);
export const operatorSecret = home => fs.readFileSync(path.join(home, 'operator.secret'), 'utf8');

export function reader({ home, reads, timeout = 10000, connect = net.createConnection }) {
  if (!Array.isArray(reads) || !reads.length) throw new Error('A reader must declare the reads it makes');
  // Refusal is synchronous and before the connection, so a method outside the allowlist cannot reach the
  // socket at all and cannot be lost as an unhandled rejection.
  return function ask(method, operator, input) {
    if (!reads.includes(method)) throw new Error(`this reader only makes read calls; ${method} is not one`);
    return new Promise(resolve => {
      let address;
      try { address = resolveSocketPath(home); } catch (error) { resolve({ __error: error.message }); return; }
      const client = connect(address);
      let bytes = ''; client.setEncoding('utf8');
      const done = v => { try { client.destroy(); } catch { /* closed */ } resolve(v); };
      client.setTimeout(timeout, () => done({ __error: 'timed out' }));
      client.on('error', e => done({ __error: e.message }));
      client.on('connect', () => client.write(JSON.stringify({ method, operator, ...(input === undefined ? {} : { input }) }) + '\n'));
      client.on('data', c => { bytes += c; });
      // Unwrap the {result} / {error} envelope here so callers read the payload directly. A result may
      // itself carry an `error` field (bindings-status returns lastError), so transport failure uses a
      // distinct key.
      client.on('end', () => {
        try { const v = JSON.parse(bytes); done(v.error !== undefined ? { __error: v.error } : (v.result ?? {})); }
        catch { done({ __error: 'unparseable response' }); }
      });
    });
  };
}
