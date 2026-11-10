import { describe, expect, it, vi } from "vitest";
import {
  listDirectRoutes,
  MAX_DIRECT_ROUTES,
  resolveAdvertisedDirectRoutes,
} from "./direct-routes.js";

type Nets = NonNullable<Parameters<typeof listDirectRoutes>[0]["interfaces"]>;
const v4 = (address: string, internal = false) => ({
  address,
  family: "IPv4" as const,
  internal,
  netmask: "255.255.255.0",
  mac: "00:00:00:00:00:00",
  cidr: null,
});

describe("listDirectRoutes", () => {
  it("lists Tailscale first, then LAN, for a wildcard daemon", () => {
    const interfaces = {
      en0: [v4("192.168.1.20")],
      utun4: [v4("100.101.102.103")],
      lo0: [v4("127.0.0.1", true)],
    } as unknown as Nets;
    expect(listDirectRoutes({ listenHost: "0.0.0.0", port: 6767, interfaces })).toEqual([
      { kind: "tailscale", endpoint: "100.101.102.103:6767" },
      { kind: "lan", endpoint: "192.168.1.20:6767" },
    ]);
  });
  it("has no Tailscale route when Tailscale is absent", () => {
    const interfaces = { en0: [v4("10.0.0.5")] } as unknown as Nets;
    expect(listDirectRoutes({ listenHost: "0.0.0.0", port: 1, interfaces })).toEqual([
      { kind: "lan", endpoint: "10.0.0.5:1" },
    ]);
  });
  it("skips public, loopback and non-private addresses", () => {
    const interfaces = {
      en0: [v4("8.8.8.8"), v4("172.32.0.1"), v4("100.63.0.1"), v4("100.128.0.1")],
    } as unknown as Nets;
    expect(listDirectRoutes({ listenHost: "::", port: 1, interfaces })).toEqual([]);
  });
  it("gives nothing for a loopback-only daemon or an unknown port", () => {
    expect(listDirectRoutes({ listenHost: "127.0.0.1", port: 6767 })).toEqual([]);
    expect(listDirectRoutes({ listenHost: "localhost", port: 6767 })).toEqual([]);
    expect(listDirectRoutes({ listenHost: "0.0.0.0", port: null })).toEqual([]);
    expect(listDirectRoutes({ listenHost: null, port: 6767 })).toEqual([]);
  });
  it("lists only the bound address when the daemon binds one address", () => {
    expect(listDirectRoutes({ listenHost: "100.64.0.9", port: 8 })).toEqual([
      { kind: "tailscale", endpoint: "100.64.0.9:8" },
    ]);
  });
  it("returns at most 8 routes, Tailscale first, for a host with many virtual interfaces (M1)", () => {
    const interfaces = {
      docker0: Array.from({ length: 9 }, (_, i) => v4(`172.17.${i}.1`)),
      en0: [v4("192.168.1.20"), v4("192.168.1.21")],
      utun9: [v4("100.101.102.103")],
    } as unknown as Nets;
    const routes = listDirectRoutes({ listenHost: "0.0.0.0", port: 6767, interfaces });
    expect(MAX_DIRECT_ROUTES).toBe(8);
    expect(routes).toHaveLength(8);
    expect(routes[0]).toEqual({ kind: "tailscale", endpoint: "100.101.102.103:6767" });
  });
});

describe("advertised direct routes", () => {
  it("a configured list replaces the auto list, even on a loopback daemon", () => {
    const advertised = resolveAdvertisedDirectRoutes(
      [
        { host: "mini.tail1234.ts.net", port: 443 },
        { host: "100.100.1.2", port: 6767 },
      ],
      () => undefined,
    );
    expect(advertised).toEqual([
      { kind: "tailscale", endpoint: "mini.tail1234.ts.net:443" },
      { kind: "tailscale", endpoint: "100.100.1.2:6767" },
    ]);
    expect(listDirectRoutes({ listenHost: "127.0.0.1", port: 6767, advertised })).toEqual(
      advertised,
    );
    const interfaces = { en0: [v4("192.168.1.20")] } as unknown as Nets;
    expect(listDirectRoutes({ listenHost: "0.0.0.0", port: 6767, interfaces, advertised })).toEqual(
      advertised,
    );
  });

  it("drops invalid entries with one warn and keeps valid ones", () => {
    const warn = vi.fn();
    const routes = resolveAdvertisedDirectRoutes(
      [
        { host: "8.8.8.8", port: 6767 },
        { host: "example.com", port: 6767 },
        { host: "evil.ts.net.example.com", port: 6767 },
        { host: "100.100.1.2", port: 0 },
        { host: "100.100.1.2", port: 65536 },
        { host: "100.100.1.2", port: 1.5 },
        { host: 5, port: 1 },
        { host: "192.168.1.9", port: 6767 },
        { host: "192.168.1.9", port: 6767 },
      ],
      warn,
    );
    expect(routes).toEqual([{ kind: "lan", endpoint: "192.168.1.9:6767" }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("empty or missing list gives no override, so the auto list stays", () => {
    const warn = vi.fn();
    expect(resolveAdvertisedDirectRoutes([], warn)).toEqual([]);
    expect(resolveAdvertisedDirectRoutes(undefined, warn)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    const interfaces = { en0: [v4("10.0.0.5")] } as unknown as Nets;
    expect(
      listDirectRoutes({ listenHost: "0.0.0.0", port: 1, interfaces, advertised: [] }),
    ).toEqual([{ kind: "lan", endpoint: "10.0.0.5:1" }]);
  });

  it("keeps at most 8 routes", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ host: `100.100.1.${i + 1}`, port: 1 }));
    const warn = vi.fn();
    expect(resolveAdvertisedDirectRoutes(many, warn)).toHaveLength(MAX_DIRECT_ROUTES);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
