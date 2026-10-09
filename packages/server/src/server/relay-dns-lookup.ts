import dns from "node:dns";
import type { LookupFunction } from "node:net";

// dns.lookup() runs getaddrinfo on the libuv thread pool (4 threads by default). When slow
// file-system work fills that pool, every relay handshake waits in the same queue and fails
// with "Opening handshake has timed out" until the daemon restarts. dns.Resolver queries
// the network through c-ares on the event loop, so relay sockets keep connecting while the
// pool is busy. A fresh Resolver per lookup also means no resolver state survives a failure.
const RESOLVER_TIMEOUT_MS = 3_000;
const RESOLVER_TRIES = 2;

type ResolveCallback = (error: NodeJS.ErrnoException | null, addresses: string[]) => void;

export interface RelayDnsResolver {
  resolve4(hostname: string, callback: ResolveCallback): void;
  resolve6(hostname: string, callback: ResolveCallback): void;
}

export interface RelayDnsLookupOptions {
  createResolver?: () => RelayDnsResolver;
  fallbackLookup?: LookupFunction;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

function createDefaultResolver(): RelayDnsResolver {
  return new dns.Resolver({ timeout: RESOLVER_TIMEOUT_MS, tries: RESOLVER_TRIES });
}

function requestedFamily(options: dns.LookupOptions | number | undefined): 0 | 4 | 6 {
  const family = typeof options === "number" ? options : options?.family;
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return 0;
}

export function createRelayDnsLookup(options: RelayDnsLookupOptions = {}): LookupFunction {
  const createResolver = options.createResolver ?? createDefaultResolver;
  const fallbackLookup = options.fallbackLookup ?? (dns.lookup as LookupFunction);

  return (hostname, lookupOptions, callback) => {
    const family = requestedFamily(lookupOptions);
    const resolver = createResolver();
    // IPv4 first: a host without an IPv6 route fails fast on IPv6 and then waits on IPv4.
    const families: Array<4 | 6> = family === 0 ? [4, 6] : [family];
    const results: ResolvedAddress[][] = families.map(() => []);
    let pending = families.length;

    const finish = () => {
      const addresses = results.flat();
      if (addresses.length === 0) {
        // Names that DNS does not answer (localhost, /etc/hosts entries) still resolve.
        fallbackLookup(hostname, lookupOptions, callback);
        return;
      }
      if (lookupOptions.all) {
        callback(null, addresses);
        return;
      }
      callback(null, addresses[0].address, addresses[0].family);
    };

    families.forEach((queryFamily, index) => {
      const onResolved: ResolveCallback = (error, addresses) => {
        if (!error) results[index] = addresses.map((address) => ({ address, family: queryFamily }));
        pending -= 1;
        if (pending === 0) finish();
      };
      if (queryFamily === 4) resolver.resolve4(hostname, onResolved);
      else resolver.resolve6(hostname, onResolved);
    });
  };
}
