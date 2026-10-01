import { expect, test } from "vitest";
import { connectionFromListen, normalizeStoredHostProfile } from "./host-connection";

test("desktop registration and reload preserve the exact bound loopback address", () => {
  for (const endpoint of ["127.0.0.1:16767", "[::1]:16767", "localhost:16767"]) {
    const connection = connectionFromListen(endpoint);
    expect(connection).toMatchObject({ type: "directTcp", endpoint });
    const restored = normalizeStoredHostProfile({
      serverId: "fixture",
      label: "Fixture",
      connections: [connection],
      preferredConnectionId: connection!.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(restored?.connections[0]).toMatchObject({ endpoint });
  }
});
