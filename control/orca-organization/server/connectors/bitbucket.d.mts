import type { ConnectorModule } from "./registry.mjs";
export const CLOSED_WINDOW_DAYS: number;
export function createBitbucketConnector(options?: {
  id?: "bitbucket" | "bitbucket-dc";
  now?: () => number;
}): ConnectorModule;
