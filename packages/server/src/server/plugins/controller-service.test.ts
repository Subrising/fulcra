import { capturedCatalogReply, catalogReplyPath } from "./catalog-reply.fixture.js";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { DaemonClient } from "../../../../client/src/daemon-client.js";
import { createControllerTransport } from "../../../../client/src/controller-transport.js";
import { createControllerService } from "./controller-service.js";
import { ControllerChannel } from "./controller-channel.js";
import type { PluginSessionSocket } from "./session-socket.js";

const welcome = {
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
};

async function fixture(
  ownedSubscriptions = true,
  plugins: Array<{ id: string; clientBundle: string }> = [],
) {
  let socket!: PluginSessionSocket;
  const inbound: Record<string, unknown>[] = [];
  const output: unknown[] = [];
  const epoch = randomUUID();
  let adapter: ReturnType<typeof createControllerTransport> | undefined;
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
                ...welcome,
                message: {
                  ...welcome.message,
                  payload: { ...welcome.message.payload, features: { ownedSubscriptions } },
                },
              }),
            );
          if (frame.message?.type === "fetch_agents_request")
            peer.send(
              JSON.stringify({
                type: "session",
                message: {
                  type: "fetch_agents_response",
                  payload: {
                    requestId: frame.message.requestId,
                    subscriptionId: "agents-fixture",
                    entries: [],
                    pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
                  },
                },
              }),
            );
          if (frame.message?.type === "plugin.catalog.get.request")
            peer.send(
              JSON.stringify({
                type: "session",
                message: {
                  type: "plugin.catalog.get.response",
                  payload: {
                    requestId: frame.message.requestId,
                    plugins,
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
        adapter?.receive(frame);
      },
      revoke: () => {},
    },
  );
  adapter = createControllerTransport({
    epoch,
    request: (frame) => service.dispatch(frame),
    ready: () => service.ready(),
  });
  const client = new DaemonClient({
    url: "ws://fixture",
    clientId: "fixture",
    transportFactory: () => adapter!.transport,
    reconnect: { enabled: false },
  });
  return { socket, inbound, output, service, adapter, client, epoch };
}

test("actual DaemonClient hello/catalog and observation snapshot/update use host service envelopes", async () => {
  const f = await fixture(false);
  try {
    expect(f.output).toEqual([]); // actual welcome retained before listeners are ready
    await f.client.connect();
    expect(f.client.getLastServerInfoMessage()?.serverId).toBe("fixture");
    expect(f.inbound.filter((x) => x.type === "hello")).toHaveLength(1);
    const catalog = await f.client.getPluginCatalog();
    expect(catalog.plugins).toEqual([]);
    const observation = f.client.observeTimeline(["agent"]);
    await expect(observation.ready).resolves.toMatchObject({ agentIds: ["agent"] });
    const updates: unknown[] = [];
    observation.subscribe({ snapshot: () => {}, update: (message) => updates.push(message) });
    f.socket.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "agent_stream",
          payload: {
            agentId: "agent",
            timestamp: "2026-09-27T00:00:00Z",
            event: { type: "turn_completed", provider: "codex" },
          },
        },
      }),
    );
    expect(updates).toHaveLength(1);
    f.service.close();
    f.adapter.receive({ type: "daemon-event", version: 1, epoch: f.epoch, frame: welcome });
    expect(f.client.getLastServerInfoMessage()).toBeNull();
  } finally {
    await f.client.close();
    f.service.close();
  }
});

test.each(["daemon-open", "daemon-event", "daemon-closed"])(
  "child cannot send host-only %s",
  async (type) => {
    const child = {},
      channel = new ControllerChannel({
        child,
        issue: () => "token",
        revoke() {},
        rpc: async () => null,
        send: async () => null,
      });
    await expect(
      channel.receive(child, { id: "injected", epoch: channel.epoch, type, frame: welcome }),
    ).resolves.toMatchObject({ ok: false, code: "invalid" });
    channel.close();
  },
);

test("pre-ready event count and byte caps close and revoke the epoch", async () => {
  for (const mode of ["count", "bytes"]) {
    const f = await fixture();
    for (let i = 0; i < (mode === "count" ? 65 : 30); i++) {
      f.socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: { status: mode === "count" ? "small" : "x".repeat(300000) },
          },
        }),
      );
    }
    expect(f.output).toEqual([{ type: "daemon-closed", version: 1, epoch: f.epoch }]);
    f.service.ready();
    expect(f.output).toHaveLength(1);
    await f.client.close();
  }
});

test("stream rejects caller admission, unknown keys, excessive depth and management frames", async () => {
  const f = await fixture();
  for (const frame of [
    { type: "plugin.catalog.get.request", requestId: "a", principal: { id: "owner" } },
    { type: "hello", clientType: "mcp", admission: { kind: "owner" } },
    { type: "management", command: {} },
  ])
    await expect(f.service.dispatch(frame)).rejects.toThrow();
  f.service.close();
  await f.client.close();
});

test("typed refusal survives the service stream into the actual SDK", async () => {
  const f = await fixture();
  try {
    await f.client.connect();
    f.socket.on("message", (data) => {
      const value = JSON.parse(String(data));
      if (value.message?.type !== "agent_permission_response") return;
      f.socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "rpc_error",
            payload: {
              requestId: value.message.requestId,
              error: "Fixture hook refused",
              code: "admission_refused",
              nativeDispatched: false,
            },
          },
        }),
      );
    });
    await expect(
      f.client.invokeRawInput(
        {
          type: "agent_permission_response",
          agentId: "fixture-agent",
          requestId: "fixture-permission",
          response: { behavior: "allow" },
          inputProvenance: "fixture-token",
        },
        "agent_permission_resolved",
      ),
    ).rejects.toMatchObject({ code: "admission_refused", nativeDispatched: false });
  } finally {
    await f.client.close();
    f.service.close();
  }
});

test("closed adapter never delivers a later event; a replacement requires its own epoch", async () => {
  const epoch = randomUUID(),
    received: unknown[] = [];
  const adapter = createControllerTransport({ epoch, request: async () => null, ready() {} });
  adapter.transport.onOpen(() => adapter.transport.send(JSON.stringify({ type: "hello" })));
  adapter.transport.onMessage((message) => received.push(message));
  adapter.transport.onClose(() => {});
  adapter.transport.onError(() => {});
  await Promise.resolve();
  adapter.receive({ type: "daemon-open", version: 1, epoch, frame: welcome });
  adapter.receive({ type: "daemon-closed", version: 1, epoch });
  adapter.receive({ type: "daemon-event", version: 1, epoch, frame: { type: "pong" } });
  expect(received).toHaveLength(1);
  const replacement = await fixture();
  try {
    await replacement.client.connect();
    expect(replacement.epoch).not.toBe(epoch);
    replacement.adapter.receive({
      type: "daemon-event",
      version: 1,
      epoch,
      frame: { type: "pong" },
    });
    expect(replacement.client.getLastServerInfoMessage()).toBeNull();
  } finally {
    await replacement.client.close();
    replacement.service.close();
  }
});

test("real SDK owned subscription receives a host snapshot/update and loses its route on close", async () => {
  const f = await fixture();
  try {
    await f.client.connect();
    const observation = f.client.observeAgents({ page: { limit: 100 } });
    const first = await observation.ready;
    expect(first.subscriptionId).toBe("agents-fixture");
    const snapshots: unknown[] = [],
      updates: unknown[] = [];
    observation.subscribe({
      snapshot: (value) => snapshots.push(value),
      update: (value) => updates.push(value),
    });
    expect(snapshots).toHaveLength(1);
    f.socket.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "fetch_agents_response",
          payload: {
            requestId: first.requestId,
            subscriptionId: "agents-fixture",
            entries: [],
            pageInfo: { nextCursor: "next", prevCursor: null, hasMore: true },
          },
        },
      }),
    );
    expect(updates).toHaveLength(1);
    f.service.close();
    expect(observation.subscriptionId).toBeNull();
  } finally {
    await f.client.close();
    f.service.close();
  }
});

test.skipIf(!catalogReplyPath)(
  "real SDK accepts three copies of the captured packaged client script through the bounded host stream",
  async () => {
    const plugins = Array.from({ length: 3 }, (_, i) => ({
      ...capturedCatalogReply().plugin,
      id: `fixture-${i}`,
    }));
    const f = await fixture(true, plugins);
    try {
      await f.client.connect();
      await expect(f.client.getPluginCatalog()).resolves.toMatchObject({ plugins });
    } finally {
      await f.client.close();
      f.service.close();
    }
  },
);

test.skipIf(!catalogReplyPath)(
  "pre-ready byte budget admits three real catalog replies but still closes above 8 MiB",
  async () => {
    const f = await fixture();
    const event = capturedCatalogReply().frame;
    for (let i = 0; i < 3; i++) f.socket.send(JSON.stringify(event));
    expect(f.output).toEqual([]);
    for (let i = 3; i < 13; i++) f.socket.send(JSON.stringify(event));
    expect(f.output).toEqual([{ type: "daemon-closed", version: 1, epoch: f.epoch }]);
    await f.client.close();
  },
);
