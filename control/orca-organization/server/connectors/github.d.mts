import type { ConnectorModule } from './registry.mjs';
export const CLOSED_WINDOW_DAYS: number;
export function assertPath(path: string): string;
export function ghArgs(path: string): string[];
export function assertGhArgs(args: string[]): string[];
export function closingNumbers(text: unknown): string[];
export function createGithubConnector(options?: { now?: () => number }): ConnectorModule;
export function createGhHttp(gh: ((args: string[]) => Promise<string>) | undefined): import('./service.mjs').Http;
