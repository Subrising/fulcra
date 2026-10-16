import { expect, test, vi } from "vitest";
import treeKill from "tree-kill";
import { signalProcessTree, withDetachedJobsPreserved } from "./tree-kill.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file, _args, _options, callback) => {
    callback(new Error("ps unavailable"), "", "");
  }),
}));
vi.mock("tree-kill", () => ({ default: vi.fn() }));

test.runIf(process.platform !== "win32")(
  "terminates the retained child when ps fails without crossing detached groups",
  async () => {
    const child = { pid: 1234, exitCode: null, signalCode: null, kill: vi.fn(() => true) };
    await withDetachedJobsPreserved(() => signalProcessTree(child, "SIGKILL"));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(treeKill).not.toHaveBeenCalled();
  },
);
