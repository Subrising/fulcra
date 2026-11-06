<<<<<<< HEAD
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
=======
import { watchFile, unwatchFile } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
>>>>>>> refs/remotes/upstream/tags/v0.15.0
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
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

<<<<<<< HEAD
test("rewrites the canary until the watcher reports it, then removes it", async () => {
  const watchRoot = await mkdtemp(join(tmpdir(), "paseo-watcher-canary-"));
  cleanupPaths.push(watchRoot);
  const canary = createWatcherLivenessCanary(watchRoot, { timeoutMs: 5_000, rewriteMs: 10 });

  const verification = canary.verify();
  // The first write is "lost": the watcher reports only after a rewrite changed the file.
  await expect
    .poll(async () => readFile(canary.path, "utf8").catch(() => ""))
    .toMatch(/^paseo watcher liveness canary [1-9]\d*\n$/);
  canary.filterEvents([{ path: canary.path, type: "update" }]);

  await expect(verification).resolves.toBeUndefined();
  expect(existsSync(canary.path)).toBe(false);
=======
test("verifies a watcher that starts delivering after the initial canary write", async () => {
  const watchRoot = await mkdtemp(join(tmpdir(), "paseo-watcher-canary-"));
  cleanupPaths.push(watchRoot);
  const canary = createWatcherLivenessCanary(watchRoot);
  const verification = canary.verify();
  const verified = expect(verification).resolves.toBeUndefined();

  // The initial write happens before the observer starts delivering changes.
  await expect.poll(() => readFile(canary.path, "utf8")).toBe("paseo watcher liveness canary\n");
  watchFile(canary.path, { interval: 10 }, () => {
    canary.filterEvents([{ path: canary.path, type: "update" }]);
  });
  try {
    await verified;
    await expect(readFile(canary.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    unwatchFile(canary.path);
  }
});

test("aborting verification stops pulses before removing the canary", async () => {
  const watchRoot = await mkdtemp(join(tmpdir(), "paseo-watcher-canary-"));
  cleanupPaths.push(watchRoot);
  const canary = createWatcherLivenessCanary(watchRoot);
  const controller = new AbortController();
  const verification = canary.verify(controller.signal);
  const cancelled = expect(verification).rejects.toThrow("stop watching");
  await expect.poll(() => readFile(canary.path, "utf8")).toBe("paseo watcher liveness canary\n");
  const initialWrite = (await stat(canary.path)).mtimeMs;
  await expect.poll(async () => (await stat(canary.path)).mtimeMs).toBeGreaterThan(initialWrite);

  controller.abort(new Error("stop watching"));
  await cancelled;
  await expect(readFile(canary.path)).rejects.toMatchObject({ code: "ENOENT" });
>>>>>>> refs/remotes/upstream/tags/v0.15.0
});
