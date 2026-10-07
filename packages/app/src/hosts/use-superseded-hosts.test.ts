import { expect, it } from "vitest";
import type { HostProfile } from "@/types/host-connection";
import { supersededServerIds } from "./use-superseded-hosts";

const host = (serverId: string, label: string) => ({ serverId, label }) as HostProfile;

it("an offline host is superseded only when the same machine is online under a new identity", () => {
  const hosts = [
    host("srv_old", "MacBook-Pro.local"),
    host("srv_new", "MacBook-Pro-2.local"),
    host("srv_mini", "Mac-mini.local"),
  ];
  const online = (ids: string[]) => (id: string) => ids.includes(id);
  expect([...supersededServerIds(hosts, online(["srv_new", "srv_mini"]))]).toEqual(["srv_old"]);
  // Both offline, or both online: nothing proves which is current, so both stay.
  expect(supersededServerIds(hosts, online([])).size).toBe(0);
  expect(supersededServerIds(hosts, online(["srv_old", "srv_new"])).size).toBe(0);
  // An unnamed host never matches another.
  expect(
    supersededServerIds([host("srv_a", "srv_a"), host("srv_b", "srv_b")], online(["srv_b"])).size,
  ).toBe(0);
});
