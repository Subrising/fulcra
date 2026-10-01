import type { Http } from './service.mjs';
export const REQUEST_HEADERS: readonly string[];
export type HostRequest = (accountId: string, connector: string, input: { method: 'GET'; path: string; query?: Record<string, string | string[]>; headers?: Record<string, string> }) => Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
export function hostRefusal(error: unknown): Error & { failure: string; detail?: string };
export function statusFailure(status: number, headers: unknown): (Error & { failure: string }) | null;
export function accountHttp(options: { request: HostRequest | undefined; accountId: string | null; connector: string }): Http;
export function noHttp(kind?: string, detail?: string | null): Http;
