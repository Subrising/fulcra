import type { PluginManagementContextV11 } from "@getpaseo/plugin/server";

export class ManagementUnavailableError extends Error {
  readonly code: "management_unavailable";
}
export function withManagementInvocation<T>(
  context: unknown,
  readOnly: boolean,
  run: () => T | Promise<T>,
): Promise<T>;
export function invokeManagement(method: string, input?: unknown): Promise<any>;
export function isReadCommand(method: string): boolean;
export function invocationReadOnly(declared: boolean, context: unknown): boolean;

// The invocation admits an invoke-capable host context; legacy account/audit fields may be absent.
export function currentManagement():
  | (Pick<PluginManagementContextV11, "invoke"> & Partial<PluginManagementContextV11>)
  | undefined;
