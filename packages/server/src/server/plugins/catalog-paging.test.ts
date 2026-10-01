import pino from "pino";
import { PluginRuntime } from "./runtime.js";
import { expect, test, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { PluginCatalogPaging, type CatalogReadState } from "./catalog-paging.js";
import {
  PluginCatalogBundleGetResponseSchema,
  PluginCatalogPageResponseSchema,
} from "@getpaseo/protocol/plugin-catalog-paging";

function fixture(count = 18, bundle = "😀safe();\n".repeat(1000)) {
  let now = 100_000,
    revision = randomUUID(),
    epoch = 0;
  const capturedEpoch = epoch,
    reader = {},
    cancellation = new AbortController();
  const entries = Array.from({ length: count }, (_, n) => ({
    id: `plugin-${String(n).padStart(3, "0")}`,
    clientBundle: bundle,
    requirements: { paseo: ">=0.8.0" },
  }));
  let stateReader: () => CatalogReadState | Promise<CatalogReadState> = () => ({
    revision,
    entries,
  });
  const pager = new PluginCatalogPaging(
    () => stateReader(),
    () => revision,
    () => now,
  );
  const guard = () => {
    if (epoch !== capturedEpoch || cancellation.signal.aborted) throw Error("Reader changed");
  };
  const close = vi.fn();
  const trust = {
    trustedHost: { contract: "1.1" as const, boot: randomUUID() },
    trustedPlugins: [],
  };
  return {
    pager,
    reader,
    guard,
    close,
    trust,
    entries,
    cancellation,
    open: () => pager.open(reader, guard, close, trust, "first"),
    setNow: (value: number) => {
      now = value;
    },
    change: () => {
      revision = randomUUID();
    },
    revokeRegain: () => {
      epoch += 2;
    },
    hold: (get: typeof stateReader) => {
      stateReader = get;
    },
    state: () => ({ revision, entries }),
  };
}
async function refused(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

test("L17 pages and Unicode script chunks bind one immutable snapshot without embedding scripts", async () => {
  const f = fixture();
  try {
    const first = await f.open();
    expect(first.entries).toHaveLength(16);
    expect(first.nextCursor).not.toBeNull();
    expect(
      PluginCatalogPageResponseSchema.safeParse({
        type: "plugin.catalog.page.response",
        payload: first,
      }).success,
    ).toBe(true);
    expect(JSON.stringify(first)).not.toContain("safe()");
    const second = await f.pager.page(f.reader, first.nextCursor!, f.guard, "next");
    expect(second.entries).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(second.manifestHash).toBe(first.manifestHash);
    const descriptor = first.entries[0]!;
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < descriptor.bundle.byteLength; offset += 1001) {
      const chunk = await f.pager.bundle(
        f.reader,
        first.snapshotId,
        descriptor.bundle.reference,
        offset,
        1001,
        f.guard,
        "chunk",
      );
      expect(
        PluginCatalogBundleGetResponseSchema.safeParse({
          type: "plugin.catalog.bundle.get.response",
          payload: chunk,
        }).success,
      ).toBe(true);
      chunks.push(Buffer.from(chunk.data, "base64"));
    }
    const content = Buffer.concat(chunks);
    expect(content.toString()).toBe(f.entries[0]!.clientBundle);
    expect(createHash("sha256").update(content).digest("hex")).toBe(descriptor.bundle.sha256);
    first.entries[0]!.id = "caller-mutated";
    expect((await f.pager.page(f.reader, first.nextCursor!, f.guard, "again")).manifestHash).toBe(
      first.manifestHash,
    );
  } finally {
    f.pager.invalidate();
  }
});

test("L17 foreign physical readers/cursors/references cannot consume another reader's script", async () => {
  const f = fixture();
  try {
    const first = await f.open();
    const ref = first.entries[0]!.bundle.reference;
    await refused(
      f.pager.page({}, first.nextCursor!, () => {}, "foreign"),
      "read_revoked",
    );
    await refused(
      f.pager.bundle({}, first.snapshotId, ref, 0, 1, () => {}, "foreign"),
      "read_revoked",
    );
    await refused(
      f.pager.bundle(f.reader, first.snapshotId, randomUUID(), 0, 1, f.guard, "badref"),
      "invalid_request",
    );
    await refused(f.pager.page(f.reader, randomUUID(), f.guard, "badcursor"), "unavailable");
    expect(
      (await f.pager.bundle(f.reader, first.snapshotId, ref, 0, 1, f.guard, "valid")).data,
    ).not.toBe("");
  } finally {
    f.pager.invalidate();
  }
});

test("L17 held first preparation refuses revoke/regain, original source close and stale revision", async () => {
  for (const kind of ["epoch", "source", "revision"]) {
    const f = fixture(1);
    try {
      let complete!: (state: CatalogReadState) => void;
      const old = f.state();
      f.hold(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const pending = f.open();
      if (kind === "epoch") f.revokeRegain();
      else if (kind === "source") f.cancellation.abort();
      else f.change();
      complete(old);
      await refused(pending, kind === "revision" ? "stale_snapshot" : "read_revoked");
      expect(f.close).not.toHaveBeenCalled();
    } finally {
      f.pager.invalidate();
    }
  }
});

test("L17 held bundle preparation rechecks original epoch/source and captured content hash", async () => {
  for (const kind of ["epoch", "source", "body"]) {
    const f = fixture(1);
    try {
      const first = await f.open();
      const ref = first.entries[0]!.bundle.reference;
      let complete!: (state: CatalogReadState) => void;
      f.hold(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const pending = f.pager.bundle(f.reader, first.snapshotId, ref, 0, 100, f.guard, "held");
      if (kind === "epoch") f.revokeRegain();
      else if (kind === "source") f.cancellation.abort();
      else f.entries[0]!.clientBundle = "changed without revision";
      complete(f.state());
      await refused(pending, kind === "body" ? "stale_snapshot" : "read_revoked");
    } finally {
      f.pager.invalidate();
    }
  }
});

test("L17 expiry/release/revision invalidation never retarget a snapshot or revive it on clock rollback", async () => {
  const f = fixture(1);
  try {
    const first = await f.open();
    f.change();
    await refused(
      f.pager.bundle(
        f.reader,
        first.snapshotId,
        first.entries[0]!.bundle.reference,
        0,
        1,
        f.guard,
        "stale",
      ),
      "stale_snapshot",
    );
    expect(f.close).toHaveBeenCalledTimes(1);
    const second = await f.open();
    f.pager.release(f.reader, second.snapshotId, f.guard);
    await refused(
      f.pager.bundle(
        f.reader,
        second.snapshotId,
        second.entries[0]!.bundle.reference,
        0,
        1,
        f.guard,
        "released",
      ),
      "unavailable",
    );
    const third = await f.open();
    f.setNow(third.expiresAt);
    await refused(
      f.pager.bundle(
        f.reader,
        third.snapshotId,
        third.entries[0]!.bundle.reference,
        0,
        1,
        f.guard,
        "expired",
      ),
      "unavailable",
    );
    f.setNow(100_000);
    await refused(f.open(), "expired");
  } finally {
    f.pager.invalidate();
  }
});

test("L17 full encoded source and per-plugin caps stay failclosed including escaping", async () => {
  for (const [count, bundle] of [
    [1, "\\".repeat(524288)],
    [10, "x".repeat(900000)],
    [129, "x"],
  ] as const) {
    const f = fixture(count, bundle);
    try {
      await refused(f.open(), "resource_limit");
    } finally {
      f.pager.invalidate();
    }
  }
});

test("L17 finite host snapshots and repeated chunk byte budgets are charged, not a read grant renewal", async () => {
  const f = fixture(1, "x".repeat(65536));
  try {
    const first = await f.open();
    for (let i = 0; i < 128; i++)
      await f.pager.bundle(
        f.reader,
        first.snapshotId,
        first.entries[0]!.bundle.reference,
        0,
        65536,
        f.guard,
        "repeat",
      );
    await refused(
      f.pager.bundle(
        f.reader,
        first.snapshotId,
        first.entries[0]!.bundle.reference,
        0,
        1,
        f.guard,
        "over",
      ),
      "resource_limit",
    );
    for (let i = 0; i < 7; i++) await f.open();
    await refused(f.open(), "resource_limit");
    f.pager.release(f.reader, first.snapshotId, f.guard);
    expect(await f.open()).toMatchObject({ status: "ok" });
  } finally {
    f.pager.invalidate();
  }
});

test("L17 host operation window is finite and source reads remain closed after authority revocation", async () => {
  const f = fixture(1, "x");
  try {
    const first = await f.open();
    for (let i = 0; i < 1023; i++)
      await f.pager.bundle(
        f.reader,
        first.snapshotId,
        first.entries[0]!.bundle.reference,
        0,
        0 + 1,
        f.guard,
        "read",
      );
    await refused(f.open(), "resource_limit");
    f.setNow(160_001);
    f.revokeRegain();
    await refused(f.open(), "read_revoked");
  } finally {
    f.pager.invalidate();
  }
});

test("L17 aggregate cap includes the full encoded controller catalog frame, not only entry sums", async () => {
  const f = fixture(8, "");
  try {
    for (const [index, entry] of f.entries.entries()) {
      entry.clientBundle = "x".repeat(
        1024 * 1024 - Buffer.byteLength(JSON.stringify(entry)) - Number(index === 0),
      );
    }
    expect(
      f.entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0),
    ).toBe(8 * 1024 * 1024 - 1);
    await refused(f.open(), "resource_limit");
  } finally {
    f.pager.invalidate();
  }
});

test("L17 actual runtime owns one pager and invalidates its snapshot on catalog clear without spawning", async () => {
  const spawnChild = vi.fn(() => {
    throw Error("Child must not start in catalog-read proof");
  });
  const runtime = new PluginRuntime(pino({ enabled: false }), "0.10.2", { spawnChild });
  const reader = {},
    guard = () => {},
    trust = { trustedHost: { contract: "1.1" as const, boot: randomUUID() }, trustedPlugins: [] };
  const close = vi.fn();
  const first = await runtime.catalogPaging.open(reader, guard, close, trust, "runtime");
  expect(first.entries).toEqual([]);
  expect(runtime.catalogReadState().revision).toBe(first.revision);
  expect(await runtime.stopPluginById("unknown")).toBe(false);
  runtime.catalogPaging.checkPublication(reader, first.snapshotId, guard);
  await runtime.stopAll();
  expect(runtime.catalogReadState().revision).not.toBe(first.revision);
  expect(() => runtime.catalogPaging.checkPublication(reader, first.snapshotId, guard)).toThrow();
  expect(close).toHaveBeenCalledTimes(1);
  expect(spawnChild).not.toHaveBeenCalled();
});
