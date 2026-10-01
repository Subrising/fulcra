import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createControllerService } from "./controller-service.js";
import type { PluginSessionSocket } from "./session-socket.js";

async function catalogControllerFixture() {
  let socket!: PluginSessionSocket;
  const inbound: unknown[] = [],
    output: unknown[] = [];
  const epoch = randomUUID();
  const service = await createControllerService(
    {
      async attachPluginSocket(id, peer) {
        expect(id).toBe("orca-organization-next");
        socket = peer;
        peer.on("message", (data) => {
          const frame = JSON.parse(String(data));
          inbound.push(frame);
          if (frame.type === "hello")
            peer.send(
              JSON.stringify({
                type: "session",
                message: {
                  type: "status",
                  payload: {
                    status: "server_info",
                    serverId: "fixture",
                    hostname: null,
                    version: null,
                    features: { ownedSubscriptions: true },
                  },
                },
              }),
            );
        });
        return { closed: new Promise<void>(() => {}) };
      },
    },
    {
      epoch,
      emit: (frame) => {
        output.push(frame);
      },
      revoke() {},
    },
  );
  return { service, socket, inbound, output, epoch };
}

test("L17 actual controller service carries strict paging/chunk/release frames without admission flags", async () => {
  const f = await catalogControllerFixture();
  try {
    f.service.ready();
    const snapshotId = randomUUID(),
      reference = randomUUID();
    const requests = [
      { type: "plugin.catalog.page.request", requestId: "page" },
      {
        type: "plugin.catalog.bundle.get.request",
        requestId: "chunk",
        snapshotId,
        reference,
        offset: 0,
        length: 4,
      },
      { type: "plugin.catalog.snapshot.release.request", requestId: "release", snapshotId },
    ];
    for (const request of requests) {
      await f.service.dispatch(request);
      expect(f.inbound.at(-1)).toMatchObject({ type: "session", message: request });
      await expect(
        f.service.dispatch({ ...request, principal: { owner: true } }),
      ).rejects.toThrow();
    }
    const common = {
      status: "ok",
      version: 1,
      snapshotId,
      revision: randomUUID(),
      manifestHash: "a".repeat(64),
      expiresAt: Date.now() + 30_000,
    };
    const responses = [
      {
        type: "plugin.catalog.page.response",
        payload: {
          ...common,
          requestId: "page",
          entries: [],
          nextCursor: null,
          trust: { trustedHost: { contract: "1.1", boot: randomUUID() }, trustedPlugins: [] },
        },
      },
      {
        type: "plugin.catalog.bundle.get.response",
        payload: {
          ...common,
          requestId: "chunk",
          reference,
          sha256: "b".repeat(64),
          offset: 0,
          totalBytes: 4,
          data: Buffer.from("safe").toString("base64"),
          eof: true,
        },
      },
      {
        type: "plugin.catalog.snapshot.release.response",
        payload: { requestId: "release", status: "ok", snapshotId },
      },
      {
        type: "plugin.catalog.page.response",
        payload: { requestId: "refusal", status: "refused", error: "read_revoked" },
      },
    ];
    for (const message of responses) {
      f.socket.send(JSON.stringify({ type: "session", message }));
      expect(f.output.at(-1)).toEqual({
        type: "daemon-event",
        version: 1,
        epoch: f.epoch,
        frame: { type: "session", message },
      });
    }
  } finally {
    f.service.close();
  }
});
