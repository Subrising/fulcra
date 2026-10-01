export type Failure = 'auth-required' | 'forbidden' | 'not-found' | 'rate-limited' | 'offline' | 'invalid-response' | 'error';
export const FAILURES: readonly Failure[];
export const MAX_BODY: number; export const TIMEOUT_MS: number;
export class TrackerFailure extends Error { constructor(failure: Failure, retryAfterMs?: number | null); failure: Failure; retryAfterMs: number | null; }
export type Fetcher = (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'error'; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; body: AsyncIterable<Uint8Array> | null }>;
export function getJson(options: { fetcher: Fetcher; url: string; headers: Record<string, string>; etag?: string | null; now?: number }): Promise<{ status: 200; json: unknown; etag: string | null } | { status: 304 }>;
