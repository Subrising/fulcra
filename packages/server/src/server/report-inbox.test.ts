import { test, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, readdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { parseControllerCommand } from "../../../../control/orca-organization/shared/command-parser.mjs";
import { NativeReportRegistry } from "./report-registry.js";
import { NativeReportInbox } from "./report-inbox.js";
import { MessageReceipts, type NativeQueuedMessage } from "./message-receipts/index.js";
import { requireReportReader } from "./report-reader.js";
import { requireNativeReportBatch, type NativeReportBatch } from "./report-batch.js";
import { ControllerChannel } from "./plugins/controller-channel.js";
import { rpc, RPC_METHODS } from "../../../../control/src/control/rpc.mjs";
import { readGrant } from "../../../../control/src/control/grant-file.mjs";
import { ManagementAuthority } from "./plugins/management.js";
import {
  registerNativeReportRegistry,
  registerNativeIntercomRates,
} from "./plugins/native-intercom-owner.js";
import { IntercomRates } from "./intercom-rates.js";
import type { JsonValue } from "@getpaseo/protocol/trusted-input";

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-report-test-")));
  const nativeIdentity = () => ({
    agentId: randomUUID(),
    instanceId: randomUUID(),
    sessionId: randomUUID(),
    boot: randomUUID(),
  });
  const prime = nativeIdentity(),
    child = { ...nativeIdentity(), boot: prime.boot };
  const identities = new Map([
    [prime.agentId, prime],
    [child.agentId, child],
  ]);
  const scope = { projectId: randomUUID(), taskId: randomUUID() };
  let live = true;
  const authority = new ManagementAuthority({
    enabled: () => true,
    validate: (command) => parseControllerCommand(command),
  });
  const bridge = vi.fn(async () => null);
  authority.register("orca-organization-next", bridge);
  const target = {
    pluginId: "orca-organization-next",
    bundleDirectory: "/fixture/bundle",
    isCurrent: () => true,
  };
  const registry = new NativeReportRegistry(
    path.join(directory, "authority.json"),
    (id) => identities.get(id) ?? null,
    10000,
    path.join(directory, "grants", "report"),
  );
  registerNativeReportRegistry(authority, registry);
  registerNativeIntercomRates(authority, new IntercomRates(path.join(directory, "rates.json")));
  const ownerCall = async (method: string, input: JsonValue) => {
    const owner = authority.open(target, () =>
      live
        ? {
            id: "fixture-owner",
            authentication: "protected-local-ipc",
            deviceId: null,
            permissions: ["command-centre.manage", "daemon.manage", "accounts.manage"],
          }
        : undefined,
    )!;
    try {
      return await owner.invoke(randomUUID(), { method, input });
    } finally {
      owner.close();
    }
  };
  const register = (expectedEpoch: string | null = null) =>
    ownerCall("report-prime-register", {
      messageId: randomUUID(),
      identity: prime,
      scopes: [scope],
      expectedEpoch,
    });
  const adopt = (expectedEpoch: string | null = null) =>
    ownerCall("report-parent-adopt", {
      messageId: randomUUID(),
      child,
      parent: prime,
      scopes: [scope],
      expectedEpoch,
    });
  const primeReceipt = (await register()) as { epoch: string };
  const childReceipt = (await adopt()) as { epoch: string };
  const grant = JSON.parse(
    await readFile(path.join(directory, "grants", "report", `${prime.agentId}.json`), "utf8"),
  ) as { capability: string };
  const receipts = new MessageReceipts(path.join(directory, "receipts"));
  const inbox = new NativeReportInbox(registry, receipts);
  const events = [
    { id: randomUUID(), source: child, scope, kind: "ended" as const, at: Date.now() },
  ];
  const batch = registry.captureReportBatch(events);
  const messageId = randomUUID();
  const admit = () =>
    receipts.enqueue({
      agentId: prime.agentId,
      messageId,
      request: "Native report metadata is available in supervisor_inbox.",
      principal: { parent: prime, parentEpoch: primeReceipt.epoch },
      boot: prime.boot,
      attachmentBytes: 0,
      authorize: () => {
        requireNativeReportBatch(batch);
      },
      reportBatch: batch,
    });
  const request = (method = "events-inbox", input: object = { sessionId: prime.agentId }) =>
    inbox.request({ method, input, capability: grant.capability });
  return {
    directory,
    prime,
    child,
    identities,
    scope,
    registry,
    authority,
    bridge,
    ownerCall,
    register,
    adopt,
    primeReceipt,
    childReceipt,
    grant,
    receipts,
    batch,
    messageId,
    events,
    admit,
    request,
    revokeOwner: () => {
      live = false;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("native report Settings: actual host owner route writes strict finite limits and cannot bridge", async () => {
  const f = await fixture();
  try {
    const settings = { report: 12, followup: 64, channel: 64, seat: 32 };
    const messageId = randomUUID();
    expect(await f.ownerCall("intercom-rate-settings-set", { messageId, settings })).toEqual({
      messageId,
      duplicate: false,
    });
    expect(await f.ownerCall("intercom-rate-settings-set", { messageId, settings })).toEqual({
      messageId,
      duplicate: true,
    });
    await expect(
      f.ownerCall("intercom-rate-settings-set", {
        messageId: randomUUID(),
        settings: { ...settings, report: 13 },
      }),
    ).rejects.toThrow();
    const pairedDeviceId = randomUUID();
    const paired = f.authority.open(
      {
        pluginId: "orca-organization-next",
        bundleDirectory: "/fixture/bundle",
        isCurrent: () => true,
      },
      () => ({
        id: "paired-principal",
        authentication: "paired-device",
        deviceId: pairedDeviceId,
        permissions: ["command-centre.manage", "daemon.manage", "accounts.manage"],
      }),
    )!;
    try {
      await expect(
        paired.invoke(randomUUID(), {
          method: "intercom-rate-settings-set",
          input: { messageId: randomUUID(), settings },
        }),
      ).rejects.toThrow();
    } finally {
      paired.close();
    }
    f.revokeOwner();
    await expect(
      f.ownerCall("intercom-rate-settings-set", {
        messageId: randomUUID(),
        settings,
      }),
    ).rejects.toThrow();
    expect(f.bridge).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test("native report collector: durable metadata precedes one sealed wake and preserves consumption", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const ready = vi.fn();
  const factory = (batch: NativeReportBatch, messageId: string): NativeQueuedMessage => ({
    agentId: f.prime.agentId,
    messageId,
    request: "Native report metadata is available in supervisor_inbox.",
    principal: { parent: f.prime, parentEpoch: f.primeReceipt.epoch },
    boot: f.prime.boot,
    attachmentBytes: 0,
    reportBatch: batch,
    authorize: () => {
      requireNativeReportBatch(batch);
    },
    canDispatch: () => true,
  });
  try {
    expect(await f.receipts.collectReport(f.batch, factory, ready)).toMatchObject({
      metadataCommitted: true,
      wakeState: "collecting",
      duplicate: false,
    });
    expect(await f.receipts.dispatchNext(f.prime.agentId, () => true, vi.fn())).toBeNull();
    await f.request("events-ack", {
      sessionId: f.prime.agentId,
      eventId: f.events[0]!.id,
      note: "Read report metadata",
    });
    const nextEvent = { ...f.events[0]!, id: randomUUID(), kind: "needs-you" as const };
    const nextBatch = f.registry.captureReportBatch([nextEvent]);
    await f.receipts.collectReport(nextBatch, factory, ready);
    expect((await f.request()) as object).toMatchObject({
      wakePendingCount: 0,
      events: [
        { eventId: nextEvent.id, wakeState: "collecting", consumed: false },
        { eventId: f.events[0]!.id, wakeState: "collecting", consumed: true },
      ],
    });
    await vi.advanceTimersByTimeAsync(2000);
    await f.receipts.maintenance(() => {});
    expect(ready).toHaveBeenCalledTimes(1);
    const dispatch = vi.fn(async (input: NativeQueuedMessage, finalCheck: () => void) => {
      finalCheck();
      expect(requireNativeReportBatch(input.reportBatch!).data.members).toHaveLength(2);
      return "native-correlated-turn";
    });
    expect(await f.receipts.dispatchNext(f.prime.agentId, () => true, dispatch)).toMatchObject({
      state: "delivered",
      providerTurnId: "native-correlated-turn",
    });
    expect(await f.receipts.dispatchNext(f.prime.agentId, () => true, dispatch)).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await f.receipts.collectReport(nextBatch, factory, ready)).duplicate).toBe(true);
  } finally {
    vi.useRealTimers();
    await f.cleanup();
  }
});

test("native report collector: unsupported wake retains metadata without a native queued or delivered claim", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const ready = vi.fn();
  try {
    await f.receipts.collectReport(
      f.batch,
      (batch, messageId) => ({
        agentId: f.prime.agentId,
        messageId,
        boot: f.prime.boot,
        attachmentBytes: 0,
        principal: f.prime,
        request: "Metadata available",
        reportBatch: batch,
        authorize: () => {
          requireNativeReportBatch(batch);
        },
        canDispatch: () => false,
      }),
      ready,
    );
    await vi.advanceTimersByTimeAsync(2000);
    await f.receipts.maintenance(() => {});
    expect(ready).not.toHaveBeenCalled();
    expect(await f.request()).toMatchObject({
      wakePendingCount: 0,
      metadataCount: 1,
      events: [{ wakeState: "refused", providerAccepted: false }],
    });
    expect(await f.receipts.dispatchNext(f.prime.agentId, () => true, vi.fn())).toBeNull();
  } finally {
    vi.useRealTimers();
    await f.cleanup();
  }
});

test("native report credentials: actual owner issuance and scoped read/consume are separate from provider acceptance", async () => {
  const f = await fixture();
  try {
    expect(f.bridge).not.toHaveBeenCalled();
    expect((await f.admit()).state).toBe("queued");
    const result = (await f.request()) as {
      events: Array<{ eventId: string; providerAccepted: boolean; consumed: boolean }>;
      wakePendingCount: number;
    };
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: f.events[0]!.id,
      providerAccepted: false,
      consumed: false,
    });
    expect(result.wakePendingCount).toBe(1);
    expect(
      await f.request("events-ack", {
        sessionId: f.prime.agentId,
        eventId: f.events[0]!.id,
        note: "Consumed metadata; no completion acceptance",
      }),
    ).toEqual({ eventId: f.events[0]!.id, consumed: true });
    expect(JSON.stringify(await f.request())).not.toContain("completion acceptance");
    expect(f.bridge).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test("native report credentials: forged handles, action tokens, injected authority and every native action method refuse", async () => {
  const f = await fixture();
  try {
    expect(() => requireReportReader({ kind: "native-report-reader" })).toThrow();
    expect(() => requireNativeReportBatch({ kind: "native-report-batch" })).toThrow();
    await expect(f.request("manager-create", { sessionId: f.prime.agentId })).rejects.toThrow();
    const methods = [
      "report-prime-register",
      "report-prime-promote",
      "report-prime-demote",
      "report-project-transfer",
      "report-parent-adopt",
      "report-registration-revoke",
      "intercom-rate-settings-set",
      "intercom-receipt-maintenance",
      "session-takeover",
      "handback",
      "permission",
      "permissions-automatic",
      "roles-create-session",
    ];
    for (const method of methods) await expect(f.request(method)).rejects.toThrow();
    await expect(
      new NativeReportInbox(f.registry, f.receipts).request({
        method: "events-inbox",
        input: { sessionId: f.prime.agentId },
        capability: "a".repeat(43),
      }),
    ).rejects.toThrow();
    await expect(
      new NativeReportInbox(f.registry, f.receipts).request({
        method: "events-inbox",
        input: { sessionId: f.prime.agentId },
        capability: f.grant.capability,
        operator: "fixture-owner",
      }),
    ).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("native report credentials: reparent/revoke and same-instance native replacement fence reader and member admission", async () => {
  const f = await fixture();
  try {
    const reader = f.registry.authenticateReportReader(f.prime.agentId, f.grant.capability);
    const old = f.identities.get(f.child.agentId)!;
    f.identities.set(f.child.agentId, { ...old, sessionId: randomUUID() });
    await expect(f.admit()).rejects.toThrow();
    f.identities.set(f.child.agentId, old);
    await f.admit();
    await f.ownerCall("report-registration-revoke", {
      messageId: randomUUID(),
      identity: f.child,
      expectedEpoch: f.childReceipt.epoch,
    });
    expect(await f.request()).toMatchObject({ events: [] });
    await expect(
      f.request("events-ack", {
        sessionId: f.prime.agentId,
        eventId: f.events[0]!.id,
        note: "Cannot consume a revoked link",
      }),
    ).rejects.toThrow();
    await f.register(f.primeReceipt.epoch);
    expect(() => requireReportReader(reader)).toThrow();
    await expect(f.request()).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("native report journal: duplicate/conflict and restart keep membership atomic, old wake cancels without metadata delivery claim", async () => {
  const f = await fixture();
  try {
    await f.admit();
    expect((await f.admit()).state).toBe("queued");
    const second = f.registry.captureReportBatch(f.events);
    await expect(
      f.receipts.enqueue({
        agentId: f.prime.agentId,
        messageId: randomUUID(),
        request: "Other envelope",
        principal: { parent: f.prime },
        boot: f.prime.boot,
        attachmentBytes: 0,
        authorize: () => {},
        reportBatch: second,
      }),
    ).rejects.toThrow("already committed");
    const restored = new MessageReceipts(path.join(f.directory, "receipts"));
    const result = await new NativeReportInbox(f.registry, restored).request({
      method: "events-inbox",
      input: { sessionId: f.prime.agentId },
      capability: f.grant.capability,
    });
    expect(result).toMatchObject({
      wakePendingCount: 0,
      events: [{ wakeState: "cancelled", providerAccepted: false }],
    });
  } finally {
    await f.cleanup();
  }
});

test("native report wire: actual controller RPC endpoint inventory denies report credentials before every action/leadership route", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const child = {},
      fallback = vi.fn(async () => null);
    const channel = new ControllerChannel({
      child,
      issue: () => "unused",
      revoke: () => {},
      rpc: fallback,
      send: fallback,
      reports: (value) => new NativeReportInbox(f.registry, f.receipts).request(value),
    });
    const dispatch = rpc(
      {
        reportInbox: {
          request: async (frame: object) => {
            const reply = await channel.receive(child, {
              id: randomUUID(),
              epoch: channel.epoch,
              type: "report-inbox",
              frame,
            });
            if (!reply.ok) throw new Error("Native report refused");
            return reply.result;
          },
        },
      },
      "fixture-owner",
    );
    for (const method of RPC_METHODS) {
      if (method === "events-inbox" || method === "events-ack") continue;
      for (const operator of [undefined, "fixture-owner"]) {
        await expect(
          dispatch({
            method,
            input: { sessionId: f.prime.agentId },
            capability: f.grant.capability,
            ...(operator ? { operator } : {}),
          }),
        ).rejects.toThrow("Report credential");
      }
    }
    const result = await dispatch({
      method: "events-inbox",
      input: { sessionId: f.prime.agentId },
      capability: f.grant.capability,
    });
    expect(result).toMatchObject({
      events: [{ metadataCommitted: true, providerAccepted: false }],
    });
    await expect(
      dispatch({
        method: "events-ack",
        input: {
          sessionId: f.prime.agentId,
          eventId: f.events[0]!.id,
          note: "Report consumption only",
        },
        capability: f.grant.capability,
        operator: "fixture-owner",
      }),
    ).rejects.toThrow();
    expect(
      await dispatch({
        method: "events-ack",
        input: {
          sessionId: f.prime.agentId,
          eventId: f.events[0]!.id,
          note: "Report consumption only",
        },
        capability: f.grant.capability,
      }),
    ).toEqual({ eventId: f.events[0]!.id, consumed: true });
    expect(fallback).not.toHaveBeenCalled();
    channel.close();
    await expect(
      dispatch({
        method: "events-inbox",
        input: { sessionId: f.prime.agentId },
        capability: f.grant.capability,
      }),
    ).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("native report grant: validated private report file is inbox-only and separate from action grant directories", async () => {
  const f = await fixture();
  try {
    const env = {
      ORCA_INBOX_FILE: path.join(f.directory, "grants", "report", `${f.prime.agentId}.json`),
    };
    expect(readGrant(f.directory, "events-inbox", env).kind).toBe("report");
    expect(readGrant(f.directory, "events-ack", env).kind).toBe("report");
    for (const method of [
      "manager-create",
      "manager-workers",
      "channels-send",
      "bindings-self",
      "roles-send",
    ])
      expect(() => readGrant(f.directory, method, env)).toThrow();
    f.identities.set(f.prime.agentId, { ...f.prime, sessionId: randomUUID() });
    await expect(f.request()).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("native report journal: corrupt membership never becomes readable or replayable", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const directory = path.join(f.directory, "receipts");
    const files = await readdir(directory);
    const file = path.join(directory, files.find((name) => name.endsWith(".json"))!);
    const record = JSON.parse(await readFile(file, "utf8"));
    record.report.members[0].kind = "handoff";
    await writeFile(file, JSON.stringify(record), { mode: 0o600 });
    const restored = new MessageReceipts(directory);
    await expect(
      new NativeReportInbox(f.registry, restored).request({
        method: "events-inbox",
        input: { sessionId: f.prime.agentId },
        capability: f.grant.capability,
      }),
    ).rejects.toThrow("journal invalid");
    const dispatch = vi.fn(async () => "native-id");
    await expect(restored.dispatchNext(f.prime.agentId, () => true, dispatch)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

test("native report journal: actual owner revocation during private grant publication refuses return", async () => {
  const f = await fixture();
  const mkdir = fsPromises.mkdir;
  let release!: () => void, entered!: () => void;
  const at = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(fsPromises, "mkdir")
    .mockImplementation(async (...args: Parameters<typeof mkdir>) => {
      if (args[0] === path.join(f.directory, "grants", "report")) {
        entered();
        await held;
      }
      return mkdir(...args);
    });
  try {
    const work = f.register(f.primeReceipt.epoch);
    const failed = expect(work).rejects.toThrow("unauthorised");
    await at;
    f.revokeOwner();
    release();
    await failed;
    await expect(f.request()).rejects.toThrow();
  } finally {
    release();
    spy.mockRestore();
    await f.cleanup();
  }
});

test("native report journal: source replacement during member durability refuses metadata acceptance and dispatch", async () => {
  const f = await fixture();
  const mkdir = fsPromises.mkdir;
  let release!: () => void, entered!: () => void;
  const at = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(fsPromises, "mkdir")
    .mockImplementation(async (...args: Parameters<typeof mkdir>) => {
      if (args[0] === path.join(f.directory, "receipts")) {
        entered();
        await held;
      }
      return mkdir(...args);
    });
  try {
    const work = f.admit(),
      failed = expect(work).rejects.toThrow();
    await at;
    f.identities.set(f.child.agentId, { ...f.child, sessionId: randomUUID() });
    release();
    await failed;
    const dispatch = vi.fn(async () => "native-id");
    await expect(f.receipts.dispatchNext(f.prime.agentId, () => true, dispatch)).rejects.toThrow(
      "durability",
    );
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    release();
    spy.mockRestore();
    await f.cleanup();
  }
});

test("native report reservation: report members and one envelope share the action hard target cap and permanent ID ceiling", async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 31; n++)
      await f.receipts.enqueue({
        agentId: f.prime.agentId,
        messageId: randomUUID(),
        request: "Action fixture",
        principal: "fixture-action",
        boot: f.prime.boot,
        attachmentBytes: 0,
        authorize: () => {},
      });
    await expect(f.admit()).rejects.toThrow(
      /resource_limit|Native evidence shared resource refusal/,
    ); // member plus envelope need two tickets, not one.
    const bounded = new MessageReceipts(path.join(f.directory, "small"), Date.now, 1);
    await expect(
      bounded.enqueue({
        agentId: f.prime.agentId,
        messageId: f.messageId,
        request: "Report",
        principal: "fixture-report",
        boot: f.prime.boot,
        attachmentBytes: 0,
        authorize: () => {},
        reportBatch: f.batch,
      }),
    ).rejects.toThrow("maintenance");
  } finally {
    await f.cleanup();
  }
});

test("native report consumption: an acknowledgement waiting on provider outcome is preserved and is not native delivery", async () => {
  const f = await fixture();
  let release!: (value: string) => void;
  const accepted = new Promise<string>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const at = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await f.admit();
    const attempt = f.receipts.dispatchNext(
      f.prime.agentId,
      () => true,
      async (_ticket, finalCheck) => {
        finalCheck();
        entered();
        return accepted;
      },
    );
    await at;
    await f.request("events-ack", {
      sessionId: f.prime.agentId,
      eventId: f.events[0]!.id,
      note: "Observed metadata only",
    });
    expect(await f.request()).toMatchObject({
      events: [{ consumed: true, providerAccepted: false, wakeState: "dispatching" }],
    });
    release("fake-correlated-native-id");
    await attempt;
    expect(await f.request()).toMatchObject({
      events: [{ consumed: true, providerAccepted: true, wakeState: "delivered" }],
    });
  } finally {
    release?.("fake-correlated-native-id");
    await f.cleanup();
  }
});

test("native report publication: final owned-pipe write rechecks recipient and source after async handler return", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const { writeFrames } = await import("../../../../control/src/control/bounded-pipe.mjs");
    const child = {},
      fallback = vi.fn(async () => null);
    const channel = new ControllerChannel({
      child,
      issue: () => "unused",
      revoke: () => {},
      rpc: fallback,
      send: fallback,
      reports: (value) => new NativeReportInbox(f.registry, f.receipts).request(value),
    });
    const frame = {
      id: randomUUID(),
      epoch: channel.epoch,
      type: "report-inbox",
      frame: {
        method: "events-inbox",
        input: { sessionId: f.prime.agentId },
        capability: f.grant.capability,
      },
    };
    const reply = await channel.receive(child, frame);
    expect(reply.ok).toBe(true);
    const write = vi.fn((_packet: Buffer, done: (error: Error | null) => void) => {
      done(null);
      return true;
    });
    const onError = vi.fn();
    const output = writeFrames(
      { write },
      { maxBytes: 16384, onError, beforeWrite: (value) => channel.checkPublication(value) },
    );
    f.identities.set(f.child.agentId, { ...f.child, sessionId: randomUUID() });
    expect(() => output(reply)).toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    f.identities.set(f.child.agentId, f.child);
    expect(output(reply)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    f.identities.set(f.prime.agentId, { ...f.prime, instanceId: randomUUID() });
    expect(() => output(reply)).toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});

test("host creation inherits only an authenticated parent's scopes and cannot adopt existing identities", async () => {
  const f = await fixture();
  try {
    const { enrollNativeReportCreation } = await import("./report-origin.js");
    const child = {
      ...f.child,
      agentId: randomUUID(),
      instanceId: randomUUID(),
      sessionId: randomUUID(),
    };
    f.identities.set(child.agentId, child);
    let creatorLive = true;
    const creation = f.registry.captureCreation(f.prime, () => {
      if (!creatorLive) throw new Error("creator revoked");
    });
    await enrollNativeReportCreation(creation, child);
    expect(f.registry.requireParent(child, f.scope).parent).toEqual(f.prime);
    await expect(enrollNativeReportCreation(creation, child)).rejects.toThrow("Host-issued");
    await expect(enrollNativeReportCreation({ nativeReportCreation: true }, child)).rejects.toThrow(
      "Host-issued",
    );
    const stale = f.registry.captureCreation(f.prime, () => {
      if (!creatorLive) throw new Error("creator revoked");
    });
    creatorLive = false;
    await expect(enrollNativeReportCreation(stale, child)).rejects.toThrow("creator revoked");
    const replacement = { ...f.prime, sessionId: randomUUID() };
    f.identities.set(f.prime.agentId, replacement);
    expect(() => f.registry.captureCreation(f.prime, () => {})).toThrow("replaced");
  } finally {
    await f.cleanup();
  }
});

test("retired host final fact remains readable but cannot issue arbitrary new reports or survive reparent", async () => {
  const f = await fixture();
  try {
    const retirement = f.registry.captureRetirement(f.child);
    f.identities.delete(f.child.agentId);
    const batches = await retirement(() => {
      if (f.identities.has(f.child.agentId)) throw new Error("source reopened");
    });
    expect(batches).toHaveLength(1);
    const data = requireNativeReportBatch(batches[0]!).data;
    expect(data.members[0]).toMatchObject({
      kind: "ended",
      source: f.child,
      sourceEpoch: f.childReceipt.epoch,
    });
    expect(data.members[0]?.retirement).toBeTruthy();
    expect(() =>
      f.registry.captureLifecycleReports(f.child, "handoff", randomUUID(), Date.now()),
    ).toThrow("Retired");
    await f.receipts.enqueue({
      agentId: f.prime.agentId,
      messageId: randomUUID(),
      request: "Native metadata notice",
      principal: { parent: f.prime },
      boot: f.prime.boot,
      attachmentBytes: 0,
      reportBatch: batches[0],
      authorize: () => {
        requireNativeReportBatch(batches[0]!);
      },
    });
    expect(await f.request()).toMatchObject({
      metadataCount: 1,
      events: [{ kind: "ended", providerAccepted: false }],
    });
    await f.ownerCall("report-registration-revoke", {
      messageId: randomUUID(),
      identity: f.child,
      expectedEpoch: f.childReceipt.epoch,
    });
    expect(() => requireNativeReportBatch(batches[0]!)).toThrow("Frozen");
    expect(await f.request()).toMatchObject({ metadataCount: 0 });
    await expect(retirement(() => {})).rejects.toThrow("already attempted");
  } finally {
    await f.cleanup();
  }
});

test("native launch identity witnesses reject object spoof and never track replacement", async () => {
  const { createNativeReportOrigin, requireNativeReportOrigin } =
    await import("./report-origin.js");
  const identity = {
    agentId: randomUUID(),
    instanceId: randomUUID(),
    sessionId: randomUUID(),
    boot: randomUUID(),
  };
  let current = identity;
  const origin = createNativeReportOrigin(() => {
    if (current !== identity) throw new Error("launch replaced");
    return identity;
  });
  expect(requireNativeReportOrigin(origin)).toEqual(identity);
  expect(() => requireNativeReportOrigin({ nativeReportOrigin: true })).toThrow("Host-issued");
  current = { ...identity, sessionId: randomUUID() };
  expect(() => requireNativeReportOrigin(origin)).toThrow("launch replaced");
});

test("native self-relaunch preserves exact parent scope only once and rotates reader credentials", async () => {
  const f = await fixture();
  try {
    const permit = f.registry.captureRelaunch(
      f.prime,
      "host-exact-generation-boot-cursor-account-intent",
    );
    const next = { ...f.prime, instanceId: randomUUID() };
    f.identities.set(f.prime.agentId, next);
    let valid = true;
    const receipt = await permit(next, () => {
      if (!valid) throw new Error("intent revoked");
    });
    expect(receipt.current).toBe(true);
    await expect(f.request()).rejects.toThrow("credential");
    expect(f.registry.requireParent(f.child, f.scope).parent).toEqual(next);
    const grant = JSON.parse(
      await readFile(path.join(f.directory, "grants", "report", `${f.prime.agentId}.json`), "utf8"),
    );
    expect(grant.capability).not.toBe(f.grant.capability);
    await expect(permit(next, () => {})).rejects.toThrow("already attempted");
    expect(() => f.registry.captureRelaunch(next, "unmanaged")).toThrow("Authenticated");
    const bad = f.registry.captureRelaunch(next, "another-host-intent");
    const replaced = { ...next, instanceId: randomUUID(), sessionId: randomUUID() };
    f.identities.set(next.agentId, replaced);
    await expect(bad(replaced, () => {})).rejects.toThrow("Exact old/new");
    valid = false;
  } finally {
    await f.cleanup();
  }
});

test("native collector overflow is metadata-only in the same bounded membership journal and one wake", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const ready = vi.fn();
  const make = (batch: NativeReportBatch, messageId: string): NativeQueuedMessage => ({
    agentId: f.prime.agentId,
    messageId,
    request: "Native metadata available",
    principal: { parent: f.prime },
    boot: f.prime.boot,
    attachmentBytes: 0,
    reportBatch: batch,
    authorize: () => {
      requireNativeReportBatch(batch);
    },
    canDispatch: () => true,
  });
  try {
    const events = Array.from({ length: 9 }, (_, index) => ({
      ...f.events[0]!,
      id: randomUUID(),
      kind: index === 8 ? ("blocked" as const) : ("ended" as const),
    }));
    for (const event of events)
      await f.receipts.collectReport(f.registry.captureReportBatch([event]), make, ready);
    expect(await f.request()).toMatchObject({
      metadataCount: 9,
      overflowCount: 1,
      overflow: [{ count: 1, counts: { blocked: 1 }, providerAccepted: false }],
    });
    await vi.advanceTimersByTimeAsync(2000);
    await f.receipts.maintenance(() => {});
    expect(ready).toHaveBeenCalledTimes(1);
    const dispatch = vi.fn(async (_input: NativeQueuedMessage, check: () => void) => {
      check();
      return "native-id";
    });
    expect(await f.receipts.dispatchNext(f.prime.agentId, () => true, dispatch)).toMatchObject({
      state: "delivered",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      (await f.receipts.collectReport(f.registry.captureReportBatch([events[8]!]), make, ready))
        .duplicate,
    ).toBe(true);
    await f.request("events-ack", {
      sessionId: f.prime.agentId,
      eventId: events[8]!.id,
      note: "Consume scoped overflow metadata",
    });
    expect(await f.request()).toMatchObject({ overflowCount: 0 });
    for (const event of events.slice(0, 8))
      await f.request("events-ack", {
        sessionId: f.prime.agentId,
        eventId: event.id,
        note: "Consume scoped metadata",
      });
    const consumed = await f.request();
    expect(consumed).toMatchObject({ metadataCount: 8, overflowCount: 0 });
    expect(
      (consumed as { events: { consumed: boolean }[] }).events.every((event) => event.consumed),
    ).toBe(true);
    const before = await readdir(path.join(f.directory, "receipts"));
    const restart = new MessageReceipts(path.join(f.directory, "receipts"));
    expect((await restart.maintenance(() => {})).recordedIds).toBe(10);
    expect(await readdir(path.join(f.directory, "receipts"))).toEqual(before);
  } finally {
    vi.useRealTimers();
    await f.cleanup();
  }
});

test("native HTTP publication checks fresh origin and scoped receipt immediately before each response write", async () => {
  const {
    createNativeReportOrigin,
    forkNativeReportOrigin,
    rememberNativeReportPublication,
    checkNativeReportOriginPublication,
  } = await import("./report-origin.js");
  const { bindReportPublication } = await import("./report-publication.js");
  const identity = {
    agentId: randomUUID(),
    instanceId: randomUUID(),
    sessionId: randomUUID(),
    boot: randomUUID(),
  };
  let launchLive = true,
    scopeLive = true;
  const launch = createNativeReportOrigin(() => {
    if (!launchLive) throw Error("launch revoked");
    return identity;
  });
  const first = forkNativeReportOrigin(launch),
    second = forkNativeReportOrigin(launch);
  const result = bindReportPublication({ metadataCount: 1 }, () => {
    if (!scopeLive) throw Error("scope revoked");
  });
  rememberNativeReportPublication(first, result);
  const writes = vi.fn();
  const write = (origin: typeof first) => {
    checkNativeReportOriginPublication(origin);
    return writes();
  };
  await Promise.resolve();
  scopeLive = false;
  expect(() => write(first)).toThrow("scope revoked");
  expect(writes).not.toHaveBeenCalled();
  write(second); // One request cannot overwrite another request's publication guard.
  scopeLive = true;
  write(first);
  launchLive = false;
  expect(() => write(second)).toThrow("launch revoked");
  expect(writes).toHaveBeenCalledTimes(2);
});

async function multiPrimeFixture() {
  const f = await fixture();
  const makeIdentity = () => ({
    ...f.prime,
    agentId: randomUUID(),
    instanceId: randomUUID(),
    sessionId: randomUUID(),
  });
  const primeY = makeIdentity(),
    orchestrator = makeIdentity(),
    worker = makeIdentity();
  for (const identity of [primeY, orchestrator, worker])
    f.identities.set(identity.agentId, identity);
  const scopeY = { projectId: randomUUID(), taskId: randomUUID() };
  const y = (await f.ownerCall("report-prime-register", {
    messageId: randomUUID(),
    identity: primeY,
    scopes: [scopeY, f.scope],
    expectedEpoch: null,
  })) as { epoch: string };
  const o = (await f.ownerCall("report-parent-adopt", {
    messageId: randomUUID(),
    child: orchestrator,
    parent: f.prime,
    scopes: [f.scope],
    expectedEpoch: null,
  })) as { epoch: string };
  const w = (await f.ownerCall("report-parent-adopt", {
    messageId: randomUUID(),
    child: worker,
    parent: orchestrator,
    scopes: [f.scope],
    expectedEpoch: null,
  })) as { epoch: string };
  const xOwner = (await f.ownerCall("report-project-transfer", {
    messageId: randomUUID(),
    projectId: f.scope.projectId,
    from: null,
    expectedFromEpoch: null,
    to: f.prime,
    expectedToEpoch: f.primeReceipt.epoch,
    expectedOwnerEpoch: null,
  })) as { epoch: string };
  const yOwner = (await f.ownerCall("report-project-transfer", {
    messageId: randomUUID(),
    projectId: scopeY.projectId,
    from: null,
    expectedFromEpoch: null,
    to: primeY,
    expectedToEpoch: y.epoch,
    expectedOwnerEpoch: null,
  })) as { epoch: string };
  const collect = async (
    source = worker,
    kind = "ended" as "ended" | "needs-you" | "blocked" | "usage-limit" | "handoff",
  ) => {
    const batches = f.registry.captureLifecycleReports(source, kind, randomUUID(), Date.now());
    for (const batch of batches) {
      const data = requireNativeReportBatch(batch).data;
      await f.receipts.enqueue({
        agentId: data.parent.agentId,
        messageId: randomUUID(),
        request: "Native scoped report metadata available.",
        principal: { parent: data.parent, parentEpoch: data.parentEpoch },
        boot: data.parent.boot,
        attachmentBytes: 0,
        authorize: () => {
          requireNativeReportBatch(batch);
        },
        reportBatch: batch,
      });
    }
    return batches;
  };
  const read = async (identity = f.prime) =>
    f.receipts.reportInbox(f.registry.readerForNativeIdentity(identity)) as Promise<{
      events: { kind: string; routing?: string }[];
    }>;
  return { ...f, primeY, orchestrator, worker, scopeY, y, o, w, xOwner, yOwner, collect, read };
}

test("multi-prime: exact parent detail/recorded owning-prime rollup, no other-prime leak, direct-child dedup", async () => {
  const f = await multiPrimeFixture();
  try {
    for (const kind of ["ended", "needs-you", "blocked", "usage-limit", "handoff"] as const)
      expect(await f.collect(f.worker, kind)).toHaveLength(2);
    expect((await f.read(f.orchestrator)).events).toHaveLength(5);
    expect((await f.read()).events.every((event) => event.routing === "owning-prime-rollup")).toBe(
      true,
    );
    expect((await f.read(f.primeY)).events).toEqual([]);
    expect(await f.collect(f.child)).toHaveLength(1);
    expect((await f.read()).events.some((event) => !event.routing)).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("multi-prime: atomic transfer retains children, fences pending/old credentials and never retargets committed receipts", async () => {
  const f = await multiPrimeFixture();
  try {
    await f.collect();
    const before = f.registry.readerForNativeIdentity(f.orchestrator);
    const captured = f.registry.captureLifecycleReports(
      f.worker,
      "blocked",
      randomUUID(),
      Date.now(),
    );
    const transfer = {
      messageId: randomUUID(),
      projectId: f.scope.projectId,
      from: f.prime,
      expectedFromEpoch: f.primeReceipt.epoch,
      to: f.primeY,
      expectedToEpoch: f.y.epoch,
      expectedOwnerEpoch: f.xOwner.epoch,
    };
    const result = await f.ownerCall("report-project-transfer", transfer);
    expect(result).toMatchObject({
      pendingDisposition: "fenced-retained-no-retarget",
      current: true,
    });
    expect(() => requireReportReader(before)).toThrow();
    expect(() => requireNativeReportBatch(captured[0]!)).toThrow();
    expect((await f.read()).events).toEqual([]);
    expect((await f.read(f.primeY)).events).toEqual([]);
    const relation = f.registry.requireParent(f.worker, f.scope);
    expect(relation.parent).toEqual(f.orchestrator);
    expect(f.registry.requireParent(f.orchestrator, f.scope).parent).toEqual(f.primeY);
    await f.collect();
    expect((await f.read(f.primeY)).events).toHaveLength(1);
    expect((await f.read()).events).toEqual([]);
    await expect(
      f.ownerCall("report-project-transfer", { ...transfer, messageId: randomUUID() }),
    ).rejects.toThrow();
    expect(await f.ownerCall("report-project-transfer", transfer)).toMatchObject({
      duplicate: true,
    });
  } finally {
    await f.cleanup();
  }
});

test("multi-prime: owner promotion/demotion preserves children, upward dispositions and receive-only epochs", async () => {
  const f = await multiPrimeFixture();
  try {
    const old = f.registry.readerForNativeIdentity(f.orchestrator);
    const promoted = (await f.ownerCall("report-prime-promote", {
      messageId: randomUUID(),
      identity: f.orchestrator,
      expectedEpoch: f.o.epoch,
      scopes: [f.scope],
      projects: [{ projectId: f.scope.projectId, expectedOwnerEpoch: f.xOwner.epoch }],
    })) as { epoch: string };
    expect(() => requireReportReader(old)).toThrow();
    expect(f.registry.requireParent(f.worker, f.scope).parent).toEqual(f.orchestrator);
    expect(await f.collect()).toHaveLength(1);
    const reader = f.registry.readerForNativeIdentity(f.orchestrator);
    // Native report identities contain no action humanAt/generation cursor. Ordinary action takeover is separate.
    expect(requireReportReader(reader).identity).toEqual(f.orchestrator);
    await expect(
      f.ownerCall("report-prime-demote", {
        messageId: randomUUID(),
        identity: f.orchestrator,
        expectedEpoch: promoted.epoch,
        parent: f.worker,
        expectedParentEpoch: promoted.epoch,
        projects: [{ projectId: f.scope.projectId, expectedOwnerEpoch: promoted.epoch }],
      }),
    ).rejects.toThrow();
    await f.ownerCall("report-prime-demote", {
      messageId: randomUUID(),
      identity: f.orchestrator,
      expectedEpoch: promoted.epoch,
      parent: f.prime,
      expectedParentEpoch: f.primeReceipt.epoch,
      projects: [{ projectId: f.scope.projectId, expectedOwnerEpoch: promoted.epoch }],
    });
    expect(() => requireReportReader(reader)).toThrow();
    expect(f.registry.requireParent(f.worker, f.scope).parent).toEqual(f.prime);
    expect(f.registry.requireParent(f.orchestrator, f.scope).parent).toEqual(f.prime);
    expect(await f.collect()).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

for (const mutation of ["owner-revoke", "source-replace", "recipient-replace"] as const) {
  test(`multi-prime: ${mutation} during held transfer write refuses fresh publication`, async () => {
    const f = await multiPrimeFixture();
    let release!: () => void;
    try {
      const mkdir = fsPromises.mkdir.bind(fsPromises);
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = vi
        .spyOn(fsPromises, "mkdir")
        .mockImplementation(async (...args: Parameters<typeof mkdir>) => {
          entered();
          await held;
          return mkdir(...args);
        });
      const result = f.ownerCall("report-project-transfer", {
        messageId: randomUUID(),
        projectId: f.scope.projectId,
        from: f.prime,
        expectedFromEpoch: f.primeReceipt.epoch,
        to: f.primeY,
        expectedToEpoch: f.y.epoch,
        expectedOwnerEpoch: f.xOwner.epoch,
      });
      await waiting;
      if (mutation === "owner-revoke") f.revokeOwner();
      if (mutation === "source-replace")
        f.identities.set(f.worker.agentId, { ...f.worker, sessionId: randomUUID() });
      if (mutation === "recipient-replace")
        f.identities.set(f.primeY.agentId, { ...f.primeY, instanceId: randomUUID() });
      release();
      await expect(result).rejects.toThrow();
      spy.mockRestore();
      expect(() =>
        f.registry.captureLifecycleReports(f.worker, "ended", randomUUID(), Date.now()),
      ).toThrow();
    } finally {
      release?.();
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });
}

test("multi-prime: unlimited roles within encoded/operation bounds, legacy migration/restart and explicit project scope refusal", async () => {
  const f = await multiPrimeFixture();
  try {
    for (let index = 0; index < 18; index++) {
      const identity = {
        ...f.prime,
        agentId: randomUUID(),
        instanceId: randomUUID(),
        sessionId: randomUUID(),
      };
      f.identities.set(identity.agentId, identity);
      await f.ownerCall("report-prime-register", {
        messageId: randomUUID(),
        identity,
        scopes: [f.scope],
        expectedEpoch: null,
      });
    }
    const saved = JSON.parse(await readFile(path.join(f.directory, "authority.json"), "utf8"));
    expect(saved.primes.length).toBe(20);
    const restarted = new NativeReportRegistry(
      path.join(f.directory, "authority.json"),
      (id) => f.identities.get(id) ?? null,
    );
    await restarted.ownerStatus(f.prime, () => {});
    expect(
      restarted.captureLifecycleReports(f.worker, "ended", randomUUID(), Date.now()),
    ).toHaveLength(2);
    await expect(
      f.ownerCall("report-parent-adopt", {
        messageId: randomUUID(),
        child: f.worker,
        parent: f.primeY,
        scopes: [f.scope],
        expectedEpoch: f.w.epoch,
      }),
    ).rejects.toThrow("Cross-project");
    expect(f.registry.requireParent(f.worker, f.scope).parent).toEqual(f.orchestrator);
  } finally {
    await f.cleanup();
  }
});

test("multi-prime: frozen retired source yields parent detail and owning-prime rollup once, never new reports", async () => {
  const f = await multiPrimeFixture();
  try {
    const retire = f.registry.captureRetirement(f.worker);
    f.identities.delete(f.worker.agentId);
    const batches = await retire(() => {
      if (f.identities.has(f.worker.agentId)) throw new Error("not closed");
    });
    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      const data = requireNativeReportBatch(batch).data;
      await f.receipts.enqueue({
        agentId: data.parent.agentId,
        messageId: randomUUID(),
        request: "Frozen native lifecycle metadata available.",
        principal: { parent: data.parent, parentEpoch: data.parentEpoch },
        boot: data.parent.boot,
        attachmentBytes: 0,
        authorize: () => {
          requireNativeReportBatch(batch);
        },
        reportBatch: batch,
      });
    }
    expect((await f.read()).events).toMatchObject([
      { kind: "ended", routing: "owning-prime-rollup" },
    ]);
    expect((await f.read(f.orchestrator)).events).toMatchObject([{ kind: "ended" }]);
    expect((await f.read(f.primeY)).events).toEqual([]);
    expect(() =>
      f.registry.captureLifecycleReports(f.worker, "ended", randomUUID(), Date.now()),
    ).toThrow();
    await expect(retire(() => {})).rejects.toThrow("already attempted");
  } finally {
    await f.cleanup();
  }
});

test("multi-prime: native lifecycle permanent identity cannot replay after ownership transfer, including legacy receipt IDs", async () => {
  const f = await multiPrimeFixture();
  try {
    const lifecycleId = randomUUID(),
      at = Date.now();
    const makeInput = (batch: NativeReportBatch, messageId: string): NativeQueuedMessage => {
      const data = requireNativeReportBatch(batch).data;
      return {
        agentId: data.parent.agentId,
        messageId,
        request: "Native lifecycle metadata available.",
        principal: { parent: data.parent, parentEpoch: data.parentEpoch },
        boot: data.parent.boot,
        attachmentBytes: 0,
        authorize: () => {
          requireNativeReportBatch(batch);
        },
        reportBatch: batch,
      };
    };
    const first = f.registry.captureLifecycleReports(f.worker, "blocked", lifecycleId, at);
    for (const batch of first) await f.receipts.collectReport(batch, makeInput, () => {});
    const firstIds = first.map((batch) => requireNativeReportBatch(batch).data.members[0]!.id);
    await f.ownerCall("report-project-transfer", {
      messageId: randomUUID(),
      projectId: f.scope.projectId,
      from: f.prime,
      expectedFromEpoch: f.primeReceipt.epoch,
      to: f.primeY,
      expectedToEpoch: f.y.epoch,
      expectedOwnerEpoch: f.xOwner.epoch,
    });
    const next = f.registry.captureLifecycleReports(f.worker, "blocked", lifecycleId, at);
    expect(next.map((batch) => requireNativeReportBatch(batch).data.members[0]!.id)).toEqual(
      firstIds,
    );
    for (const batch of next)
      await expect(f.receipts.collectReport(batch, makeInput, () => {})).rejects.toThrow(
        "identity conflict",
      );
    expect((await f.read(f.primeY)).events).toEqual([]);
    const { sameNativeReportEvent } = await import("./report-batch.js");
    const member = requireNativeReportBatch(next[0]!).data.members[0]!;
    const { createHash } = await import("node:crypto");
    const { canonicalJson } = await import("@getpaseo/protocol/trusted-input");
    const hex = createHash("sha256")
      .update(
        canonicalJson({
          source: member.source,
          epoch: f.w.epoch,
          kind: member.kind,
          lifecycleId,
          scope: member.scope,
        }),
      )
      .digest("hex");
    const legacy = {
      ...member,
      id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
      sourceEpoch: f.w.epoch,
    };
    delete legacy.origin;
    expect(sameNativeReportEvent(legacy, member)).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("multi-prime R25-L1: same fact cannot return to same recipient through a new route", async () => {
  const f = await multiPrimeFixture();
  try {
    const lifecycleId = randomUUID(),
      at = Date.now();
    const makeInput = (batch: NativeReportBatch, messageId: string): NativeQueuedMessage => {
      const data = requireNativeReportBatch(batch).data;
      return {
        agentId: data.parent.agentId,
        messageId,
        request: "Native lifecycle metadata available.",
        principal: { parent: data.parent, parentEpoch: data.parentEpoch },
        boot: data.parent.boot,
        attachmentBytes: 0,
        authorize: () => {
          requireNativeReportBatch(batch);
        },
        reportBatch: batch,
      };
    };
    const original = f.registry.captureLifecycleReports(f.child, "blocked", lifecycleId, at);
    expect(original).toHaveLength(1);
    const detail = requireNativeReportBatch(original[0]!).data.members[0]!;
    await f.receipts.collectReport(original[0]!, makeInput, () => {});
    await f.ownerCall("report-parent-adopt", {
      messageId: randomUUID(),
      child: f.child,
      parent: f.orchestrator,
      scopes: [f.scope],
      expectedEpoch: f.childReceipt.epoch,
    });
    const recaptured = f.registry.captureLifecycleReports(f.child, "blocked", lifecycleId, at);
    expect(recaptured).toHaveLength(2);
    const { sameNativeReportEvent } = await import("./report-batch.js");
    const { createHash } = await import("node:crypto");
    const { canonicalJson } = await import("@getpaseo/protocol/trusted-input");
    const rollup = requireNativeReportBatch(recaptured[1]!).data.members[0]!;
    const hex = createHash("sha256")
      .update(
        canonicalJson({
          source: detail.source,
          epoch: detail.sourceEpoch,
          kind: detail.kind,
          lifecycleId,
          scope: detail.scope,
        }),
      )
      .digest("hex");
    const legacy = {
      ...detail,
      id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
    };
    delete legacy.origin;
    expect(sameNativeReportEvent(legacy, rollup, true)).toBe(true);
    expect(sameNativeReportEvent(legacy, rollup)).toBe(false);
    // Independent manager catches must not let the second membership bypass the first refusal.
    for (const batch of recaptured)
      await expect(f.receipts.collectReport(batch, makeInput, () => {})).rejects.toThrow(
        "identity conflict",
      );
    expect((await f.read()).events).toEqual([]);
    expect((await f.read(f.orchestrator)).events).toEqual([]);
    // A new native fact still legitimately reaches its two distinct recipients.
    const fresh = f.registry.captureLifecycleReports(f.worker, "blocked", randomUUID(), Date.now());
    expect(fresh).toHaveLength(2);
    for (const batch of fresh) await f.receipts.collectReport(batch, makeInput, () => {});
    expect((await f.read()).events).toMatchObject([
      { kind: "blocked", routing: "owning-prime-rollup" },
    ]);
    expect((await f.read(f.orchestrator)).events).toMatchObject([{ kind: "blocked" }]);
  } finally {
    await f.cleanup();
  }
});
