import { bundledTarget } from "./test-utils/management.js";
import { ManagementAuthority } from "./management.js";
import type {
  ControllerManagementCommandV11,
  ManagementPrincipalV11,
} from "@getpaseo/protocol/controller-management";
async function management(
  channel: ControllerChannel,
  requestedCommand: ControllerManagementCommandV11,
  requestedPrincipal: ManagementPrincipalV11,
  id?: string,
) {
  const host = new ManagementAuthority({ enabled: () => true, validate: (command) => command });
  host.register("orca-organization-next", (command, principal) =>
    channel.management(command, principal, id),
  );
  const invocation = host.open(bundledTarget, () => requestedPrincipal)!;
  try {
    return await host.invoke(invocation.id, "orca-organization-next", "call", requestedCommand);
  } finally {
    host.close();
  }
}
import { expect, test, vi } from "vitest";
import { ControllerChannel } from "./controller-channel.js";

test("P8 owned child, epoch, duplicate IDs, unknown fields and shutdown", async () => {
  const child = {};
  const issue = vi.fn(() => "private-token");
  const revoke = vi.fn();
  const rpc = vi.fn(async () => null);
  const channel = new ControllerChannel({
    child,
    issue,
    revoke,
    rpc,
    send: async () => null,
  });
  const frame = {
    id: "one",
    epoch: channel.epoch,
    type: "daemon-rpc",
    frame: {},
  };
  await expect(channel.receive({}, frame)).resolves.toMatchObject({
    ok: false,
    code: "unauthorised",
  });
  await expect(
    channel.receive(child, { ...frame, epoch: "99999999-9999-4999-8999-999999999999" }),
  ).resolves.toMatchObject({ ok: false, code: "expired" });
  await expect(channel.receive(child, { ...frame, principal: "owner" })).resolves.toMatchObject({
    ok: false,
    code: "invalid",
  });
  expect((await channel.receive(child, frame)).ok).toBe(true);
  await expect(channel.receive(child, frame)).resolves.toMatchObject({
    ok: false,
    code: "expired",
  });
  channel.close();
  expect(revoke).toHaveBeenCalledOnce();
  await expect(channel.receive(child, { ...frame, id: "two" })).resolves.toMatchObject({
    ok: false,
    code: "unavailable",
  });
});
test("P8 bounded frame bytes and depth", async () => {
  const child = {};
  const rpc = vi.fn(async () => null);
  const channel = new ControllerChannel({
    child,
    issue: () => "token",
    revoke: () => {},
    rpc,
    send: async () => null,
  });
  const frame = {
    id: "x",
    epoch: channel.epoch,
    type: "daemon-rpc",
    frame: { data: "x".repeat(1024 * 1024) },
  };
  await expect(channel.receive(child, frame)).rejects.toThrow("Controller frame invalid");
  let deep: unknown = {};
  for (let i = 0; i < 33; i++) deep = { deep };
  await expect(channel.receive(child, { ...frame, frame: deep })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
test("P8 crash revokes provenance and duplicate management command IDs refuse", async () => {
  const child = {};
  const revoke = vi.fn();
  const send = vi.fn(async (frame: { id: string; epoch: string }) => ({
    id: frame.id,
    epoch: frame.epoch,
    ok: true,
    result: null,
  }));
  const channel = new ControllerChannel({
    child,
    issue: () => "token",
    revoke,
    rpc: async () => null,
    send,
  });
  const principal = {
    id: "owner",
    authentication: "daemon-password",
    deviceId: null,
    permissions: ["daemon.manage", "command-centre.manage"],
  } as const;
  await management(channel, { method: "list", input: null }, principal, "one");
  await expect(
    management(channel, { method: "list", input: null }, principal, "one"),
  ).rejects.toThrow();
  channel.crash();
  expect(revoke).toHaveBeenCalledOnce();
  await expect(management(channel, { method: "list", input: null }, principal)).rejects.toThrow();
  expect(send).toHaveBeenCalledOnce();
});

test("P8 private provenance retains actual binding, one-use, expiry and crash revocation", async () => {
  const { TrustedPlugins } = await import("./trusted.js");
  const { canonicalTrustedPayload } = await import("@getpaseo/protocol/trusted-input");
  const { createHash } = await import("node:crypto");
  const authority = new TrustedPlugins();
  const agentId = "11111111-1111-4111-8111-111111111111";
  authority.initializeKnownAgents([agentId]);
  let issue!: (binding: import("@getpaseo/protocol/trusted-input").ProvenanceBindingV11) => string;
  authority.registerV11("orca-organization-next", true, (sdk) => {
    issue = sdk.issueProvenance;
  });
  const payload = {
    type: "command",
    command: "cancel",
    arguments: {},
  } as const;
  const binding = {
    agentId,
    kind: "cancel",
    messageId: null,
    attemptId: "22222222-2222-4222-8222-222222222222",
    payloadDigest: createHash("sha256")
      .update(
        canonicalTrustedPayload({
          agentId,
          kind: "cancel",
          messageId: null,
          payload,
        }),
      )
      .digest("hex"),
  };
  const child = {};
  const channel = new ControllerChannel({
    child,
    issue,
    revoke: () => authority.revokeProvenance("orca-organization-next"),
    rpc: async () => null,
    send: async () => null,
  });
  const mint = async (id: string) => {
    const reply = await channel.receive(child, {
      id,
      epoch: channel.epoch,
      type: "issue-provenance",
      binding,
    });
    if (!reply.ok || typeof reply.result !== "string") throw new Error("mint failed");
    return reply.result;
  };
  const consume = (token: string) =>
    authority.rpc(token, () =>
      authority.input({ id: agentId }, "cancel", undefined, () => "dispatched", payload),
    );
  try {
    const first = await mint("first");
    expect(consume(first)).toBe("dispatched");
    expect(() => consume(first)).toThrow();
    const expired = await mint("expires");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    try {
      expect(() => consume(expired)).toThrow();
    } finally {
      clock.mockRestore();
    }
    const outstanding = await mint("crash");
    channel.crash();
    expect(() => consume(outstanding)).toThrow();
  } finally {
    authority.close();
  }
});

test("P8 management replies require current epoch and matching command identity", async () => {
  const principal = {
    id: "owner",
    authentication: "daemon-password",
    deviceId: null,
    permissions: ["daemon.manage", "command-centre.manage"],
  } as const;
  for (const corrupt of ["id", "epoch"] as const) {
    const channel = new ControllerChannel({
      child: {},
      issue: () => "token",
      revoke: () => {},
      rpc: async () => null,
      send: async (frame) => ({
        id: frame.id,
        epoch: frame.epoch,
        ok: true,
        result: null,
        [corrupt]: "stale",
      }),
    });
    await expect(management(channel, { method: "list", input: null }, principal)).rejects.toThrow();
  }
});

test("P6/P8 revocation during an asynchronous bridge blocks the actual child write", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = vi.fn(async () => null);
  const channel = new ControllerChannel({
    child: {},
    issue: () => "token",
    revoke: () => {},
    rpc: async () => null,
    send,
  });
  const authority = new ManagementAuthority({
    enabled: () => true,
    validate: (command) => command,
  });
  authority.register("orca-organization-next", async (command, principal) => {
    await wait;
    return channel.management(command, principal);
  });
  const invocation = authority.open(bundledTarget, () => ({
    id: "owner",
    authentication: "daemon-password",
    deviceId: null,
    permissions: ["daemon.manage", "command-centre.manage"],
  }))!;
  const pending = authority.invoke(invocation.id, "orca-organization-next", "call", {
    method: "list",
    input: null,
  });
  invocation.close();
  release();
  await expect(pending).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

test("P6/P8 the write capability cannot change principal or dispatch twice", async () => {
  for (const forge of [true, false]) {
    const send = vi.fn(async (frame: { id: string; epoch: string }) => ({
      id: frame.id,
      epoch: frame.epoch,
      ok: true,
      result: null,
    }));
    const channel = new ControllerChannel({
      child: {},
      issue: () => "token",
      revoke: () => {},
      rpc: async () => null,
      send,
    });
    const host = new ManagementAuthority({ enabled: () => true, validate: (command) => command });
    host.register("orca-organization-next", async (command, principal) => {
      if (forge) return channel.management(command, { ...principal, id: "forged" });
      await channel.management(command, principal);
      return channel.management(command, principal);
    });
    const invocation = host.open(bundledTarget, () => ({
      id: "owner",
      authentication: "daemon-password",
      deviceId: null,
      permissions: ["daemon.manage", "command-centre.manage"],
    }))!;
    await expect(
      host.invoke(invocation.id, "orca-organization-next", "call", { method: "list", input: null }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(forge ? 0 : 1);
    host.close();
  }
});

test("P6/P8 a principal permission snapshot cannot outlive grant changes during bridge await", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = vi.fn(async () => null);
  const channel = new ControllerChannel({
    child: {},
    issue: () => "token",
    revoke: () => {},
    rpc: async () => null,
    send,
  });
  const host = new ManagementAuthority({ enabled: () => true, validate: (command) => command });
  host.register("orca-organization-next", async (command, principal) => {
    await wait;
    return channel.management(command, principal);
  });
  let permissions: import("@getpaseo/protocol/messages").DaemonPermission[] = [
    "daemon.manage",
    "command-centre.manage",
    "access.manage",
  ];
  const invocation = host.open(bundledTarget, () => ({
    id: "owner",
    authentication: "daemon-password",
    deviceId: null,
    permissions,
  }))!;
  const pending = host.invoke(invocation.id, "orca-organization-next", "call", {
    method: "list",
    input: null,
  });
  permissions = ["command-centre.manage"];
  release();
  await expect(pending).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  host.close();
});

test("P8 exact complete-frame depth boundary and sanitized parser errors", async () => {
  const { parseControllerRequest } = await import("./controller-frames.js");
  const frame = {
    id: "depth",
    epoch: "11111111-1111-4111-8111-111111111111",
    type: "daemon-rpc",
    frame: {},
  };
  let value: unknown = null;
  for (let i = 0; i < 30; i++) value = { nested: value };
  expect(() => parseControllerRequest({ ...frame, frame: value })).not.toThrow();
  expect(() => parseControllerRequest({ ...frame, frame: { nested: value } })).toThrow(
    "Controller frame invalid",
  );
  expect(() => parseControllerRequest("malformed SECRET")).toThrow(/^Controller frame invalid$/);
});

test("IR-6 a lost or unencodable post-dispatch reply is uncertain", async () => {
  const principal = {
    id: "owner",
    authentication: "daemon-password" as const,
    deviceId: null,
    permissions: ["command-centre.manage" as const, "daemon.manage" as const],
  };
  for (const send of [
    async () => {
      throw Error("pipe closed");
    },
    async () => ({ bad: "reply" }),
  ]) {
    const channel = new ControllerChannel({
      child: {},
      issue: () => "",
      revoke() {},
      rpc: async () => null,
      send,
    });
    await expect(
      management(channel, { method: "send", input: null }, principal),
    ).rejects.toMatchObject({ code: "uncertain" });
  }
});

test("owned precondition refusal preserves its message through the management channel", async () => {
  const principal = {
    id: "owner",
    authentication: "daemon-password" as const,
    deviceId: null,
    permissions: ["command-centre.manage" as const, "daemon.manage" as const],
  };
  const channel = new ControllerChannel({
    child: {},
    issue: () => "",
    revoke() {},
    rpc: async () => null,
    send: async (frame) => ({
      id: frame.id,
      epoch: frame.epoch,
      ok: false,
      code: "invalid",
      message: "Unresolved work must be reconciled before leadership transfer",
    }),
  });
  await expect(
    management(channel, { method: "leadership-transfer", input: null }, principal),
  ).rejects.toMatchObject({
    code: "invalid",
    publicMessage: "Unresolved work must be reconciled before leadership transfer",
  });
  channel.close();
});
