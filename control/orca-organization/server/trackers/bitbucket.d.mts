import type { Fetcher, SecretReader, TrackerConnector } from './connector.mjs';
export function createBitbucketConnector(ports: { fetcher: Fetcher; secrets: SecretReader }): TrackerConnector;
