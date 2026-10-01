import type { TrackerConnector } from './connector.mjs';
import type { TrackerView } from '../../shared/trackers';
export const COALESCE_MS: number;
export const LIMITS: Readonly<{ projects: number; items: number; links: number; singleFetches: number }>;
type Outcome = { ok: boolean; failure: TrackerView['projects'][number]['status'] | 'refused' | null; message: string | null };
export type TrackerService = {
  read(input: { projectId?: string; subjects?: string[] }): Promise<TrackerView>;
  directory(): Promise<any>;
  resolve(input: { tracker: 'github' | 'jira' | 'bitbucket'; auth: 'keychain' | 'gh-cli'; site: string; remoteName: string }): Promise<Outcome & { remoteId: string | null; remoteName: string | null }>;
  map(input: { projectId: string; tracker: 'github' | 'jira' | 'bitbucket'; auth: 'keychain' | 'gh-cli'; site: string; remoteName: string; confirmRemoteId: string; expectedRevision: number; note: string }): Promise<Outcome & { mapping: any }>;
  unmap(input: { projectId: string; expectedRevision: number; note: string }): Promise<Outcome & { mapping: any }>;
  link(input: { projectId: string; subject: { kind: 'session' | 'task'; id: string }; itemRef: string; expectedMappingRevision: number }): Promise<Outcome & { linkId: string | null; revision: number | null }>;
  unlink(input: { linkId: string; expectedRevision: number }): Promise<Outcome & { linkId: string | null; revision: number | null }>;
};
export function createTrackerService(ports: { controller: (method: string, input?: unknown) => Promise<any>; connectors: Partial<Record<'github' | 'jira' | 'bitbucket', TrackerConnector>>; now?: () => number }): TrackerService;
