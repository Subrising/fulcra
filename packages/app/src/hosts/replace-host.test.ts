import { describe, expect, it } from "vitest";
import { findReplaceablePair, machineName } from "./replace-host";
import type { HostProfile } from "@/types/host-connection";
import { defaultHostAppearance } from "@/hosts/appearance";

const host = (serverId: string, label: string): HostProfile => ({
  serverId,
  label,
  appearance: defaultHostAppearance(),
  lifecycle: {},
  connections: [],
  preferredConnectionId: null,
  createdAt: "",
  updatedAt: "",
});

describe("machineName", () => {
  it("treats macOS and app renames of the same Mac as one name", () => {
    for (const label of [
      "MacBook-Pro.local",
      "MacBook-Pro-2.local",
      "MacBook-Pro.local 2",
      "macbook-pro.local (3)",
    ]) {
      expect(machineName(label)).toBe("macbook-pro.local");
    }
    expect(machineName("Mac-mini")).not.toBe(machineName("MacBook-Pro"));
  });
});

describe("findReplaceablePair", () => {
  const old = host("srv_old", "MacBook-Pro.local");
  const fresh = host("srv_new", "MacBook-Pro.local 2");
  const hosts = [old, fresh, host("srv_mini", "Mac-mini.local")];

  it("pairs the unreachable old entry with the online new one, from either side", () => {
    const online = (id: string) => id !== "srv_old";
    expect(findReplaceablePair(fresh, hosts, online)).toEqual({ older: old, newer: fresh });
    expect(findReplaceablePair(old, hosts, online)).toEqual({ older: old, newer: fresh });
  });

  it("offers nothing when both are online, both are offline, or names differ", () => {
    expect(findReplaceablePair(fresh, hosts, () => true)).toBeNull();
    expect(findReplaceablePair(fresh, hosts, () => false)).toBeNull();
    expect(findReplaceablePair(hosts[2]!, hosts, (id) => id === "srv_mini")).toBeNull();
  });

  it("never matches hosts that only have an id for a name", () => {
    const a = host("srv_a", "srv_a"),
      b = host("srv_b", "srv_b");
    expect(findReplaceablePair(a, [a, b], (id) => id === "srv_a")).toBeNull();
  });
});
