import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { HostLinks } from "./host-links.js";

/** File events deliver new limits; the timer retries offline links and repairs a missing watcher. */
export function startHostLimitSharing(
  service: HostLinks,
  home: string,
  warn: () => void,
): () => void {
  let watcher: FSWatcher | null = null;
  let running = false;
  let dirty = false;
  let closed = false;
  const directory = path.join(home, "command-centre", "accounts");
  const pass = async () => {
    if (closed) return;
    dirty = true;
    if (running) return;
    running = true;
    try {
      do {
        dirty = false;
        const result = await service.shareAccountLimits();
        if (result.failed) warn();
        if (closed) break;
      } while (dirty);
    } catch {
      warn();
    } finally {
      running = false;
    }
  };
  const tick = () => {
    if (!watcher) {
      try {
        watcher = watch(directory, (_event, file) => {
          if (file === "accounts.json" || file === "usage-reports.json") void pass();
        });
        watcher.on("error", () => {
          watcher?.close();
          watcher = null;
          warn();
        });
        watcher.unref();
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) warn();
      }
    }
    void pass();
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  return () => {
    closed = true;
    clearInterval(timer);
    watcher?.close();
  };
}
