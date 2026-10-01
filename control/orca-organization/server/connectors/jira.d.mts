import type { ConnectorModule } from './registry.mjs';
export const CLOSED_WINDOW_DAYS: number;
export function jql(projectId: string, states?: string[]): string;
export function createJiraConnector(options?: { id?: 'jira' | 'jira-dc' }): ConnectorModule;
