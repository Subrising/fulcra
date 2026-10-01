import { bundledTarget } from "./test-utils/management.js";
import { expect, test, vi } from "vitest";
import { ManagementAuthority } from "./management.js";
import { OWNER_PERMISSIONS, type DaemonPermission } from "../authorization/index.js";
import { createManagementContext } from "./plugin-management-context.js";

const command = { method: "list", input: null } as const;
function fixture() {
  const dispatch = vi.fn(async () => null);
  const authority = new ManagementAuthority({ enabled: () => true, validate: (c) => c });
  authority.register("orca-organization-next", dispatch);
  let permissions = OWNER_PERMISSIONS;
  let authenticated = true;
  const open = () =>
    authority.open(bundledTarget, () =>
      authenticated
        ? {
            id: "owner",
            authentication: "daemon-password",
            deviceId: null,
            permissions,
          }
        : undefined,
    );
  return {
    authority,
    dispatch,
    open,
    revoke: () => {
      permissions = [];
    },
    anonymous: () => {
      authenticated = false;
    },
  };
}

test("P6 password-disabled loopback and underprivileged owners have no context", () => {
  const f = fixture();
  f.anonymous();
  expect(f.open()).toBeUndefined();
  const g = fixture();
  g.revoke();
  expect(g.open()).toBeUndefined();
});
test("P6 owner dispatch, one-use call IDs, forged principal and settlement", async () => {
  const f = fixture();
  const invocation = f.open()!;
  await f.authority.invoke(invocation.id, "orca-organization-next", "call", command);
  expect(f.dispatch).toHaveBeenCalledWith(command, expect.objectContaining({ id: "owner" }));
  await expect(
    f.authority.invoke(invocation.id, "orca-organization-next", "call", command),
  ).rejects.toThrow();
  await expect(
    f.authority.invoke(invocation.id, "orca-organization-next", "forged", {
      ...command,
      principal: { id: "owner" },
    }),
  ).rejects.toThrow();
  invocation.close();
  await expect(
    f.authority.invoke(invocation.id, "orca-organization-next", "late", command),
  ).rejects.toThrow();
  const foreign = f.open()!;
  await expect(f.authority.invoke(foreign.id, "other", "foreign", command)).rejects.toThrow();
});
test("P6 live revocation, 32 calls and 30-second deadline", async () => {
  const f = fixture();
  const invocation = f.open()!;
  for (let i = 0; i < 32; i++)
    await f.authority.invoke(invocation.id, "orca-organization-next", String(i), command);
  await expect(
    f.authority.invoke(invocation.id, "orca-organization-next", "33", command),
  ).rejects.toThrow();
  const second = f.open()!;
  f.revoke();
  await expect(
    f.authority.invoke(second.id, "orca-organization-next", "revoked", command),
  ).rejects.toThrow();
  const g = fixture();
  const third = g.open()!;
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
  try {
    await expect(
      g.authority.invoke(third.id, "orca-organization-next", "expired", command),
    ).rejects.toThrow();
  } finally {
    clock.mockRestore();
  }
  expect(g.dispatch).not.toHaveBeenCalled();
});
test("P6 shutdown revokes outstanding invocations", async () => {
  const f = fixture();
  const invocation = f.open()!;
  f.authority.close();
  await expect(
    f.authority.invoke(invocation.id, "orca-organization-next", "closed", command),
  ).rejects.toThrow();
});

test("P6 a changed command burns its one-use digest capability before dispatch", async () => {
  const { createHash } = await import("node:crypto");
  const { canonicalJson } = await import("@getpaseo/protocol/trusted-input");
  const f = fixture();
  const invocation = f.open()!;
  const capabilities = Reflect.get(f.authority, "capabilities") as Map<string, unknown>;
  capabilities.set("fixture-capability", {
    invocation: invocation.id,
    digest: createHash("sha256").update(canonicalJson(command)).digest("hex"),
  });
  const consume = (value: unknown) =>
    Reflect.get(f.authority, "consume").call(
      f.authority,
      "fixture-capability",
      invocation.id,
      "orca-organization-next",
      value,
    );
  expect(() => consume({ method: "list", input: { changed: true } })).toThrow();
  expect(() => consume(command)).toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
});

test("P6 failed trusted setup cannot leave a registered management bridge usable", async () => {
  const { TrustedPlugins } = await import("./trusted.js");
  const host = new TrustedPlugins({ enabled: () => true, validate: (candidate) => candidate });
  host.initializeKnownAgents([]);
  const bridge = async () => null;
  expect(() =>
    host.registerV11("orca-organization-next", true, (sdk) => {
      sdk.managementBridge.register(bridge);
      throw new Error("setup failed");
    }),
  ).toThrow("setup failed");
  expect(
    host.management.open(bundledTarget, () => ({
      id: "owner",
      authentication: "daemon-password",
      deviceId: null,
      permissions: OWNER_PERMISSIONS,
    })),
  ).toBeUndefined();
  host.close();
});

test("throwing readiness disables management without failing ordinary RPC", () => {
  const authority = new ManagementAuthority({
    enabled: () => {
      throw new Error("not ready");
    },
    validate: (c) => c,
  });
  authority.register("orca-organization-next", async () => null);
  expect(() =>
    authority.open(bundledTarget, () => ({
      id: "owner",
      authentication: "daemon-password",
      deviceId: null,
      permissions: OWNER_PERMISSIONS,
    })),
  ).not.toThrow();
  expect(
    authority.open(bundledTarget, () => ({
      id: "owner",
      authentication: "daemon-password",
      deviceId: null,
      permissions: OWNER_PERMISSIONS,
    })),
  ).toBeUndefined();
});

test("D13: read-only management opens only for a paired read principal with a read classifier, and runs reads only", async () => {
  const dispatch = vi.fn(async () => ({ ok: true }));
  const withReads = new ManagementAuthority({
    enabled: () => true,
    validate: (c) => c,
    isRead: (c) => c.method === "list",
  });
  withReads.register("orca-organization-next", dispatch);
  const reader = {
    id: "device:dev_1",
    authentication: "paired-device" as const,
    deviceId: "dev_1",
    permissions: ["daemon.read", "workspace.read"] as DaemonPermission[],
  };
  expect(withReads.open(bundledTarget, () => reader)).toBeUndefined(); // not as full management
  const read = withReads.open(bundledTarget, () => reader, { readOnly: true })!;
  expect(read).toBeDefined();
  // B3: the invocation says it is read-only, and the plugin's own management context carries that, so the plugin
  // refuses writes itself too (defence in depth); a full invocation carries nothing.
  expect(read.readOnly).toBe(true);
  const principal = read.principal;
  expect(
    createManagementContext({ invocationId: read.id, principal, readOnly: true }, async () => null)
      .context.readOnly,
  ).toBe(true);
  expect(
    "readOnly" in
      createManagementContext({ invocationId: read.id, principal }, async () => null).context,
  ).toBe(false);
  await expect(read.invoke("c1", { method: "list", input: null })).resolves.toEqual({ ok: true });
  await expect(read.invoke("c2", { method: "create", input: null })).rejects.toThrow(
    "This device can only read Command Centre",
  );
  expect(dispatch).toHaveBeenCalledTimes(1);
  // No classifier (an older distribution): no read-only management at all.
  const older = new ManagementAuthority({ enabled: () => true, validate: (c) => c });
  older.register("orca-organization-next", dispatch);
  expect(older.open(bundledTarget, () => reader, { readOnly: true })).toBeUndefined();
  // A password principal is not a read device; a device missing workspace.read is refused.
  expect(
    withReads.open(
      bundledTarget,
      () => ({ ...reader, authentication: "daemon-password" as const, deviceId: null }),
      { readOnly: true },
    ),
  ).toBeUndefined();
  expect(
    withReads.open(
      bundledTarget,
      () => ({ ...reader, permissions: ["daemon.read"] as DaemonPermission[] }),
      {
        readOnly: true,
      },
    ),
  ).toBeUndefined();
});

// ---- U7: accounts.manage -------------------------------------------------------------------------------------
function accountsFixture() {
  const recorded: unknown[] = [];
  const authority = new ManagementAuthority(
    { enabled: () => true, validate: (c) => c, isRead: (c) => c.method === "list" },
    { accountActions: { record: (entry) => void recorded.push(entry) } },
  );
  authority.register(
    "orca-organization-next",
    vi.fn(async () => ({ ok: true })),
  );
  const device = (permissions: DaemonPermission[]) => ({
    id: "device:dev_phone",
    authentication: "paired-device" as const,
    deviceId: "dev_phone",
    permissions,
  });
  const FULL: DaemonPermission[] = [
    "daemon.read",
    "daemon.manage",
    "workspace.read",
    "command-centre.manage",
  ];
  return { authority, recorded, device, FULL };
}
const contextFor = (invocation: NonNullable<ReturnType<ManagementAuthority["open"]>>) =>
  createManagementContext(
    {
      invocationId: invocation.id,
      principal: invocation.principal,
      ...(invocation.readOnly ? { readOnly: true } : {}),
      ...(invocation.accountsManage ? { accountsManage: true } : {}),
    },
    async () => null,
    async (_id, entry) => invocation.recordAccountAction(entry),
  ).context;

test("accounts-manage: local owner still works", async () => {
  const { authority, recorded } = accountsFixture();
  const owner = authority.open(bundledTarget, () => ({
    id: "owner",
    authentication: "daemon-password",
    deviceId: null,
    permissions: OWNER_PERMISSIONS,
  }))!;
  expect(owner.accountsManage).toBe(true);
  const context = contextFor(owner);
  expect(context.accountsManage).toBe(true);
  // The owner's own moves are not remote: nothing is audited.
  await expect(
    context.recordAccountAction({ action: "switch", accountLabel: "Work" }),
  ).resolves.toEqual({
    recorded: false,
  });
  expect(recorded).toEqual([]);
});

test("accounts-manage: device WITH capability can switch / set default / take over", async () => {
  const { authority, recorded, device, FULL } = accountsFixture();
  const invocation = authority.open(bundledTarget, () => device([...FULL, "accounts.manage"]))!;
  expect(invocation.accountsManage).toBe(true);
  const context = contextFor(invocation);
  expect(context.accountsManage).toBe(true);
  for (const action of ["switch", "set-default", "takeover"] as const)
    await expect(
      context.recordAccountAction({ action, accountLabel: "Personal" }),
    ).resolves.toEqual({
      recorded: true,
    });
  expect(recorded).toHaveLength(3);
});

test("accounts-manage: full-management device WITHOUT capability is refused", async () => {
  const { authority, recorded, device, FULL } = accountsFixture();
  const invocation = authority.open(bundledTarget, () => device(FULL))!;
  expect(invocation).toBeDefined(); // Command Centre management still opens
  expect(invocation.accountsManage).toBe(false);
  const context = contextFor(invocation);
  expect("accountsManage" in context).toBe(false);
  await expect(
    context.recordAccountAction({ action: "switch", accountLabel: "Work" }),
  ).rejects.toThrow("This device may not manage accounts");
  expect(recorded).toEqual([]);
});

test("accounts-manage: read-tier (D13) device is refused", async () => {
  const { authority, device } = accountsFixture();
  // Even a read principal that somehow carried accounts.manage gets no account management on the read tier.
  const read = authority.open(
    bundledTarget,
    () => device(["daemon.read", "workspace.read", "accounts.manage"]),
    { readOnly: true },
  )!;
  expect(read.readOnly).toBe(true);
  expect(read.accountsManage).toBe(false);
  await expect(
    read.recordAccountAction({ action: "switch", accountLabel: "Work" }),
  ).rejects.toThrow("This device may not manage accounts");
});

test("accounts-manage: same device after revoke is refused", async () => {
  const { authority, device, FULL } = accountsFixture();
  let permissions: DaemonPermission[] = [...FULL, "accounts.manage"];
  const invocation = authority.open(bundledTarget, () => device(permissions))!;
  expect(invocation.accountsManage).toBe(true);
  permissions = FULL; // the owner revoked accounts.manage: checked live, not from the opening snapshot
  await expect(
    invocation.recordAccountAction({ action: "switch", accountLabel: "Work" }),
  ).rejects.toThrow("This device may not manage accounts");
  expect(authority.open(bundledTarget, () => device(permissions))!.accountsManage).toBe(false);
});

test("accounts-manage: every remote action is audited (device, action, label, time)", async () => {
  const { authority, recorded, device, FULL } = accountsFixture();
  const invocation = authority.open(bundledTarget, () => device([...FULL, "accounts.manage"]))!;
  await invocation.recordAccountAction({ action: "takeover", accountLabel: "Claude Max (work)" });
  expect(recorded).toEqual([
    {
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      deviceId: "dev_phone",
      action: "takeover",
      accountLabel: "Claude Max (work)",
    },
  ]);
  // The plugin names neither the device nor the time, and cannot add fields.
  await expect(
    invocation.recordAccountAction({
      action: "switch",
      accountLabel: "Work",
      deviceId: "dev_other",
    } as never),
  ).rejects.toThrow("Invalid account action");
  await expect(
    invocation.recordAccountAction({ action: "delete-everything", accountLabel: "x" } as never),
  ).rejects.toThrow("Invalid account action");
});

test("accounts-manage: no credential material in any response or event to a remote client (audit labels)", async () => {
  const { authority, recorded, device, FULL } = accountsFixture();
  const invocation = authority.open(bundledTarget, () => device([...FULL, "accounts.manage"]))!;
  for (const accountLabel of [
    "sk-ant-oat01-CANARYCANARYCANARYCANARY",
    "ghp_CANARYCANARYCANARYCANARY0000",
    'auth.json {"access_token":"x"}',
  ])
    await expect(invocation.recordAccountAction({ action: "add", accountLabel })).rejects.toThrow(
      "Invalid account action",
    );
  expect(JSON.stringify(recorded)).not.toMatch(/CANARY|access_token/);
});

test("account continuation rechecks accounts.manage after invocation opens; handback remains available", async () => {
  const { authority, device, FULL } = accountsFixture();
  let permissions: DaemonPermission[] = [...FULL, "accounts.manage"];
  const invocation = authority.open(bundledTarget, () => device(permissions))!;
  const continuation = {
    method: "session-takeover",
    input: { session: "chat", accountId: "pooled" },
  };
  await expect(invocation.invoke("continue", continuation)).resolves.toEqual({ ok: true });
  permissions = FULL;
  await expect(invocation.invoke("revoked", continuation)).rejects.toThrow(
    "This device may not manage accounts",
  );
  await expect(
    invocation.invoke("handback", {
      method: "takeover",
      input: { sessionId: "chat", reason: "Owner handback" },
    }),
  ).resolves.toEqual({ ok: true });
  const read = authority.open(
    bundledTarget,
    () => device(["daemon.read", "workspace.read", "accounts.manage"]),
    { readOnly: true },
  )!;
  await expect(read.invoke("read", continuation)).rejects.toThrow();
});

function ownerReportFixture(
  authentication: "daemon-password" | "paired-device" | "protected-local-ipc" = "daemon-password",
) {
  const authority = new ManagementAuthority({
    enabled: () => true,
    validate: (c) => c,
    isRead: () => true,
  });
  const generic = vi.fn(async () => null);
  authority.register("orca-organization-next", generic);
  let current:
    | import("@getpaseo/protocol/controller-management").ManagementPrincipalV11
    | undefined = {
    id: "owner",
    authentication,
    deviceId: authentication === "paired-device" ? "paired" : null,
    permissions: OWNER_PERMISSIONS,
  };
  const open = () => authority.open(bundledTarget, () => current);
  return {
    authority,
    generic,
    open,
    revoke: () => {
      current = undefined;
    },
  };
}

test("report owner seam: every privileged report/rate operation requires verified owner, not paired action grants", async () => {
  const methods = [
    "report-prime-register",
    "report-parent-adopt",
    "report-registration-revoke",
    "intercom-rate-settings-set",
    "intercom-receipt-maintenance",
    "intercom-rate-settings-get",
    "intercom-status",
  ];
  for (const method of methods) {
    const f = ownerReportFixture("paired-device");
    const handler = vi.fn(async (_command, guard) => {
      guard.requireOwner();
      return null;
    });
    f.authority.registerOwnerHandler(method, handler);
    const invocation = f.open()!;
    await expect(invocation.invoke("call", { method, input: null })).rejects.toThrow(
      "owner authority",
    );
    expect(handler).not.toHaveBeenCalled();
    expect(f.generic).not.toHaveBeenCalled();
  }
});

test("report owner seam: unavailable native registration never falls through to controller management", async () => {
  const f = ownerReportFixture();
  await expect(
    f.open()!.invoke("call", { method: "report-prime-register", input: null }),
  ).rejects.toThrow("handler unavailable");
  expect(f.generic).not.toHaveBeenCalled();
});

test("report owner seam: authenticated owner can register and recheck after asynchronous preparation", async () => {
  const f = ownerReportFixture();
  let writes = 0;
  f.authority.registerOwnerHandler("report-prime-register", async (_command, guard) => {
    expect(guard.ownerId).toBe("owner");
    await Promise.resolve();
    guard.requireOwner();
    writes++;
    return null;
  });
  await f.open()!.invoke("call", { method: "report-prime-register", input: null });
  expect(writes).toBe(1);
  expect(f.generic).not.toHaveBeenCalled();
});

test("report owner seam: revocation after preparation fences registration at final durable effect", async () => {
  const f = ownerReportFixture();
  let writes = 0;
  f.authority.registerOwnerHandler("report-parent-adopt", async (_command, guard) => {
    await Promise.resolve();
    f.revoke();
    guard.requireOwner();
    writes++;
    return null;
  });
  await expect(
    f.open()!.invoke("call", { method: "report-parent-adopt", input: null }),
  ).rejects.toThrow();
  expect(writes).toBe(0);
  expect(f.generic).not.toHaveBeenCalled();
});

test.each(["intercom-rate-settings-get", "intercom-status"])(
  "owner intercom read %s stays reserved without native handler",
  async (method) => {
    const f = ownerReportFixture();
    await expect(f.open()!.invoke("call", { method, input: null })).rejects.toThrow(
      "handler unavailable",
    );
    expect(f.generic).not.toHaveBeenCalled();
  },
);

test("native handoff fact observer: only consumed successful matching transfer acknowledges one fact", async () => {
  const { consumeManagementDispatch } = await import("./management.js");
  const f = ownerReportFixture();
  // A separate actual native authority is used since a registered bridge cannot be replaced.
  const authority = new ManagementAuthority({
    enabled: () => true,
    validate: (c) => c,
  });
  let consume = true,
    accepted = true,
    matching = true;
  authority.register("orca-organization-next", async (receivedCommand, principal) => {
    if (consume) consumeManagementDispatch(receivedCommand, principal);
    return {
      ownershipTransferred: accepted,
      handoffId: matching ? "operation" : "other",
    };
  });
  const fact = vi.fn();
  const capture = vi.fn(() => fact);
  authority.registerHandoffObserver(capture);
  expect(() => authority.registerHandoffObserver(capture)).toThrow();
  const open = () =>
    authority.open(bundledTarget, () => ({
      id: "owner",
      authentication: "protected-local-ipc",
      deviceId: null,
      permissions: OWNER_PERMISSIONS,
    }))!;
  const handoffCommand = {
    method: "leadership-transfer",
    input: { sessionId: "source", messageId: "operation" },
  };
  await open().invoke("successful", handoffCommand);
  expect(capture).toHaveBeenCalledWith("source", "operation");
  expect(fact).toHaveBeenCalledTimes(1);
  consume = false;
  await open().invoke("unconsumed", handoffCommand);
  consume = true;
  accepted = false;
  await open().invoke("refused", handoffCommand);
  accepted = true;
  matching = false;
  await open().invoke("wrong", handoffCommand);
  expect(fact).toHaveBeenCalledTimes(1);
  expect(f.generic).not.toHaveBeenCalled();
});
