import { localMachine } from "../../src/local-machine.mjs";
// Cutover A2: controller WRITES from the OpenClaw-authorised conversation client, through the daemon's authenticated
// management channel -- the orca-organization plugin RPC `organization.operator-invoke` inside an admitted daemon session.
// There is no raw write socket and no operator-write lane: when this route is selected, writes never go to the controller
// socket, not even as a fallback. Reads stay on the controller-client.mjs read lane.
//
// Trust boundary: the caller becomes a management-channel caller. It authenticates with the daemon owner credential
// (PASEO_HOME's controller credential), read per call exactly as orca-conversation/hosts.mjs already reads it for the Mini
// host probe, so the program's reach does not widen. The host admits the session, attaches its principal to that socket,
// and gives the plugin a per-call management context; the controller re-validates and journals each call.
//
// One connection per call, reconnection disabled, nothing cached. A failure before the request is sent is definite ("not
// sent"); once sent, a lost connection or deadline is UNCERTAIN: never retried here, and the caller must not replay it.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OPERATOR_INVOKE_METHODS, OPERATOR_INVOKE_RPC } from '../../orca-organization/shared/operator-invoke-methods.mjs';
export const PLUGIN_ID = 'orca-organization-next';
export const PASEO_HOME = localMachine("paseoHome");
const SDK = localMachine("daemonClientSdk");
// Selected explicitly at the cutover window (W1-PROCEDURES F9): ORCA_CONTROLLER_TOPOLOGY=owned-child selects this write route
// and the owned-daemon activation check (orca-conversation/mini-activation.mjs). Unset: today's behaviour (legacy operator lane).
export const ownedChild = (env = process.env) => env.ORCA_CONTROLLER_TOPOLOGY === 'owned-child';
export const managementWrites = ownedChild;
export function ownerCredential(file = path.join(PASEO_HOME, ['controller', 'secret'].join('.'))) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('Invalid native credential');
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw Error('Invalid native credential');
  return value;
}
export async function connectOwnedDaemon({ url = 'ws://127.0.0.1:6791/ws', credential = ownerCredential, sdk = SDK } = {}) {
  const { DaemonClient } = await import(sdk);
  const client = new DaemonClient({ url, password: credential(), clientId: 'orca-conversation-' + randomUUID(), clientType: 'cli', connectTimeoutMs: 10000, reconnect: { enabled: false } });
  try { await client.connect(); } catch (error) { await Promise.resolve(client.close()).catch(() => {}); throw error; }
  return { invoke: (method, input) => client.invokePluginRpc(PLUGIN_ID, method, input), close: () => client.close() };
}
const uncertain = (method, cause) => Object.assign(new Error(`Management outcome uncertain for ${method}; inspect before issuing another instruction. Do not replay.`),
  { code: 'uncertain', dispatched: true, doNotReplay: true, cause });
const deadline = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Management reply deadline passed')), ms); timer.unref?.();
  promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
});
export function managementWriter({ connect = connectOwnedDaemon, deadlineMs = 45000 } = {}) {
  return async function write(method, input) {
    if (!OPERATOR_INVOKE_METHODS.includes(method)) throw Object.assign(Error(`Method ${method} is not allowed on the management route`), { code: 'not_allowed', dispatched: false });
    let session;
    try { session = await connect(); }
    catch (error) { throw Object.assign(Error('Management channel unavailable; nothing was sent: ' + String(error?.message ?? error).slice(0, 300)), { code: 'unavailable', dispatched: false }); }
    let reply;
    try { reply = await deadline(Promise.resolve().then(() => session.invoke(OPERATOR_INVOKE_RPC, input === undefined ? { method } : { method, input })), deadlineMs); }
    catch (error) { throw uncertain(method, error); }
    finally { await Promise.resolve().then(() => session.close()).catch(() => {}); }
    if (reply?.ok === true && Object.hasOwn(reply, 'result')) return reply.result;
    if (reply?.ok === false && reply.dispatched === false && typeof reply.code === 'string') throw Object.assign(Error(String(reply.message).slice(0, 2000)), { code: reply.code, dispatched: false });
    throw uncertain(method, reply);
  };
}
