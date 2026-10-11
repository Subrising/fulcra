export class AskError extends Error {
  code: string;
}
export function killProcessTree(
  child: { pid?: number; kill(signal?: string): unknown },
  o?: { platform?: string; run?: (...args: any[]) => any },
): void;
export function refuseShellShim(command: string): void;
export const MAX_ASK_TIMEOUT_MS: number;
export const DEFAULT_ASK_TIMEOUT_MS: number;
export const RATE_LIMIT_HOLD_MS: number;
export function spawnClaudeOnce(o: {
  token: string;
  model: string;
  prompt: string;
  schema?: unknown;
  timeoutMs: number;
  bin?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<any>;
export function askOnce(o: {
  root: string;
  keychain: { get(id: string): Promise<string | null> };
  input: {
    prompt: string;
    model: string;
    schema?: unknown;
    account?: string | null;
    timeoutMs?: number;
  };
  spawnClaude?: (o: any) => Promise<any>;
  now?: () => number;
}): Promise<{ output: unknown; account: string; model: string; costUsd: number | null }>;
