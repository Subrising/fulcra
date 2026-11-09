import { describe, expect, it } from "vitest";
import { listDirectRoutes } from "./direct-routes.js";

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
});
