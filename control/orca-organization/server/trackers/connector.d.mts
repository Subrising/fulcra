import type { Fetcher } from './http.mjs';
import type { Tracker, TrackerAuth } from '../../shared/tracker-refs.mjs';
export type Mapping = { projectId: string; tracker: Tracker; auth: TrackerAuth; site: string; remoteId: string; remoteName: string; state: 'mapped' | 'unmapped'; revision: number };
export type TrackerItem = { ref: string; title: string; state: 'open' | 'closed' | 'unknown'; labels: string[]; updatedAt: string | null };
export type SecretReader = { read(name: string): Promise<string | null> };
export type GhRunner = (args: string[]) => Promise<string>;
export interface TrackerConnector {
  readonly tracker: Tracker;
  resolve(input: { auth: TrackerAuth; site: string; remoteName: string }): Promise<{ remoteId: string; remoteName: string }>;
  validate(mapping: Mapping): Promise<{ remoteName: string }>;
  listOpen(mapping: Mapping, options?: { etag?: string | null; observedName?: string | null }): Promise<{ items: TrackerItem[]; partial: boolean; etag: string | null } | { notModified: true }>;
  get(mapping: Mapping, itemRef: string, options?: { observedName?: string | null }): Promise<TrackerItem>;
}
export type { Fetcher };
