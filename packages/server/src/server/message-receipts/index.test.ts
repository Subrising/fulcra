import { mkdtemp, rm, readFile, writeFile, readdir, utimes, chmod } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { MessageReceipts } from "./index.js";

// Native admission requires directory-entry durability. The Windows refusal is asserted below.
const posixTest = test.runIf(process.platform !== "win32");
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

posixTest("archive observation counts pending and uncertain native receipts", async () => {
  const { requests, directory } = await fixture();
  expect(requests.archivePending("target")).toBeNull();
  await requests.prepareArchiveObservation();
  expect(requests.archivePending("target")).toBe(0);
  const admission = requests.enqueue(queued());
  expect(requests.archivePending("target")).toBeNull();
  await admission;
  expect(requests.archivePending("target")).toBe(1);
  await expect(
    requests.dispatchNext(
      "target",
      () => true,
      async () => {
        throw new Error("Synthetic ambiguous delivery");
      },
    ),
  ).resolves.toMatchObject({ state: "uncertain" });
  expect(requests.archivePending("target")).toBe(1);
  const restored = new MessageReceipts(directory);
  await restored.prepareArchiveObservation();
  expect(restored.archivePending("target")).toBe(1);
  expect(restored.archivePending("other")).toBe(0);
});

posixTest(
  "archive observation leaves queued receipt bytes unchanged and preserves lifecycle recovery",
  async () => {
    const { requests, directory } = await fixture();
    await requests.enqueue(queued());
    const file = path.join(directory, (await readdir(directory))[0]!);
    const before = await readFile(file, "utf8");
    const restored = new MessageReceipts(directory);
    await restored.prepareArchiveObservation();
    expect(await readFile(file, "utf8")).toBe(before);
    expect(restored.archivePending("target")).toBe(1);
    await restored.prepareArchiveObservation();
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await restored.enqueue(queued())).toMatchObject({ state: "cancelled" });
    expect(JSON.parse(await readFile(file, "utf8")).state).toBe("cancelled");
  },
);

test("archive observation keeps unreadable native receipt state unknown", async () => {
  const { requests, directory } = await fixture();
  await writeFile(path.join(directory, `${"a".repeat(64)}.json`), "invalid JSON");
  await requests.prepareArchiveObservation();
  expect(requests.archivePending("target")).toBeNull();
});

posixTest(
  "native busy admission is durable and same-id retries have one boundary effect",
  async () => {
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
  },
);

posixTest(
  "native receipt principal and immutable body conflicts protect dedup knowledge",
  async () => {
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
    expect(
      await requests.cancel("target", "ticket", input.principal, input.authorize),
    ).toMatchObject({ state: "cancelled", pendingCount: 0 });
  },
);

posixTest("pending revocation refuses without provider effect", async () => {
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

posixTest(
  "final native effect check catches revocation after asynchronous preparation",
  async () => {
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
  },
);

posixTest(
  "ambiguous native provider outcome never replays on retry or reconstruction",
  async () => {
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
    expect(await new MessageReceipts(directory).enqueue(input)).toMatchObject({
      state: "uncertain",
    });
    expect(calls).toBe(1);
  },
);

posixTest("queued old boot is cancelled with its permanent id retained", async () => {
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

posixTest(
  "native queue bounds actual resources and releases cancelled target capacity",
  async () => {
    const { requests } = await fixture();
    const input = queued();
    await expect(requests.enqueue({ ...input, attachmentBytes: 512 * 1024 })).rejects.toThrow(
      "Native evidence shared resource refusal",
    );
    await expect(
      requests.enqueue({ ...input, request: { text: "x".repeat(16 * 1024) } }),
    ).rejects.toThrow("agent_queue_resource_limit");
    for (let i = 0; i < 32; i++) await requests.enqueue({ ...input, messageId: `ticket-${i}` });
    await expect(requests.enqueue(input)).rejects.toThrow(
      "Native evidence shared resource refusal",
    );
    await requests.cancel("target", "ticket-0", input.principal, input.authorize);
    expect(await requests.enqueue(input)).toMatchObject({ pendingCount: 32 });
  },
);

posixTest("native queue expiry releases resources and rollback fails closed", async () => {
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

posixTest(
  "native attempt is durable before provider invocation and cancellation reports the actual phase",
  async () => {
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
    expect(
      await requests.cancel("target", "ticket", input.principal, input.authorize),
    ).toMatchObject({ state: "dispatching" });
    finish("provider-accepted");
    expect(await delivery).toMatchObject({ state: "delivered" });
  },
);

test("corrupt historical storage refuses native admission without an effect", async () => {
  const { directory } = await fixture();
  await writeFile(path.join(directory, `${"a".repeat(64)}.json`), "{invalid");
  await expect(new MessageReceipts(directory).enqueue(queued())).rejects.toThrow();
});

posixTest("native global count cap applies across targets", async () => {
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

posixTest("native global byte cap includes actual retained attachment resource sizes", async () => {
  const { requests } = await fixture();
  const input = queued();
  for (let i = 0; i < 20; i++)
    await requests.enqueue({ ...input, agentId: `target-${i}`, attachmentBytes: 400 * 1024 });
  await expect(
    requests.enqueue({ ...input, agentId: "extra-target", attachmentBytes: 400 * 1024 }),
  ).rejects.toThrow("Native evidence shared resource refusal");
});

posixTest(
  "native dedup exhaustion is explicit maintenance refusal; old ids never become new",
  async () => {
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
      automaticPruning: true,
      prunedCount: 0,
      lastPruneAt: expect.any(Number),
    });
    const restarted = new MessageReceipts(directory, Date.now, 1);
    expect(await restarted.enqueue(input)).toMatchObject({ state: "cancelled" });
    await expect(restarted.enqueue({ ...input, messageId: "another" })).rejects.toMatchObject({
      code: "agent_receipt_maintenance_required",
    });
  },
);

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

posixTest(
  "native maintenance rechecks authority at every recovery durability boundary",
  async () => {
    const { requests, directory } = await fixture();
    await requests.enqueue(queued());
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
  },
);

posixTest(
  "native receipt fence: immutable admission snapshots precede every queued await",
  async () => {
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
  },
);

posixTest(
  "native receipt fence: duplicate disk read rechecks revoked authorization before disclosure",
  async () => {
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
  },
);

posixTest.each(["enqueue", "cancel", "attempt"] as const)(
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

posixTest.each(["dispatching", "submission", "acknowledgement"])(
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

posixTest(
  "native provider boundary: known pre-handoff refusal and ambiguous local push have truthful terminal states",
  async () => {
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
  },
);

test.runIf(process.platform === "win32")(
  "Windows never acknowledges a native receipt as durable or dispatches its provider",
  async () => {
    const { directory, requests } = await fixture();
    const effect = vi.fn(async () => "turn");
    await expect(requests.enqueue(queued())).rejects.toMatchObject({
      code: "NATIVE_DURABILITY_UNAVAILABLE",
    });
    await expect(requests.dispatchNext("target", () => true, effect)).rejects.toThrow(
      "agent_receipt_durability_unavailable",
    );
    expect(effect).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  },
);

// 0.2.13 review: the held queue was full, the sender was told so, and the same message ID could then never be sent.
test.each(["HELD_QUEUE_FULL", "SEND_REQUEST_EXPIRED"])(
  "a refusal that sent nothing can retry the same message ID (%s)",
  async (code) => {
    const { requests, directory } = await fixture();
    let deliveries = 0;
    let full = true;
    const input = {
      agentId: "agent",
      messageId: "arrival",
      request: {},
      send: async () => {
        if (full) throw Object.assign(new Error("input refused before handoff"), { code });
        deliveries++;
      },
    };
    await expect(requests.send(input)).rejects.toThrow("input refused before handoff");
    full = false;
    await requests.send(input);
    expect(deliveries).toBe(1);
    // Still exactly once for the same ID, also after a restart.
    await new MessageReceipts(directory).send(input);
    expect(deliveries).toBe(1);
  },
);

test("a refused plugin message (provenance refused) can be retried with the same message ID", async () => {
  const { requests } = await fixture();
  let refuse = true;
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "plugin-arrival",
    request: {},
    send: async () => {
      if (refuse) throw Object.assign(new Error("chat is busy"), { code: "PROVENANCE_REFUSED" });
      deliveries++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("chat is busy");
  refuse = false;
  await requests.send(input);
  expect(deliveries).toBe(1);
});

test("any other failed send keeps its pending receipt", async () => {
  const { requests } = await fixture();
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async () => {
      throw Object.assign(new Error("lost"), { code: "SOMETHING_ELSE" });
    },
  };
  await expect(requests.send(input)).rejects.toThrow("lost");
  await expect(requests.send(input)).rejects.toThrow("agent_request_outcome_unknown");
});

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
async function ageReceipts(directory: string, at: number) {
  for (const file of await readdir(directory))
    await utimes(path.join(directory, file), new Date(at), new Date(at));
}
function legacySend(messageId: string) {
  return { agentId: "target", messageId, request: {}, send: vi.fn(async () => {}) };
}

test("load prunes old completed receipts but retains pending and new receipts", async () => {
  const { directory, requests } = await fixture();
  await requests.send(legacySend("old"));
  await expect(
    requests.send({
      ...legacySend("pending"),
      send: async () => {
        throw new Error("unknown outcome");
      },
    }),
  ).rejects.toThrow("unknown outcome");
  await ageReceipts(directory, Date.now() - 2 * DAY);
  await requests.send(legacySend("new"));
  const restored = new MessageReceipts(directory);
  expect(await restored.maintenance(() => {})).toMatchObject({
    recordedIds: 2,
    prunedCount: 1,
    lastPruneAt: expect.any(Number),
    automaticPruning: true,
  });
  await expect(restored.send(legacySend("pending"))).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  const duplicate = legacySend("new");
  await restored.send(duplicate);
  expect(duplicate.send).not.toHaveBeenCalled();
  restored.stop();
});

test("load can prune a ledger above its old limit before accepting a new send", async () => {
  const { directory, requests } = await fixture();
  await requests.send(legacySend("first"));
  await requests.send(legacySend("second"));
  await ageReceipts(directory, Date.now() - 2 * DAY);
  const restored = new MessageReceipts(directory, Date.now, 1, { warn: () => {} });
  const input = legacySend("new");
  await restored.send(input);
  expect(input.send).toHaveBeenCalledTimes(1);
  expect(await restored.maintenance(() => {})).toMatchObject({ recordedIds: 1, prunedCount: 2 });
  restored.stop();
});

test("capacity refusal first prunes aged terminal files without a restart", async () => {
  const { directory } = await fixture();
  const requests = new MessageReceipts(directory, Date.now, 1, { warn: () => {} });
  await requests.send(legacySend("old"));
  await ageReceipts(directory, Date.now() - 2 * DAY);
  const next = legacySend("next");
  await requests.send(next);
  expect(next.send).toHaveBeenCalledTimes(1);
  expect(await requests.maintenance(() => {})).toMatchObject({ recordedIds: 1, prunedCount: 1 });
  requests.stop();
});

test("a full ledger prunes on demand at most once per minute", async () => {
  const { directory } = await fixture();
  let now = Date.now();
  const requests = new MessageReceipts(directory, () => now, 1, { warn: () => {} });
  try {
    await requests.send(legacySend("old"));
    const next = legacySend("next");
    await expect(requests.send(next)).rejects.toMatchObject({
      code: "agent_receipt_maintenance_required",
    });
    const file = path.join(directory, (await readdir(directory))[0]);
    const content = await readFile(file);
    await writeFile(file, "{invalid");
    now += 59999;
    await expect(requests.send(next)).rejects.toMatchObject({
      code: "agent_receipt_maintenance_required",
    });
    expect(next.send).not.toHaveBeenCalled();
    now++;
    await expect(requests.send(next)).rejects.toThrow(SyntaxError);
    await writeFile(file, content);
    await ageReceipts(directory, now - 2 * DAY);
    now += 60000;
    await requests.send(next);
    expect(next.send).toHaveBeenCalledTimes(1);
  } finally {
    requests.stop();
  }
});

posixTest(
  "pruning keeps queued and dispatching files and fences terminal IDs inside their lifetime",
  async () => {
    const { directory, requests } = await fixture();
    const input = queued();
    await requests.enqueue(input);
    await ageReceipts(directory, Date.now() - 2 * DAY);
    const observer = new MessageReceipts(directory);
    await observer.prepareArchiveObservation();
    expect(await readdir(directory)).toHaveLength(1);
    observer.stop();
    await requests.cancel("target", "ticket", input.principal, input.authorize);
    await ageReceipts(directory, Date.now() - 2 * DAY);
    const restored = new MessageReceipts(directory, Date.now, 1, { warn: () => {} });
    expect(await restored.enqueue(input)).toMatchObject({ state: "cancelled" });
    await expect(restored.enqueue({ ...input, request: { text: "changed" } })).rejects.toThrow();
    expect(await restored.maintenance(() => {})).toMatchObject({ recordedIds: 1, prunedCount: 0 });
    restored.stop();
  },
);

posixTest(
  "pruning removes old final native receipts and clears their memory reservation",
  async () => {
    const { directory } = await fixture();
    let now = Date.now();
    const requests = new MessageReceipts(directory, () => now, 1, { warn: () => {} });
    const input = queued();
    await requests.enqueue(input);
    await requests.cancel("target", "ticket", input.principal, input.authorize);
    await ageReceipts(directory, now - 2 * DAY);
    now += 2 * DAY;
    await expect(requests.enqueue({ ...input, messageId: "next" })).resolves.toMatchObject({
      state: "queued",
    });
    expect(await requests.maintenance(() => {})).toMatchObject({ recordedIds: 1, prunedCount: 1 });
    requests.stop();
  },
);

posixTest(
  "failed unlink retains the count and retry fence until a later prune succeeds",
  async () => {
    const { directory } = await fixture();
    let now = Date.now();
    const requests = new MessageReceipts(directory, () => now, 1, { warn: () => {} });
    await requests.send(legacySend("old"));
    await ageReceipts(directory, Date.now() - 2 * DAY);
    const next = legacySend("next");
    await chmod(directory, 0o500);
    try {
      await expect(requests.send(next)).rejects.toMatchObject({
        code: "agent_receipt_maintenance_required",
      });
      expect(next.send).not.toHaveBeenCalled();
      expect(await requests.maintenance(() => {})).toMatchObject({
        recordedIds: 1,
        prunedCount: 0,
      });
      expect(await readdir(directory)).toHaveLength(1);
    } finally {
      await chmod(directory, 0o700);
    }
    now += 60000;
    await requests.send(next);
    expect(next.send).toHaveBeenCalledTimes(1);
    requests.stop();
  },
);

posixTest(
  "one failed durable write does not fail every later send; the ledger recovers and reports health",
  async () => {
    const { directory } = await fixture();
    const warnings: string[] = [];
    const requests = new MessageReceipts(directory, Date.now, undefined, {
      warn: (message) => warnings.push(message),
    });
    await requests.enqueue({ ...queued(), messageId: "first" });
    expect(requests.health()).toMatchObject({ healthy: true, lastError: null });
    await chmod(directory, 0o500);
    try {
      await expect(requests.enqueue({ ...queued(), messageId: "blocked" })).rejects.toThrow();
      expect(requests.health()).toMatchObject({ healthy: false });
      expect(requests.health().lastError).toMatch(/EACCES|EPERM/);
      await expect(
        requests.enqueue({ ...queued(), messageId: "still-blocked" }),
      ).rejects.toMatchObject({
        message: "agent_receipt_durability_unavailable",
        cause: expect.anything(),
      });
      // A background pass that trips on the closed ledger must not turn the fault permanent.
      await requests.prepareArchiveObservation();
    } finally {
      await chmod(directory, 0o700);
    }
    expect(await requests.enqueue({ ...queued(), messageId: "after-fault" })).toMatchObject({
      state: "queued",
    });
    expect(requests.health()).toMatchObject({ healthy: true, recoveries: 1 });
    expect(warnings.filter((m) => m.includes("unhealthy"))).toHaveLength(1);
    requests.stop();
  },
);

async function receiptFile(directory: string, messageId: string) {
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    const record = JSON.parse(await readFile(file, "utf8"));
    if (record.messageId === messageId) return { file, record };
  }
  throw new Error(`no receipt for ${messageId}`);
}
async function latch(directory: string, requests: MessageReceipts) {
  await chmod(directory, 0o500);
  try {
    await expect(requests.enqueue({ ...queued(), messageId: "latch" })).rejects.toThrow();
  } finally {
    await chmod(directory, 0o700);
  }
  expect(requests.health().healthy).toBe(false);
}

posixTest(
  "recovery keeps live queued receipts and tells observers where the disk was ahead",
  async () => {
    const { directory } = await fixture();
    const requests = new MessageReceipts(directory, Date.now, undefined, { warn: () => {} });
    const first = vi.fn();
    const second = vi.fn();
    await requests.enqueue({ ...queued(), messageId: "first", observe: first });
    await requests.enqueue({ ...queued(), messageId: "second", observe: second });
    await latch(directory, requests);
    const { file, record } = await receiptFile(directory, "first");
    await writeFile(file, JSON.stringify({ ...record, state: "cancelled" }));
    expect(await requests.enqueue({ ...queued(), messageId: "after" })).toMatchObject({
      state: "queued",
    });
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ state: "cancelled" }));
    expect(second).not.toHaveBeenCalled();
    expect((await receiptFile(directory, "second")).record.state).toBe("queued");
    requests.stop();
  },
);

posixTest("a guard failing after the rename recovers through the disk rebuild", async () => {
  const { directory } = await fixture();
  const requests = new MessageReceipts(directory, Date.now, undefined, { warn: () => {} });
  const landed = () => readdirSync(directory).some((name) => /^[a-f0-9]{64}\.json$/.test(name));
  await expect(
    requests.enqueue({
      ...queued(),
      messageId: "raced",
      authorize: () => {
        if (landed()) throw new Error("ownership revoked");
      },
    }),
  ).rejects.toThrow("ownership revoked");
  expect(requests.health().healthy).toBe(false);
  expect(await requests.enqueue({ ...queued(), messageId: "next" })).toMatchObject({
    state: "queued",
  });
  expect(requests.health()).toMatchObject({ healthy: true, recoveries: 1 });
  // The receipt landed on disk but its admission failed: recovery settles it as cancelled.
  expect((await receiptFile(directory, "raced")).record.state).toBe("cancelled");
  requests.stop();
});

posixTest(
  "a guard failing after the dispatch rename refuses the receipt instead of blocking the agent",
  async () => {
    const { directory } = await fixture();
    const requests = new MessageReceipts(directory, Date.now, undefined, { warn: () => {} });
    const observed = vi.fn();
    const dispatching = () =>
      readdirSync(directory).some(
        (name) =>
          /^[a-f0-9]{64}\.json$/.test(name) &&
          JSON.parse(readFileSync(path.join(directory, name), "utf8")).state === "dispatching",
      );
    await requests.enqueue({
      ...queued(),
      messageId: "stuck",
      observe: observed,
      authorize: () => {
        if (dispatching()) throw new Error("ownership revoked");
      },
    });
    const dispatch = vi.fn(async () => "turn");
    await expect(requests.dispatchNext("target", () => true, dispatch)).rejects.toThrow(
      "ownership revoked",
    );
    expect(dispatch).not.toHaveBeenCalled();
    await requests.enqueue({ ...queued(), messageId: "next" });
    expect(requests.health().healthy).toBe(true);
    expect((await receiptFile(directory, "stuck")).record.state).toBe("refused");
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ state: "refused" }));
    expect(await requests.dispatchNext("target", () => true, dispatch)).toMatchObject({
      state: "delivered",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    requests.stop();
  },
);

posixTest("a failed rebuild keeps memory as it was and can be retried", async () => {
  const { directory } = await fixture();
  const requests = new MessageReceipts(directory, Date.now, undefined, { warn: () => {} });
  await requests.enqueue({ ...queued(), messageId: "first" });
  await latch(directory, requests);
  const { file } = await receiptFile(directory, "first");
  await chmod(file, 0o000);
  try {
    await expect(requests.enqueue({ ...queued(), messageId: "blocked" })).rejects.toMatchObject({
      message: "agent_receipt_durability_unavailable",
    });
    expect((requests as unknown as { records: Map<string, unknown> }).records.size).toBe(1);
  } finally {
    await chmod(file, 0o600);
  }
  expect(await requests.enqueue({ ...queued(), messageId: "retry" })).toMatchObject({
    state: "queued",
  });
  expect(requests.health().healthy).toBe(true);
  requests.stop();
});

posixTest("a corrupt record latches the ledger instead of probing on every call", async () => {
  const { directory } = await fixture();
  const requests = new MessageReceipts(directory, Date.now, undefined, { warn: () => {} });
  await requests.enqueue({ ...queued(), messageId: "first" });
  await latch(directory, requests);
  const { file } = await receiptFile(directory, "first");
  await writeFile(file, "{ not json");
  await expect(requests.enqueue({ ...queued(), messageId: "blocked" })).rejects.toThrow();
  expect((requests as unknown as { recoverable: boolean }).recoverable).toBe(false);
  requests.stop();
});

test("hourly pruning runs without sends and its timer does not keep the process alive", async () => {
  const { directory } = await fixture();
  const requests = new MessageReceipts(directory);
  await requests.send(legacySend("old"));
  const timer = Reflect.get(requests, "pruneTimer") as NodeJS.Timeout;
  expect(timer.hasRef()).toBe(false);
  requests.stop();
  await ageReceipts(directory, Date.now() - 2 * DAY);
  vi.useFakeTimers();
  const restored = new MessageReceipts(directory);
  await restored.maintenance(() => {});
  await restored.send(legacySend("later"));
  await ageReceipts(directory, Date.now() - 2 * DAY);
  await vi.advanceTimersByTimeAsync(HOUR);
  // The serial observation waits for the timer's file operations to finish.
  expect(await restored.maintenance(() => {})).toMatchObject({ recordedIds: 0, prunedCount: 2 });
  restored.stop();
});

test("retention must exceed the retry lifetime and warns once at 80% capacity", async () => {
  const { directory } = await fixture();
  for (const retentionMs of [6 * HOUR, 0, -1, Infinity, 6 * HOUR + 0.5])
    expect(() => new MessageReceipts(directory, Date.now, 5, { retentionMs })).toThrow();
  const warn = vi.fn();
  const requests = new MessageReceipts(directory, Date.now, 5, { retentionMs: 2 * DAY, warn });
  for (let i = 0; i < 3; i++) await requests.send(legacySend(`message-${i}`));
  expect(warn).not.toHaveBeenCalled();
  await requests.send(legacySend("fourth"));
  await requests.send(legacySend("fifth"));
  expect(warn).toHaveBeenCalledExactlyOnceWith("Native receipt ledger is at or above 80% capacity");
  requests.stop();
});

posixTest.each(["delivered", "refused", "cancelled", "uncertain"])(
  "load prunes expired %s native receipts",
  async (state) => {
    const { directory, requests } = await fixture();
    await requests.enqueue(queued());
    requests.stop();
    const file = path.join(directory, (await readdir(directory))[0]!);
    const receipt = JSON.parse(await readFile(file, "utf8"));
    const at = Date.now() - 2 * DAY;
    await writeFile(
      file,
      JSON.stringify({ ...receipt, state, admittedAt: at, expiresAt: at + 6 * HOUR }),
    );
    await ageReceipts(directory, at);
    const restored = new MessageReceipts(directory);
    expect(await restored.maintenance(() => {})).toMatchObject({ recordedIds: 0, prunedCount: 1 });
    expect(await readdir(directory)).toEqual([]);
    restored.stop();
  },
);

posixTest.each(["queued", "dispatching"])(
  "load never prunes old %s native receipts",
  async (state) => {
    const { directory, requests } = await fixture();
    await requests.enqueue(queued());
    requests.stop();
    const file = path.join(directory, (await readdir(directory))[0]!);
    const receipt = JSON.parse(await readFile(file, "utf8"));
    const at = Date.now() - 2 * DAY;
    await writeFile(
      file,
      JSON.stringify({ ...receipt, state, admittedAt: at, expiresAt: at + 6 * HOUR }),
    );
    await ageReceipts(directory, at);
    const restored = new MessageReceipts(directory);
    expect(await restored.maintenance(() => {})).toMatchObject({ recordedIds: 1, prunedCount: 0 });
    expect(await readdir(directory)).toHaveLength(1);
    restored.stop();
  },
);

test("custom retention keeps terminal receipts beyond the default retention", async () => {
  const { directory, requests } = await fixture();
  await requests.send(legacySend("old"));
  await ageReceipts(directory, Date.now() - 2 * DAY);
  const restored = new MessageReceipts(directory, Date.now, undefined, { retentionMs: 3 * DAY });
  expect(await restored.maintenance(() => {})).toMatchObject({ recordedIds: 1, prunedCount: 0 });
  restored.stop();
});
