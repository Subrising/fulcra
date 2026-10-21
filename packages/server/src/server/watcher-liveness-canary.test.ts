import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createWatcherLivenessCanary } from "./watcher-liveness-canary.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("requires the canary event to round-trip through the watcher callback", async () => {
  const watchRoot = await mkdtemp(join(tmpdir(), "paseo-watcher-canary-"));
  cleanupPaths.push(watchRoot);
  const canary = createWatcherLivenessCanary(watchRoot, { timeoutMs: 1_000 });

  const verification = canary.verify();
  const canaryPath = canary.path;
  expect(canary.filterEvents([{ path: canaryPath, type: "create" }])).toEqual([]);

  await expect(verification).resolves.toBeUndefined();
});

test("rejects when the watcher never reports the canary", async () => {
  const watchRoot = await mkdtemp(join(tmpdir(), "paseo-watcher-canary-"));
  cleanupPaths.push(watchRoot);
  const canary = createWatcherLivenessCanary(watchRoot, { timeoutMs: 10 });

  await expect(canary.verify()).rejects.toThrow("did not report its liveness canary");
});

test("rewrites the canary when the watcher drops the first event", async () => {
  const watchRoot = await mkdtemp(join(tmpdir(), "paseo-watcher-canary-"));
  cleanupPaths.push(watchRoot);
  const canary = createWatcherLivenessCanary(watchRoot, { timeoutMs: 5_000, retryMs: 20 });

  const verification = canary.verify();
  // The first write is "lost": the watcher reports only after the canary is written again.
  await vi.waitFor(async () => {
    expect(await readFile(canary.path, "utf8")).toContain("canary 2");
  });
  canary.filterEvents([{ path: canary.path, type: "update" }]);

  await expect(verification).resolves.toBeUndefined();
});
