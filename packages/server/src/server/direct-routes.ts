import os from "node:os";
import type { DirectRoute } from "@getpaseo/protocol/messages";

/** The wire list must stay small: a host with many virtual interfaces still gets its best routes first. */
export const MAX_DIRECT_ROUTES = 8;

type Interfaces = ReturnType<typeof os.networkInterfaces>;

/** Canonical decimal octets only: "010.0.0.1" and "0xa.0.0.1" are not addresses the URL parser reads the same way. */
const CANONICAL_OCTET = /^(0|[1-9]\d{0,2})$/;

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => CANONICAL_OCTET.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((n) => n <= 255) ? numbers : null;
}

/** Tailscale gives each device an address in 100.64.0.0/10 (CGNAT). */
export function isTailscaleIpv4(address: string): boolean {
  const p = ipv4Parts(address);
  return p !== null && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

export function isPrivateLanIpv4(address: string): boolean {
  const p = ipv4Parts(address);
  if (!p) return false;
  return (
    p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)
  );
}

function classify(address: string): DirectRoute["kind"] | null {
  if (isTailscaleIpv4(address)) return "tailscale";
  if (isPrivateLanIpv4(address)) return "lan";
  return null;
}

/**
 * The addresses a paired phone may try before the relay: Tailscale first, then LAN.
 * It lists only addresses the daemon already listens on, so it opens no new port.
 * A loopback-only daemon has no direct route. A daemon bound to one address lists just that one.
 */
export function listDirectRoutes(args: {
  listenHost: string | null;
  port: number | null;
  interfaces?: Interfaces;
  /** A configured list (see `resolveAdvertisedDirectRoutes`). When it holds a route, it replaces the auto list. */
  advertised?: readonly DirectRoute[];
}): DirectRoute[] {
  if (args.advertised && args.advertised.length > 0) return [...args.advertised];
  const { listenHost, port } = args;
  if (!listenHost || !port) return [];
  const wildcard = listenHost === "0.0.0.0" || listenHost === "::" || listenHost === "[::]";
  const found: string[] = [];
  if (wildcard) {
    const nets = args.interfaces ?? os.networkInterfaces();
    for (const name of Object.keys(nets).sort()) {
      for (const addr of nets[name] ?? []) {
        if (addr.family === "IPv4" && !addr.internal) found.push(addr.address);
      }
    }
  } else {
    found.push(listenHost);
  }
  const routes: DirectRoute[] = [];
  const seen = new Set<string>();
  for (const address of found) {
    const kind = classify(address);
    if (!kind || seen.has(address)) continue;
    seen.add(address);
    routes.push({ kind, endpoint: `${address}:${port}` });
  }
  const rank = (route: DirectRoute) => (route.kind === "tailscale" ? 0 : 1);
  return routes.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_DIRECT_ROUTES);
}

const TAILNET_HOSTNAME = /^(?=.{1,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/;

function advertisedKind(host: string): DirectRoute["kind"] | null {
  if (TAILNET_HOSTNAME.test(host)) return "tailscale";
  return classify(host);
}

/**
 * Checks the `daemon.directRoutes.advertise` setting. A host behind a proxy (for example `tailscale serve`)
 * listens on loopback, so the auto list is empty and the operator names the routes instead.
 * An entry must be a Tailscale or private LAN IPv4 address, or a `*.ts.net` name, with a port from 1 to 65535.
 * `tls` is optional; a `*.ts.net` name defaults to true.
 * It drops bad entries and repeats, keeps the first 8, and calls `warn` once if it dropped anything.
 * Entries never carry a password: they only name where to connect.
 */
export function resolveAdvertisedDirectRoutes(
  entries: ReadonlyArray<{ host?: unknown; port?: unknown; tls?: unknown }> | undefined,
  warn: (message: string, dropped: number) => void,
): DirectRoute[] {
  if (!entries || entries.length === 0) return [];
  const routes: DirectRoute[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of entries) {
    const host = typeof entry.host === "string" ? entry.host.trim().toLowerCase() : "";
    const port = entry.port;
    const kind = host ? advertisedKind(host) : null;
    const tlsValid = entry.tls === undefined || typeof entry.tls === "boolean";
    if (
      !kind ||
      !tlsValid ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      dropped++;
      continue;
    }
    const endpoint = `${host}:${port}`;
    if (seen.has(endpoint)) {
      dropped++;
      continue;
    }
    if (routes.length >= MAX_DIRECT_ROUTES) {
      dropped++;
      continue;
    }
    seen.add(endpoint);
    // A tailnet name is served over HTTPS by `tailscale serve`, so it defaults to TLS; an entry can say otherwise.
    const tls = entry.tls === undefined ? TAILNET_HOSTNAME.test(host) : entry.tls;
    routes.push(tls ? { kind, endpoint, tls: true } : { kind, endpoint });
  }
  if (dropped > 0) {
    warn(
      `Ignored ${dropped} directRoutes.advertise entries (need a Tailscale or private IPv4 address or a *.ts.net name, port 1-65535, no repeats, at most ${MAX_DIRECT_ROUTES})`,
      dropped,
    );
  }
  const rank = (route: DirectRoute) => (route.kind === "tailscale" ? 0 : 1);
  return routes.sort((a, b) => rank(a) - rank(b));
}
