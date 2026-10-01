// Wiring-only doubles. Authority, socket and native behavior have separate real implementation tests.
import { createSnapshotReader } from './organization';
import { singleFlight, taskPage, createUsageReader } from './tasks';
export { createSnapshotReader, singleFlight, taskPage, createUsageReader };
export const state = { auth: true, tasks: [], rows: [], snapshots: [], lists: [], reads: [], fleetReads: 0, projectReads: 0, recoveryReads: 0, recoveryCalls: [], authority: true, retained: false, hang: false, agents: [], agentReads: [], controllerReads: [] };
export function reset() { Object.assign(state, { auth: true, tasks: [], rows: [], snapshots: [], lists: [], reads: [], fleetReads: 0, projectReads: 0, recoveryReads: 0, recoveryCalls: [], authority: true, retained: false, hang: false, agents: [], agentReads: [], controllerReads: [] }); }
const never = () => new Promise(() => {});
export async function readFleet() { if (state.hang) return never(); state.fleetReads++; await new Promise(resolve=>setTimeout(resolve,5)); return { observedAt:new Date().toISOString() }; }
export async function readActivity() { return {}; }
export function readFleetHosts() { return { local: "Desk", hosts: [{ name: "Desk", serverId: null }] }; }
// J4: the host's agent list (session names for the Trackers trail). Records which host handle and bound it was read
// with, and answers from state.agents, like readFleet.
export async function listAgents(paseo, ms) { if (state.hang) return never(); state.agentReads.push({ paseo, ms }); await new Promise(resolve => setTimeout(resolve, 5)); return { entries: state.agents.map(agent => ({ agent })), complete: true }; }
export async function enrollment(call) { return call('list'); }
export function bounded(work) { return work; }
export function assertManagementAuthentication() { if (!state.auth) throw Error('Authentication unavailable'); }
export function createManagement() { return async command => state.hang ? never() : ({ legacy: true, command }); }
export function createTaskManagement() { return async input => { state.lists.push(input); return { status: 'observed', taskAuthority: { allowed: state.authority }, sessions: state.retained ? [{}] : [], taskId: input.taskId, command: input.command }; }; }
export async function localCall(method, input) {
  // DESIGN-R R2: the Recovery routes reach the controller through this same double.
  if (method === 'recovery-status' && state.hang) return never();
  if (method === 'recovery-status') { state.recoveryReads++; await new Promise(resolve => setTimeout(resolve, 5)); return { items: [], unsettled: [], note: 'Wiring fixture' }; }
  if (method === 'session-interruption-dismiss') { state.recoveryCalls.push({ method, input }); return { state: 'dismissed' }; }
  // J4 Trackers reads, answered empty: a project with nothing mapped yet.
  const empty = { 'cc-tracker-legacy-pending': { pending: [] }, 'cc-tracker-mappings': { mappings: [] }, 'cc-tracker-items': { items: [] }, 'cc-links-for': { links: [] }, 'trackers-directory': { projects: [] } };
  if (Object.hasOwn(empty, method)) { state.controllerReads.push(method); return empty[method]; }
  if (method !== 'list') throw Error('Unexpected controller operation'); return state.rows;
}
export async function readTaskCatalog() { return { tasks: state.tasks, observedAt: new Date().toISOString(), available: true, partial: false, note: 'Wiring fixture' }; }
export async function readBoard(_request, id) { state.reads.push(id); return { id }; }
export async function organizationSnapshot(paseo, board, membership) { const result = { paseo, board: await board(), members: membership ? [...membership] : null }; state.snapshots.push(result); return result; }

export async function readProjects() { if (state.hang) return never(); state.projectReads++; await new Promise(resolve=>setTimeout(resolve,5)); return { observedAt:new Date().toISOString(), projects:[] }; }
