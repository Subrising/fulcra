import type { Fetcher, SecretReader, GhRunner, TrackerConnector } from './connector.mjs';
export function ghArgs(path: string): string[];
export function assertGhArgs(args: unknown): string[];
export function createGithubConnector(ports: { fetcher: Fetcher; secrets: SecretReader; gh?: GhRunner }): TrackerConnector;
