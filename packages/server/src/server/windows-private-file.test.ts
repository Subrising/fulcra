import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";

const transport = vi.hoisted(() => ({
  mode: "ok",
  input: "",
  buffer: undefined as SharedArrayBuffer | undefined,
  data: undefined as { script: string } | undefined,
  posts: 0,
}));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    constructor(_script: string, options: { workerData: { script: string } }) {
      super();
      transport.data = options.workerData;
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  transport.mode = "ok";
  transport.posts = 0;
  vi.resetModules();
});
async function helper() {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  const api = await import("./windows-private-file.js");
  await api.initializeWindowsPrivateFiles();
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
  expect(wait).toHaveBeenCalledWith(expect.any(Int32Array), 0, 0, 50);
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
    "Windows durable file commit failed",
  );
  expect(() => api.assertWindowsPrivateFilesSettled()).toThrow("requires reconciliation");
  await expect(api.waitForWindowsPrivateFilesSettled()).rejects.toThrow("helper is unavailable");
});
