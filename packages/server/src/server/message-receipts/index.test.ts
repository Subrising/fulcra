import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { MessageReceipts } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  return { directory, requests: new MessageReceipts(directory) };
}

test("message retries survive reconstruction without submitting twice", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
    },
  };
  await Promise.all([requests.send(input), requests.send(input)]);
  await new MessageReceipts(directory).send(input);
  expect(deliveries).toBe(1);
  await requests.send({ ...input, agentId: "another" });
  expect(deliveries).toBe(2);
});

test("ambiguous provider delivery is never blindly replayed after restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("connection lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("connection lost");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test("failed local message preparation does not leave an ambiguous receipt", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    prepare: async () => {
      if (!available) throw new Error("load failed");
    },
    send: async () => {
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("load failed");
  available = true;
  await new MessageReceipts(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

function queued(authorize = () => {}) {
  return {
    agentId: "target",
    messageId: "ticket",
    request: { text: "instruction" },
    principal: { source: "lead", generation: 1, targetGeneration: 2, boot: "boot", cursor: 3 },
    boot: "boot",
    attachmentBytes: 0,
    authorize,
  };
}

test("native busy admission is durable and same-id retries have one boundary effect", async () => {
  const { requests } = await fixture();
  const input = queued();
  expect(await requests.enqueue(input)).toMatchObject({ state: "queued", pendingCount: 1 });
  expect(await requests.enqueue(input)).toMatchObject({ state: "queued", pendingCount: 1 });
  let calls = 0;
  const dispatch = async (_input: unknown, check: () => void) => {
    check();
    calls++;
    return "turn";
  };
  expect(await requests.dispatchNext("target", () => false, dispatch)).toBeNull();
  expect(calls).toBe(0);
  expect(await requests.dispatchNext("target", () => true, dispatch)).toMatchObject({
    state: "delivered",
    pendingCount: 0,
  });
  expect(await requests.dispatchNext("target", () => true, dispatch)).toBeNull();
  expect(calls).toBe(1);
});

test("native receipt principal and immutable body conflicts protect dedup knowledge", async () => {
  const { requests } = await fixture();
  const input = queued();
  await requests.enqueue(input);
  await expect(requests.enqueue({ ...input, principal: { source: "intruder" } })).rejects.toThrow(
    "unavailable",
  );
  await expect(requests.enqueue({ ...input, request: { text: "replacement" } })).rejects.toThrow(
    "conflict",
  );
  await expect(requests.receipt("target", "ticket", {}, () => {})).rejects.toThrow("unavailable");
  await expect(requests.cancel("target", "ticket", {}, () => {})).rejects.toThrow("unavailable");
  expect(await requests.cancel("target", "ticket", input.principal, input.authorize)).toMatchObject(
    { state: "cancelled", pendingCount: 0 },
  );
});

test("pending revocation refuses without provider effect", async () => {
  const { requests } = await fixture();
  let valid = true;
  const input = queued(() => {
    if (!valid) throw new Error("revoked");
  });
  await requests.enqueue(input);
  valid = false;
  let calls = 0;
  expect(
    await requests.dispatchNext(
      "target",
      () => true,
      async () => {
        calls++;
        return "turn";
      },
    ),
  ).toMatchObject({ state: "refused" });
  expect(calls).toBe(0);
});

test("final native effect check catches revocation after asynchronous preparation", async () => {
  const { requests } = await fixture();
  let valid = true;
  const input = queued(() => {
    if (!valid) throw new Error("revoked");
  });
  await requests.enqueue(input);
  let calls = 0;
  expect(
    await requests.dispatchNext(
      "target",
      () => true,
      async (_input, check) => {
        await Promise.resolve();
        valid = false;
        check();
        calls++;
        return "turn";
      },
    ),
  ).toMatchObject({ state: "uncertain" });
  expect(calls).toBe(0);
  expect(
    await requests.dispatchNext(
      "target",
      () => true,
      async () => {
        calls++;
        return "turn";
      },
    ),
  ).toBeNull();
});

test("ambiguous native provider outcome never replays on retry or reconstruction", async () => {
  const { requests, directory } = await fixture();
  const input = queued();
  await requests.enqueue(input);
  let calls = 0;
  expect(
    await requests.dispatchNext(
      "target",
      () => true,
      async (_input, check) => {
        check();
        calls++;
        throw new Error("lost ack");
      },
    ),
  ).toMatchObject({ state: "uncertain" });
  expect(await requests.enqueue(input)).toMatchObject({ state: "uncertain" });
  expect(await new MessageReceipts(directory).enqueue(input)).toMatchObject({ state: "uncertain" });
  expect(calls).toBe(1);
});

test("queued old boot is cancelled with its permanent id retained", async () => {
  const { requests, directory } = await fixture();
  const input = queued();
  await requests.enqueue(input);
  const restarted = new MessageReceipts(directory);
  expect(await restarted.enqueue(input)).toMatchObject({ state: "cancelled" });
  expect(
    await restarted.dispatchNext(
      "target",
      () => true,
      async () => "turn",
    ),
  ).toBeNull();
});

test("historical acknowledgement cannot be relabeled as native delivered", async () => {
  const { requests, directory } = await fixture();
  const input = queued();
  await requests.send({ ...input, send: async () => {} });
  await expect(new MessageReceipts(directory).enqueue(input)).rejects.toThrow("unavailable");
});

test("native queue bounds actual resources and releases cancelled target capacity", async () => {
  const { requests } = await fixture();
  const input = queued();
  await expect(requests.enqueue({ ...input, attachmentBytes: 512 * 1024 })).rejects.toThrow(
    "Native evidence shared resource refusal",
  );
  await expect(
    requests.enqueue({ ...input, request: { text: "x".repeat(16 * 1024) } }),
  ).rejects.toThrow("agent_queue_resource_limit");
  for (let i = 0; i < 32; i++) await requests.enqueue({ ...input, messageId: `ticket-${i}` });
  await expect(requests.enqueue(input)).rejects.toThrow("Native evidence shared resource refusal");
  await requests.cancel("target", "ticket-0", input.principal, input.authorize);
  expect(await requests.enqueue(input)).toMatchObject({ pendingCount: 32 });
});

test("native queue expiry releases resources and rollback fails closed", async () => {
  const { directory } = await fixture();
  let now = 1000;
  const requests = new MessageReceipts(directory, () => now);
  const input = queued();
  await requests.enqueue(input);
  now--;
  await expect(
    requests.dispatchNext(
      "target",
      () => true,
      async () => "turn",
    ),
  ).rejects.toThrow("clock_rollback");
  now = 1000 + 6 * 60 * 60 * 1000;
  expect(
    await requests.dispatchNext(
      "target",
      () => true,
      async () => "turn",
    ),
  ).toBeNull();
  expect(
    await requests.receipt("target", "ticket", input.principal, input.authorize),
  ).toMatchObject({ state: "cancelled", pendingCount: 0 });
});

test("native attempt is durable before provider invocation and cancellation reports the actual phase", async () => {
  const { requests, directory } = await fixture();
  const input = queued();
  await requests.enqueue(input);
  const { createHash } = await import("node:crypto");
  const key = createHash("sha256")
    .update(JSON.stringify(["send", input.agentId, input.messageId]))
    .digest("hex");
  let finish!: (value: string) => void;
  let invoked!: () => void;
  const called = new Promise<void>((resolve) => {
    invoked = resolve;
  });
  const delivery = requests.dispatchNext(
    "target",
    () => true,
    async (_input, check) => {
      const persisted = JSON.parse(await readFile(path.join(directory, `${key}.json`), "utf8"));
      expect(persisted.state).toBe("dispatching");
      check();
      invoked();
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
  );
  await called;
  expect(await requests.cancel("target", "ticket", input.principal, input.authorize)).toMatchObject(
    { state: "dispatching" },
  );
  finish("provider-accepted");
  expect(await delivery).toMatchObject({ state: "delivered" });
});

test("corrupt historical storage refuses native admission without an effect", async () => {
  const { directory } = await fixture();
  await writeFile(path.join(directory, `${"a".repeat(64)}.json`), "{invalid");
  await expect(new MessageReceipts(directory).enqueue(queued())).rejects.toThrow();
});

test("native global count cap applies across targets", async () => {
  const { requests } = await fixture();
  const input = queued();
  for (let i = 0; i < 256; i++)
    await requests.enqueue({
      ...input,
      agentId: `target-${Math.floor(i / 32)}`,
      messageId: `ticket-${i}`,
    });
  await expect(requests.enqueue({ ...input, agentId: "extra-target" })).rejects.toThrow(
    "Native evidence shared resource refusal",
  );
});

test("native global byte cap includes actual retained attachment resource sizes", async () => {
  const { requests } = await fixture();
  const input = queued();
  for (let i = 0; i < 20; i++)
    await requests.enqueue({ ...input, agentId: `target-${i}`, attachmentBytes: 400 * 1024 });
  await expect(
    requests.enqueue({ ...input, agentId: "extra-target", attachmentBytes: 400 * 1024 }),
  ).rejects.toThrow("Native evidence shared resource refusal");
});

test("native dedup exhaustion is explicit maintenance refusal; old ids never become new", async () => {
  const { directory } = await fixture();
  const requests = new MessageReceipts(directory, Date.now, 1);
  const input = queued();
  await requests.enqueue(input);
  await requests.cancel("target", "ticket", input.principal, input.authorize);
  await expect(requests.enqueue({ ...input, messageId: "another" })).rejects.toMatchObject({
    code: "agent_receipt_maintenance_required",
  });
  expect(await requests.enqueue(input)).toMatchObject({ state: "cancelled" });
  expect(await requests.maintenance(() => {})).toEqual({
    recordedIds: 1,
    maxIds: 1,
    maintenanceRequired: true,
    newIdsRefused: true,
    automaticPruning: false,
  });
  const restarted = new MessageReceipts(directory, Date.now, 1);
  expect(await restarted.enqueue(input)).toMatchObject({ state: "cancelled" });
  await expect(restarted.enqueue({ ...input, messageId: "another" })).rejects.toMatchObject({
    code: "agent_receipt_maintenance_required",
  });
});

test("native maintenance requires fresh owner authority and cannot raise retention ceilings", async () => {
  const { requests, directory } = await fixture();
  await expect(
    requests.maintenance(() => {
      throw new Error("report credential is not owner");
    }),
  ).rejects.toThrow("not owner");
  let checks = 0;
  await expect(
    requests.maintenance(() => {
      if (++checks === 2) throw new Error("owner revoked");
    }),
  ).rejects.toThrow("owner revoked");
  expect(() => new MessageReceipts(directory, Date.now, 10001)).toThrow(
    "finite native receipt limit",
  );
});

test("native maintenance rechecks authority at every recovery durability boundary", async () => {
  const { requests, directory } = await fixture();
  await requests.enqueue(queued());
  const { readdir } = await import("node:fs/promises");
  const file = path.join(
    directory,
    (await readdir(directory)).find((name) => name.endsWith(".json"))!,
  );
  const before = await readFile(file, "utf8");
  // Before initialization's mkdir, after its await before opening the temp file,
  // before writing/syncing that file, then immediately before publication rename.
  for (const revokedAt of [2, 3, 4, 5, 6]) {
    const restored = new MessageReceipts(directory);
    let checks = 0;
    await expect(
      restored.maintenance(() => {
        if (++checks === revokedAt) throw new Error("owner revoked");
      }),
    ).rejects.toThrow("owner revoked");
    expect(await readFile(file, "utf8")).toBe(before);
  }
});

test("native receipt fence: immutable admission snapshots precede every queued await", async () => {
  const { requests } = await fixture();
  const input = queued();
  const accepted = requests.enqueue(input);
  input.request.text = "changed while admission waits";
  input.principal.source = "changed principal";
  await accepted;
  let observed: unknown;
  await requests.dispatchNext(
    "target",
    () => true,
    async (ticket, finalCheck) => {
      finalCheck();
      observed = { request: ticket.request, principal: ticket.principal };
      return "accepted";
    },
  );
  expect(observed).toEqual({ request: queued().request, principal: queued().principal });
  expect(await requests.enqueue(queued())).toMatchObject({ state: "delivered" });
});

test("native receipt fence: duplicate disk read rechecks revoked authorization before disclosure", async () => {
  const { requests } = await fixture();
  await requests.enqueue(queued());
  let valid = true;
  const input = queued(() => {
    if (!valid) throw new Error("duplicate authorization revoked");
    queueMicrotask(() => {
      valid = false;
    });
  });
  await expect(requests.enqueue(input)).rejects.toThrow("authorization revoked");
});

test.each(["enqueue", "cancel", "attempt"] as const)(
  "native receipt fence: %s rechecks authorization after awaited mkdir before durability publication",
  async (operation) => {
    const { requests, directory } = await fixture();
    const { promises: files } = await import("node:fs");
    let valid = true;
    const input = queued(() => {
      if (!valid) throw new Error("native source revoked");
    });
    if (operation !== "enqueue") await requests.enqueue(input);
    const names = (await files.readdir(directory)).filter((file) => file.endsWith(".json"));
    const previous = names.length
      ? await files.readFile(path.join(directory, names[0]!), "utf8")
      : null;
    const mkdir = files.mkdir;
    const spy = vi.spyOn(files, "mkdir").mockImplementation(async (...args) => {
      const result = await mkdir(...args);
      valid = false;
      return result;
    });
    let effects = 0;
    try {
      let pending;
      if (operation === "enqueue") pending = requests.enqueue(input);
      else if (operation === "cancel")
        pending = requests.cancel("target", "ticket", input.principal, input.authorize);
      else
        pending = requests.dispatchNext(
          "target",
          () => true,
          async (_ticket, check) => {
            check();
            effects++;
            return "accepted";
          },
        );
      await expect(pending).rejects.toThrow("native source revoked");
      const after = (await files.readdir(directory)).filter((file) => file.endsWith(".json"));
      if (previous === null) expect(after).toHaveLength(0);
      else expect(await files.readFile(path.join(directory, names[0]!), "utf8")).toBe(previous);
      expect(effects).toBe(0);
    } finally {
      spy.mockRestore();
    }
  },
);

test.each(["dispatching", "submission", "acknowledgement"])(
  "native provider boundary: restart at %s never replays an attempted ID",
  async (stage) => {
    const { createNativeQueuedDispatch, submitNativeQueuedDispatch, recordNativeQueuedAcceptance } =
      await import("../agent/native-queued-dispatch.js");
    const { requests, directory } = await fixture();
    const input = queued();
    await requests.enqueue(input);
    let entered = false;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let writes = 0;
    const pending = requests.dispatchNext(
      "target",
      () => true,
      async (_ticket, check) => {
        const capability = createNativeQueuedDispatch(check);
        if (stage !== "dispatching")
          submitNativeQueuedDispatch(capability, () => {
            writes++;
          });
        if (stage === "acknowledgement") recordNativeQueuedAcceptance(capability, "native-id");
        entered = true;
        await gate;
        throw new Error("process disappeared before outcome commit");
      },
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    const restarted = new MessageReceipts(directory);
    expect(await restarted.enqueue(input)).toMatchObject({ state: "uncertain", pendingCount: 0 });
    expect(
      await restarted.dispatchNext(
        "target",
        () => true,
        async () => {
          writes++;
          return "replay";
        },
      ),
    ).toBeNull();
    resume();
    expect(await pending).toMatchObject({ state: "uncertain" });
    expect(writes).toBe(stage === "dispatching" ? 0 : 1);
  },
);

test("native provider boundary: known pre-handoff refusal and ambiguous local push have truthful terminal states", async () => {
  const { createNativeQueuedDispatch, submitNativeQueuedDispatch } =
    await import("../agent/native-queued-dispatch.js");
  const { requests } = await fixture();
  const input = queued();
  await requests.enqueue(input);
  let writes = 0;
  expect(
    await requests.dispatchNext(
      "target",
      () => true,
      async (_ticket, check) => {
        const capability = createNativeQueuedDispatch(() => {
          check();
          throw new Error("revoked after setup");
        });
        submitNativeQueuedDispatch(capability, () => {
          writes++;
        });
        return "impossible";
      },
    ),
  ).toMatchObject({ state: "refused" });
  expect(writes).toBe(0);
  await requests.enqueue({ ...input, messageId: "uncertain-push" });
  expect(
    await requests.dispatchNext(
      "target",
      () => true,
      async (_ticket, check) => {
        submitNativeQueuedDispatch(createNativeQueuedDispatch(check), () => {
          writes++;
        });
        throw new Error("local handoff lacks correlated acknowledgement");
      },
    ),
  ).toMatchObject({ state: "uncertain" });
  expect(writes).toBe(1);
});
