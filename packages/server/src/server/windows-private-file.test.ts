import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";

const transport = vi.hoisted(() => ({
  mode: "ok",
  input: "",
  buffer: undefined as SharedArrayBuffer | undefined,
  data: undefined as { script: string } | undefined,
  posts: 0,
  workers: [] as EventEmitter[],
}));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    constructor(_script: string, options: { workerData: { script: string } }) {
      super();
      transport.data = options.workerData;
      transport.workers.push(this);
      queueMicrotask(() => this.emit("message", "READY"));
    }
    unref() {}
    terminate() {
      return Promise.resolve(0);
    }
    postMessage(request: { input: string; buffer: SharedArrayBuffer }) {
      transport.input = request.input;
      transport.buffer = request.buffer;
      transport.posts++;
      if (transport.mode !== "pending") {
        let status = -1;
        if (transport.mode === "ok") status = 1;
        if (transport.mode === "fatal") status = -2;
        Atomics.store(new Int32Array(request.buffer), 0, status);
      }
    }
  },
}));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  transport.mode = "ok";
  transport.posts = 0;
  transport.workers = [];
  vi.resetModules();
});
async function helper(logger = { warn: vi.fn() }) {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  const api = await import("./windows-private-file.js");
  await api.initializeWindowsPrivateFiles(logger);
  return api;
}
test.each([2, 8])("Windows line transport accepts %i MiB without a JSON parser", async (mib) => {
  const api = await helper();
  const bytes = Buffer.alloc(mib * 1024 * 1024, 120);
  api.writeWindowsPrivateFileAtomicSync("journal.json", bytes);
  const [operation, target, value, end] = transport.input.split("\n");
  expect(operation).toBe("W");
  expect(target).toContain("journal.json");
  expect(Buffer.from(value!, "base64").equals(bytes)).toBe(true);
  expect(end).toBe("");
  expect(transport.data!.script).not.toContain("ConvertFrom-Json");
  expect(transport.data!.script).toContain("Console.ReadLine()");
});
test("the compiled commit flushes the target after rename and retries sharing locks", async () => {
  await helper();
  const script = transport.data!.script;
  expect(script.indexOf("targetFile.Flush(true)")).toBeGreaterThan(
    script.indexOf("while (!MoveFileExW"),
  );
  expect(script).toContain("FileMode.Open, FileAccess.ReadWrite");
  expect(script).toContain("error != 5 && error != 32");
  expect(script).toContain("clock.ElapsedMilliseconds >= 1000");
});
test("a bounded timeout blocks reads and later writes until the original commit settles", async () => {
  const api = await helper();
  transport.mode = "pending";
  const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  expect(() => api.writeWindowsPrivateFileAtomicSync("journal.json", "value")).toThrow(
    "requires reconciliation",
  );
  expect(wait).toHaveBeenCalledWith(expect.any(Int32Array), 0, 0, 51);
  expect(() => api.assertWindowsPrivateFilesSettled()).toThrow("requires reconciliation");
  expect(() => api.writeWindowsPrivateFileAtomicSync("journal.json", "other")).toThrow(
    "requires reconciliation",
  );
  expect(transport.posts).toBe(1);
  Atomics.store(new Int32Array(transport.buffer!), 0, 1);
  api.assertWindowsPrivateFilesSettled();
  transport.mode = "ok";
  api.writeWindowsPrivateFileAtomicSync("journal.json", "reconciled");
  expect(transport.posts).toBe(2);
});
test("Windows helper failures and ACL refusals fail closed", async () => {
  const api = await helper();
  transport.mode = "fail";
  expect(() => api.writeWindowsPrivateFileAtomicSync("journal.json", "private value")).toThrow(
    "Windows durable file commit failed.",
  );
  expect(api.windowsPrivateFileAclIsSafe("journal.json", 1)).toBe(false);
});
test("Windows commit requires initialization", async () => {
  const api = await import("./windows-private-file.js");
  expect(() => api.writeWindowsPrivateFileAtomicSync("journal.json", "value")).toThrow(
    "requires reconciliation",
  );
});

test("a terminated helper blocks reconciliation before its exit message is processed", async () => {
  const api = await helper();
  transport.mode = "fatal";
  expect(() => api.writeWindowsPrivateFileAtomicSync("journal.json", "value")).toThrow(
    "requires reconciliation",
  );
  expect(() => api.assertWindowsPrivateFilesSettled()).toThrow("requires reconciliation");
  await expect(api.waitForWindowsPrivateFilesSettled()).rejects.toThrow("helper is unavailable");
});

test.each([
  [0, 50],
  [512 * 1024, 58],
  [1024 * 1024, 65],
  [8 * 1024 * 1024, 170],
  [16 * 1024 * 1024, 250],
])("a %i-byte write has a bounded %i ms wait budget", async (bytes, budget) => {
  const api = await helper();
  const wait = vi.spyOn(Atomics, "wait");
  api.writeWindowsPrivateFileAtomicSync("journal.json", Buffer.alloc(bytes));
  expect(wait).toHaveBeenLastCalledWith(expect.any(Int32Array), 0, 0, budget);
  api.windowsPrivateFileAclIsSafe("journal.json", 1);
  expect(wait).toHaveBeenLastCalledWith(expect.any(Int32Array), 0, 0, 50);
});

test("idle helper restarts back off from one second to 60 seconds without replay", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const logger = { warn: vi.fn() };
  const api = await helper(logger);
  api.writeWindowsPrivateFileAtomicSync("journal.json", "committed");
  for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000].entries()) {
    transport.workers[index]!.emit("exit", 1);
    await api.initializeWindowsPrivateFiles(logger);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(transport.workers).toHaveLength(index + 1);
    expect(api.windowsPrivateFilesReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.workers).toHaveLength(index + 2);
    expect(api.windowsPrivateFilesReady()).toBe(true);
  }
  expect(transport.posts).toBe(1);
  api.writeWindowsPrivateFileAtomicSync("journal.json", "next");
  expect(transport.posts).toBe(2);
});

test("an exit with an uncertain commit logs and keeps its fence without restart", async () => {
  const logger = { warn: vi.fn() };
  const api = await helper(logger);
  transport.mode = "pending";
  vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  expect(() => api.writeWindowsPrivateFileAtomicSync("journal.json", "pending")).toThrow(
    "requires reconciliation",
  );
  transport.workers[0]!.emit("exit", 1);
  await Promise.resolve();
  expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
    "Windows durable file helper exited; commit requires reconciliation.",
  );
  expect(transport.workers).toHaveLength(1);
  expect(api.windowsPrivateFilesReady()).toBe(false);
  expect(() => api.writeWindowsPrivateFileAtomicSync("journal.json", "new")).toThrow(
    "requires reconciliation",
  );
  expect(transport.posts).toBe(1);
  await expect(api.waitForWindowsPrivateFilesSettled()).rejects.toThrow("helper is unavailable");
});

test("ten healthy minutes reset the helper restart delay", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await helper();
  transport.workers[0]!.emit("exit", 1);
  await vi.advanceTimersByTimeAsync(1000);
  transport.workers[1]!.emit("exit", 1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(transport.workers).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(10 * 60000);
  transport.workers[2]!.emit("exit", 1);
  await vi.advanceTimersByTimeAsync(999);
  expect(transport.workers).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(transport.workers).toHaveLength(4);
});
