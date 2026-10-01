export const SCAN_DAYS: number;
export const MAX_COMMITS: number;
export const LOG_FORMAT: string;
export const gitCommands: { toplevel(): string[]; branch(): string[]; origin(): string[]; log(): string[]; unique(branch: string): string[] };
export function assertGitArgs(dir: string, args: string[]): string[];
export function gitEnvironment(env?: Record<string, string | undefined>): Record<string, string>;
export type GitRunner = (dir: string, args: string[]) => Promise<string | null>;
export function createGitRunner(options?: { binary?: string; run?: unknown }): GitRunner;
export function parseLog(stdout: unknown): Array<{ sha: string; at: string; subject: string; sessions: string[]; tasks: string[] }>;
