import { AsyncLocalStorage } from 'node:async_hooks';
import { parseControllerCommand, READ_METHODS } from '../shared/command-parser.mjs';
const invocations = new AsyncLocalStorage();
export class ManagementUnavailableError extends Error {
  constructor() { super('Management unavailable'); this.name = 'ManagementUnavailableError'; this.code = 'management_unavailable'; }
}
export function withManagementInvocation(context, readOnly, run) {
  if (typeof context?.management?.invoke !== 'function') throw new ManagementUnavailableError();
  const invocation = { management: context?.management, readOnly, active: true };
  return invocations.run(invocation, async () => { try { return await run(); } finally { invocation.active = false; invocation.management = undefined; } });
}
export function invokeManagement(method, input) {
  const invocation = invocations.getStore();
  if (!invocation?.active || (invocation.readOnly && !READ_METHODS.includes(method)) || typeof invocation.management?.invoke !== 'function') throw new ManagementUnavailableError();
  const command = parseControllerCommand({ method, ...(input === undefined ? {} : { input }) });
  // The host envelope requires an explicit JSON input, including for argument-free reads.
  return invocation.management.invoke({ ...command, input: command.input === undefined ? null : command.input });
}
export const isReadCommand = method => READ_METHODS.includes(method);
// U7 accounts.manage: the host's management context for the live invocation (principal, readOnly, accountsManage,
// recordAccountAction), or undefined outside one. Read-only: nothing here widens what the invocation may do.
export function currentManagement() { const invocation = invocations.getStore(); return invocation?.active ? invocation.management : undefined; }
// D13 (reviewer B3, defence in depth): an invocation is read-only when the method is declared a read, or when the host
// opened its management for a read-only device -- then this plugin refuses every non-read command itself, before the
// host's own refusal.
export const invocationReadOnly = (declared, context) => declared === true || context?.management?.readOnly === true;
