import { describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import {
  createRemoteSshHostConnection,
  describeHostEndpoint,
  normalizeStoredHostProfile,
  orderHostsLocalFirst,
  resolveActiveHostServerId,
  upsertHostConnectionInProfiles,
  type HostConnection,
  type HostProfile,
} from "./host-connection";

function makeHost(serverId: string): HostProfile {
  return {
    serverId,
    label: serverId,
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections: [],
    preferredConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("orderHostsLocalFirst", () => {
  it("moves the local host to the first position", () => {
    const remote = makeHost("srv_remote");
    const local = makeHost("srv_local");
    const anotherRemote = makeHost("srv_another_remote");

    expect(orderHostsLocalFirst([remote, local, anotherRemote], "srv_local")).toEqual([
      local,
      remote,
      anotherRemote,
    ]);
  });

  it("preserves host order when the local host is missing", () => {
    const hosts = [makeHost("srv_remote"), makeHost("srv_another_remote")];

    expect(orderHostsLocalFirst(hosts, "srv_local")).toBe(hosts);
  });

  it("preserves host order when there is no local host", () => {
    const hosts = [makeHost("srv_remote"), makeHost("srv_another_remote")];

    expect(orderHostsLocalFirst(hosts, null)).toBe(hosts);
  });
});

describe("normalizeStoredHostProfile", () => {
  it("loads direct TCP connections stored before TLS and password fields existed", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_old",
      label: "Old Host",
      connections: [
        {
          id: "direct:127.0.0.1:6767",
          type: "directTcp",
          endpoint: "127.0.0.1:6767",
        },
      ],
      preferredConnectionId: "direct:127.0.0.1:6767",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(profile).not.toBeNull();
    expect(profile?.connections[0]).toEqual({
      id: "direct:127.0.0.1:6767",
      type: "directTcp",
      endpoint: "127.0.0.1:6767",
      useTls: false,
    });
    expect(profile?.connections[0]).not.toHaveProperty("password");
  });

  it("moves a stored direct TCP password to the host profile", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_legacy",
      connections: [{ type: "directTcp", endpoint: "localhost:6767", password: "old-secret" }],
    });
    expect(profile?.password).toBe("old-secret");
    expect(profile?.connections[0]).not.toHaveProperty("password");
  });

  it("preserves legacy relay ids when TLS is absent", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_relay",
      connections: [
        {
          id: "relay:relay.example.com:80",
          type: "relay",
          relayEndpoint: "relay.example.com:80",
          daemonPublicKeyB64: "pubkey",
        },
      ],
    });

    expect(profile?.connections[0]).toEqual({
      id: "relay:relay.example.com:80",
      type: "relay",
      relayEndpoint: "relay.example.com:80",
      daemonPublicKeyB64: "pubkey",
    });
  });

  it("namespaces relay ids only when TLS is true", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_relay",
      connections: [
        {
          id: "relay:relay.example.com:443",
          type: "relay",
          relayEndpoint: "relay.example.com:443",
          useTls: true,
          daemonPublicKeyB64: "pubkey",
        },
      ],
    });

    expect(profile?.connections[0]).toEqual({
      id: "relay:wss:relay.example.com:443",
      type: "relay",
      relayEndpoint: "relay.example.com:443",
      useTls: true,
      daemonPublicKeyB64: "pubkey",
    });
  });

  it("gives a host stored before appearance existed the default appearance", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_old",
      connections: [
        {
          id: "socket:/tmp/paseo.sock",
          type: "directSocket",
          path: "/tmp/paseo.sock",
        },
      ],
    });

    expect(profile?.appearance).toEqual({ color: "none", badgeDisplay: null });
  });

  it("loads a stored appearance the user chose", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_new",
      appearance: { color: "teal", badgeDisplay: "icon" },
      connections: [
        {
          id: "socket:/tmp/paseo.sock",
          type: "directSocket",
          path: "/tmp/paseo.sock",
        },
      ],
    });

    expect(profile?.appearance).toEqual({
      color: "teal",
      badgeDisplay: "icon",
    });
  });

  it("normalizes stored Remote SSH connection parameters", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_ssh",
      connections: [
        {
          type: "remoteSsh",
          host: " deploy@example.com ",
          sshPort: 2222,
          daemonPort: 7777,
        },
      ],
    });

    expect(profile?.connections[0]).toEqual({
      id: "ssh:deploy%40example.com:2222:7777",
      type: "remoteSsh",
      host: "deploy@example.com",
      sshPort: 2222,
      daemonPort: 7777,
    });
  });
});

describe("createRemoteSshHostConnection", () => {
  it("keeps optional SSH settings absent", () => {
    expect(createRemoteSshHostConnection({ host: "build-box" })).toEqual({
      id: "ssh:build-box::",
      type: "remoteSsh",
      host: "build-box",
    });
  });

  it("rejects invalid SSH destinations and ports", () => {
    expect(() => createRemoteSshHostConnection({ host: "" })).toThrow("SSH host is required");
    expect(() => createRemoteSshHostConnection({ host: "bad host" })).toThrow(
      "SSH host is invalid",
    );
    expect(() => createRemoteSshHostConnection({ host: "build-box", sshPort: 70000 })).toThrow(
      "SSH port must be between 1 and 65535",
    );
    expect(() => createRemoteSshHostConnection({ host: "build-box", daemonPort: 0 })).toThrow(
      "Daemon port must be between 1 and 65535",
    );
  });
});

describe("upsertHostConnectionInProfiles", () => {
  const connection: HostConnection = {
    id: "socket:/tmp/paseo.sock",
    type: "directSocket",
    path: "/tmp/paseo.sock",
  };

  it("gives a newly discovered host the default appearance", () => {
    const [profile] = upsertHostConnectionInProfiles({
      profiles: [],
      serverId: "srv_new",
      connection,
    });

    expect(profile.appearance).toEqual({ color: "none", badgeDisplay: null });
  });

  it("keeps the appearance the user chose when the host reconnects", () => {
    const existing: HostProfile = {
      ...makeHost("srv_known"),
      appearance: { color: "amber", badgeDisplay: "hidden" },
      connections: [],
    };

    const [profile] = upsertHostConnectionInProfiles({
      profiles: [existing],
      serverId: "srv_known",
      connection,
    });

    expect(profile.appearance).toEqual({
      color: "amber",
      badgeDisplay: "hidden",
    });
  });

  it("replaces a direct connection when its settings change", () => {
    const existingConnection: HostConnection = {
      id: "direct:example.test:6767",
      type: "directTcp",
      endpoint: "example.test:6767",
      useTls: false,
    };
    const existing: HostProfile = {
      ...makeHost("srv_known"),
      password: "old-secret",
      connections: [existingConnection],
      preferredConnectionId: existingConnection.id,
    };
    const replacement: HostConnection = {
      ...existingConnection,
      useTls: true,
    };

    const [profile] = upsertHostConnectionInProfiles({
      profiles: [existing],
      serverId: "srv_known",
      connection: replacement,
      password: "new-secret",
    });

    expect(profile.connections).toEqual([replacement]);
    expect("password" in profile.connections[0]!).toBe(false);
    expect(profile.password).toBe("new-secret");
    expect(profile.preferredConnectionId).toBe(replacement.id);
  });
});

describe("resolveActiveHostServerId", () => {
  it("uses the selected host when one is set", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: "srv_selected",
        localServerId: "srv_local",
        hosts: [makeHost("srv_local"), makeHost("srv_selected")],
        orderedHosts: [makeHost("srv_local"), makeHost("srv_selected")],
      }),
    ).toBe("srv_selected");
  });

  it("falls back to the local host when it is connected", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId: "srv_local",
        hosts: [makeHost("srv_local"), makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_local"), makeHost("srv_remote")],
      }),
    ).toBe("srv_local");
  });

  it("skips a stopped local daemon and uses the first connected host", () => {
    // Regression: a stopped local daemon's serverId persists but isn't in `hosts`.
    // Falling back to it would resolve the section to an unknown id ("host not found").
    expect(
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId: "srv_local_stopped",
        hosts: [makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_remote")],
      }),
    ).toBe("srv_remote");
  });

  it("returns null when no hosts are connected", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId: "srv_local_stopped",
        hosts: [],
        orderedHosts: [],
      }),
    ).toBeNull();
  });

  it("ignores a selected host that is not connected", () => {
    // A stale selection (e.g. the host was removed) must not be used unless it is
    // currently connected, or the section resolves to an unknown id ("host not found").
    expect(
      resolveActiveHostServerId({
        selectedServerId: "srv_stale_selection",
        localServerId: null,
        hosts: [makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_remote")],
      }),
    ).toBe("srv_remote");
  });

  it("falls through a disconnected selection to the connected local host", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: "srv_stale_selection",
        localServerId: "srv_local",
        hosts: [makeHost("srv_local"), makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_local"), makeHost("srv_remote")],
      }),
    ).toBe("srv_local");
  });
});

describe("describeHostEndpoint", () => {
  // Two daemons on one Mac report the same hostname, so the label cannot identify either
  // one. This is what the picker and the removal confirmation use to tell them apart.
  const withConnections = (
    connections: HostConnection[],
    preferredConnectionId: string | null = null,
  ): HostProfile => ({
    ...makeHost("srv_same_name"),
    label: "Fixture-Host.local",
    connections,
    preferredConnectionId,
  });

  it("names the address of hosts that share a label", () => {
    const portable = withConnections([
      { id: "c1", type: "directTcp", endpoint: "127.0.0.1:54873" },
    ]);
    const main = withConnections([
      {
        id: "c2",
        type: "directTcp",
        endpoint: "fixture-host.tail000000.ts.net:8443",
      },
    ]);
    expect(portable.label).toBe(main.label);
    expect(describeHostEndpoint(portable)).toBe("127.0.0.1:54873");
    expect(describeHostEndpoint(main)).toBe("fixture-host.tail000000.ts.net:8443");
  });

  it("prefers the connection the host actually uses", () => {
    expect(
      describeHostEndpoint(
        withConnections(
          [
            { id: "c1", type: "directTcp", endpoint: "127.0.0.1:6767" },
            { id: "c2", type: "directTcp", endpoint: "127.0.0.1:54873" },
          ],
          "c2",
        ),
      ),
    ).toBe("127.0.0.1:54873");
  });

  it("drops uninformative standard web ports and falls back when there is no address", () => {
    expect(
      describeHostEndpoint(
        withConnections([
          {
            id: "c1",
            type: "relay",
            relayEndpoint: "relay.paseo.sh:443",
            daemonPublicKeyB64: "k",
          },
        ]),
      ),
    ).toBe("relay.paseo.sh");
    expect(describeHostEndpoint(withConnections([]))).toBeNull();
  });

  it("never exposes a stored password", () => {
    const host: HostProfile = {
      ...withConnections([{ id: "c1", type: "directTcp", endpoint: "127.0.0.1:54873" }]),
      password: "super-secret",
    };
    const described = describeHostEndpoint(host);
    expect(described).toBe("127.0.0.1:54873");
    expect(described).not.toContain("super-secret");
  });
});

describe("REPAIR replacement", () => {
  it("replaces every stale relay record and device identity, preserving host name and direct connections", () => {
    const old = {
      ...makeHost("srv_mac"),
      label: "Studio Mac",
      pairingRequired: "device-removed" as const,
      connections: [
        {
          id: "relay:old:443",
          type: "relay" as const,
          relayEndpoint: "old:443",
          daemonPublicKeyB64: "pin",
          deviceId: "dev_old",
        },
        { id: "direct:lan:6767", type: "directTcp" as const, endpoint: "lan:6767" },
      ],
      preferredConnectionId: "relay:old:443",
    };
    const replacement = {
      ...old.connections[0],
      id: "relay:new:443",
      type: "relay" as const,
      relayEndpoint: "new:443",
      daemonPublicKeyB64: "pin",
      deviceId: "dev_new",
    };
    const hosts = upsertHostConnectionInProfiles({
      profiles: [old],
      serverId: old.serverId,
      connection: replacement,
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0].label).toBe("Studio Mac");
    expect(hosts[0].pairingRequired).toBeUndefined();
    expect(hosts[0].connections).toEqual([old.connections[1], replacement]);
    expect(hosts[0].preferredConnectionId).toBe(replacement.id);
  });

  it("persists a changed deviceId even when the endpoint and host pin are unchanged", () => {
    const connection = {
      id: "relay:host:443",
      type: "relay" as const,
      relayEndpoint: "host:443",
      daemonPublicKeyB64: "pin",
      deviceId: "dev_old",
    };
    const old = { ...makeHost("srv_mac"), connections: [connection] };
    const hosts = upsertHostConnectionInProfiles({
      profiles: [old],
      serverId: old.serverId,
      connection: { ...connection, deviceId: "dev_new" },
    });
    expect(hosts[0].connections[0]).toMatchObject({ deviceId: "dev_new" });
    expect(
      normalizeStoredHostProfile(JSON.parse(JSON.stringify(hosts[0])))?.connections[0],
    ).toMatchObject({ deviceId: "dev_new" });
  });

  it("retains pre-v3 relay records at load rather than silently dropping the host", () => {
    const host = normalizeStoredHostProfile({
      serverId: "srv_legacy",
      label: "Legacy Mac",
      connections: [
        { type: "relay", relayEndpoint: "relay.example.test:443", daemonPublicKeyB64: "pin" },
      ],
    });
    expect(host?.label).toBe("Legacy Mac");
    expect(host?.connections[0]).toMatchObject({ type: "relay" });
    expect(host?.connections[0]).not.toHaveProperty("deviceId");
  });
});

it("IR-3 desktop refresh selects the new endpoint and retains remote profiles", () => {
  const old = {
    ...makeHost("desktop"),
    connections: [{ type: "directTcp" as const, id: "old", endpoint: "127.0.0.1:1234" }],
    preferredConnectionId: "old",
  };
  const remote = makeHost("remote");
  const next = upsertHostConnectionInProfiles({
    profiles: [old, remote],
    serverId: "desktop",
    connection: { type: "directTcp", id: "new", endpoint: "127.0.0.1:5678" },
    preferConnection: true,
  });
  expect(next[0].preferredConnectionId).toBe("new");
  expect(next[1]).toBe(remote);
  expect(next[0].appearance).toBe(old.appearance);
});
