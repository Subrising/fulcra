import os from "node:os";
import type { DirectRoute } from "@getpaseo/protocol/messages";

type Interfaces = ReturnType<typeof os.networkInterfaces>;

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
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
}): DirectRoute[] {
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
  return routes.sort((a, b) => rank(a) - rank(b));
}
