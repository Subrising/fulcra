import type { Registry } from './registry.mjs';
import type { GitRunner } from './git.mjs';
export type ProposedLink = { from: string; relation: string; to: string; provenance: 'reported' | 'inferred'; confidence: 'high' | 'medium' | 'low'; evidence: string };
export type Producer = { ref: string; provenance: string; confidence: string; evidence?: string };
export type ScanResult = { links: ProposedLink[]; producersByCommit: Map<string, Producer[]>; repositories: number };
export const WINDOW_SLACK_MS: number;
export function scanProject(input: {
  projectId: string; sessions: Array<{ id: string; task: string; cwd: string }>; knownSessions: Set<string>; knownTasks: Set<string>;
  windows?: Map<string, { from: number; to: number }>; mappings?: Array<{ connector: string; remoteId: string; remoteName: string; site: string | null }>;
  registry: Registry; git: GitRunner; fs: unknown;
}): Promise<ScanResult>;
export function chainLinks(itemKey: string, providerCommits: string[], producersByCommit: Map<string, Producer[]>): ProposedLink[];
