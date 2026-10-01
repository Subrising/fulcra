import type { Registry } from './registry.mjs';
import type { ScanResult } from './provenance.mjs';
type Mapping = { id: string; revision: number; projectId: string; connector: string; accountId: string | null; remoteId: string; remoteName: string; site: string | null; state: string };
// What a connector is handed (http.mjs): a GET bound to one account, or the gh login. Never a token or a header.
export type Http = { kind: 'account' | 'cli' | 'none'; get(path: string, query?: Record<string, string | string[]>, headers?: Record<string, string>): Promise<unknown> };
export const SCAN_EVERY_MS: number;
export const LINK_FETCHES_PER_REFRESH: number;
export function messageFor(failure: string): string;
export function trail(item: unknown, links: unknown[], byKey: Map<string, unknown>, who: { sessions: Map<string, string>; tasks: Map<string, string> }): unknown[];
export function createConnectorService(options: {
  controller: (method: string, input?: unknown) => Promise<any>;
  registry: Registry;
  http: (mapping: Pick<Mapping, 'connector' | 'accountId'>) => Http | null;
  hostAccounts?: () => Promise<{ hostApi: boolean; accounts: any[]; providers: Array<{ connector: string; methods: Array<{ method: string; status: string }> }> }>;
  importLegacy?: ((input: { secretName: string; connector: string; site: string | null; email?: string | null }) => Promise<{ accountId: string }>) | null;
  scan?: ((projectId: string, mappings: Mapping[]) => Promise<ScanResult | null>) | null;
  names?: () => Promise<{ sessions: Map<string, string>; tasks: Map<string, string> }>;
  now?: () => number;
}): {
  view(input: { projectId: string }, options?: { persist?: boolean }): Promise<any>;
  integrations(): Promise<any>;
  mappings(input: { projectId: string }, options?: { persist?: boolean }): Promise<any>;
  resolve(input: { connector: string; accountId: string | null; remoteName: string; site: string | null }): Promise<any>;
  map(input: any): Promise<any>;
  unmap(input: any): Promise<any>;
  linkSet(input: any): Promise<any>;
  linkRemove(input: any): Promise<any>;
  links(input: { refs: string[] }): Promise<any>;
  scanProject(projectId: string): Promise<unknown>;
  migrate(): Promise<void>;
};
