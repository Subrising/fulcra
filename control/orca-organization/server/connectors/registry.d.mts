export interface ConnectorDescription {
  id: string;
  label: string;
  kinds: string[];
  selfHosted: boolean;
  auth: string[];
  tokenHelp: { createUrl: string; scopes: string[]; note: string };
  keyPatterns: string[];
  sync: { pollSeconds: number; webhook: false };
}
export type ConnectorModule = ConnectorDescription & { [operation: string]: unknown };
export interface HostMethod {
  method: string;
  status: string;
}
export interface Registry {
  get(id: string): ConnectorModule | null;
  ids(): string[];
  describe(hostMethods?: Map<string, HostMethod[]> | null): ConnectorDescription[];
}
export function createRegistry(modules: ConnectorModule[]): Registry;
