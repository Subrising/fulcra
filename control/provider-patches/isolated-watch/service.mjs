import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { WatchRegistry } from "./registry.mjs";
const MAX_FRAME = 16384;
const failure = (code, message) => Object.assign(new Error(message), { code });
export function createWatchService({
  directory,
  timeoutMs = 5000,
  limit = 16,
  launch = spawn,
  registry = new WatchRegistry(directory, { limit }),
  helper = fileURLToPath(new URL("./watch-child.mjs", import.meta.url)),
}) {
  const entries = new Map(),
    metrics = {
      capacityFailures: 0,
      quarantinedPaths: 0,
      startupFailures: 0,
      protocolFailures: 0,
      overflowAudits: 0,
      registryFailures: 0,
    };
  let tail = Promise.resolve(),
    closed = false;
  function watch(root, options, listener) {
    if (closed) throw failure("WATCH_CLOSED", "Watcher service closed");
    if (
      typeof root !== "string" ||
      !path.isAbsolute(root) ||
      root.includes("\0") ||
      Buffer.byteLength(root) > 4096 ||
      typeof options?.recursive !== "boolean" ||
      typeof listener !== "function"
    )
      throw failure("WATCH_INPUT", "Invalid isolated watch scope");
    root = path.resolve(root);
    const key = JSON.stringify([root, options.recursive]);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        root,
        recursive: options.recursive,
        nonce: randomBytes(16).toString("hex"),
        clients: new Set(),
        child: null,
        ready: false,
        closed: false,
        buffer: "",
        timer: null,
      };
      entries.set(key, entry);
      entry.timer = setTimeout(
        () => end(entry, failure("WATCH_TIMEOUT", "Isolated watcher readiness timed out")),
        timeoutMs,
      );
      const run = tail.then(() => start(entry));
      tail = run.catch(() => {});
      run.catch((error) => end(entry, error));
    }
    const { promise, resolve, reject } = /** @type {PromiseWithResolvers<void>} */ (
      Promise.withResolvers()
    );
    const client = Object.assign(new EventEmitter(), {
      ready: promise,
      settle: (error) => (error ? reject(error) : resolve()),
      close: () => {
        if (!entry.clients.delete(client)) return;
        reject(failure("WATCH_CLOSED", "Watcher closed"));
        client.removeAllListeners();
        if (!entry.clients.size) end(entry);
      },
    });
    client.ready.catch(() => {});
    client.on("change", listener);
    entry.clients.add(client);
    if (entry.ready) resolve();
    return client;
  }
  async function start(entry) {
    await registry.refresh();
    if (entry.closed) return;
    if ([...registry.rows.values()].some((row) => row.key === entry.key)) {
      metrics.quarantinedPaths++;
      throw failure("WATCH_QUARANTINED", "Prior watcher has not exited; degraded polling required");
    }
    if (registry.rows.size >= limit) {
      metrics.capacityFailures++;
      throw failure(
        "WATCH_CAPACITY",
        "Isolated watcher capacity reached; degraded polling required",
      );
    }
    const child = launch(process.execPath, [helper, entry.nonce], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: process.env.LANG ?? "en_US.UTF-8" },
    });
    entry.child = child;
    child.on("error", () => end(entry, failure("WATCH_CHILD", "Watcher child could not start")));
    child.on("exit", () => {
      void registry.remove(entry.nonce).catch(() => metrics.registryFailures++);
      end(entry, failure("WATCH_EXIT", "Watcher child exited"));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => consume(entry, chunk));
    child.stdout.on("error", () =>
      end(entry, failure("WATCH_PIPE", "Watcher protocol stream failed")),
    );
    child.stdin.on("error", () => end(entry, failure("WATCH_PIPE", "Watcher startup pipe failed")));
    await registry.track({ pid: child.pid, nonce: entry.nonce, key: entry.key, helper });
    if (entry.closed || child.exitCode !== null || child.signalCode !== null) {
      child.kill("SIGKILL");
      await registry.remove(entry.nonce);
      return;
    }
    child.stdin.write(JSON.stringify({ root: entry.root, recursive: entry.recursive }) + "\n");
  }
  function consume(entry, chunk) {
    if (entry.closed) return;
    let offset = 0;
    while (offset < chunk.length && !entry.closed) {
      const at = chunk.indexOf("\n", offset),
        part = chunk.slice(offset, at < 0 ? chunk.length : at);
      if (Buffer.byteLength(entry.buffer) + Buffer.byteLength(part) > MAX_FRAME) return bad(entry);
      entry.buffer += part;
      if (at < 0) break;
      let value;
      try {
        value = JSON.parse(entry.buffer);
      } catch {
        return bad(entry);
      }
      entry.buffer = "";
      offset = at + 1;
      if (value?.type === "ready" && Object.keys(value).join() === "type" && !entry.ready) {
        entry.ready = true;
        clearTimeout(entry.timer);
        for (const c of entry.clients) c.settle();
        continue;
      }
      if (
        value?.type === "error" &&
        Object.keys(value).sort().join() === "code,type" &&
        typeof value.code === "string" &&
        /^WATCH_[A-Z_]{1,32}$/.test(value.code)
      )
        return end(entry, failure(value.code, "Native watcher failed; degraded polling required"));
      const name = value?.filename;
      if (
        !entry.ready ||
        value?.type !== "event" ||
        Object.keys(value).sort().join() !== "eventType,filename,type" ||
        !["change", "rename"].includes(value.eventType) ||
        (name !== null &&
          (typeof name !== "string" ||
            path.isAbsolute(name) ||
            name.includes("\0") ||
            name.split("/").includes("..")))
      )
        return bad(entry);
      if (name === null) metrics.overflowAudits++;
      for (const c of [...entry.clients])
        if (entry.clients.has(c)) c.emit("change", value.eventType, name);
    }
  }
  function bad(entry) {
    metrics.protocolFailures++;
    end(entry, failure("WATCH_PROTOCOL", "Malformed or oversized watcher frame"));
  }
  function end(entry, error) {
    if (entry.closed) return;
    entry.closed = true;
    clearTimeout(entry.timer);
    entries.delete(entry.key);
    entry.buffer = "";
    if (error)
      metrics.lastFailureCode = /^WATCH_[A-Z_]+$/.test(error.code ?? "")
        ? error.code
        : "WATCH_REGISTRY";
    if (error && !entry.ready) metrics.startupFailures++;
    for (const c of [...entry.clients]) {
      c.settle(error ?? failure("WATCH_CLOSED", "Watcher closed"));
      if (error && c.listenerCount("error")) c.emit("error", error);
    }
    entry.clients.clear();
    if (entry.child && entry.child.exitCode === null && entry.child.signalCode === null)
      entry.child.kill("SIGKILL");
    // The registry retains the path and slot until an actual exit/identity check.
  }
  return {
    watch,
    diagnostics: () => ({
      ...metrics,
      subscriptions: [...entries.values()].reduce((n, e) => n + e.clients.size, 0),
      activeRoots: entries.size,
      readyRoots: [...entries.values()].filter((e) => e.ready).length,
      trackedChildren: registry.rows.size,
      limit,
    }),
    close: () => {
      closed = true;
      for (const e of [...entries.values()]) end(e);
    },
  };
}
