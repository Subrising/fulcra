import type { Fetcher, SecretReader, TrackerConnector } from './connector.mjs';
export function authorization(value: string): string;
export function openJql(projectId: string): string;
export function createJiraConnector(ports: { fetcher: Fetcher; secrets: SecretReader }): TrackerConnector;
