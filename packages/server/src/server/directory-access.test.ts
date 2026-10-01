import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { createDirectoryInspector, inspectOutOfProcess } from "./directory-access.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "directory-access-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(isPlatform("win32"))("directory access", () => {
  test("a child process reports directories, missing paths and non-directories", async () => {
    const directory = path.join(root, "dir");
    const file = path.join(root, "file");
    const fifo = path.join(root, "fifo");
    await mkdir(directory);
    await writeFile(file, "x");
    // open() on a FIFO waits for a writer, like a folder waiting on a macOS access prompt.
    execFileSync("mkfifo", [fifo]);
    const states = await inspectOutOfProcess(
      [directory, file, fifo, path.join(root, "gone"), path.join(file, "below-a-file")],
      { timeoutMs: 10_000, execPath: process.execPath },
    );
    expect(Object.fromEntries(states)).toEqual({
      [directory]: "directory",
      [file]: "missing",
      [fifo]: "missing",
      [path.join(root, "gone")]: "missing",
      [path.join(file, "below-a-file")]: "missing",
    });
  });

  test("a check that never answers is bounded: every path is unreadable, never missing", async () => {
    // A runtime that hangs, like a child held by a pending consent prompt.
    const hanging = path.join(root, "hanging-runtime");
    await writeFile(hanging, "#!/bin/sh\nexec sleep 60\n");
    await chmod(hanging, 0o755);
    const started = Date.now();
    const states = await inspectOutOfProcess([root, path.join(root, "gone")], {
      timeoutMs: 300,
      execPath: hanging,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(Object.fromEntries(states)).toEqual({
      [root]: "unreadable",
      [path.join(root, "gone")]: "unreadable",
    });
  });

  test("a runtime that cannot start leaves paths unreadable", async () => {
    const states = await inspectOutOfProcess([root], {
      timeoutMs: 5_000,
      execPath: path.join(root, "no-such-runtime"),
    });
    expect(states.get(root)).toBe("unreadable");
  });

  test("off macOS the check stays in process with the same answers", async () => {
    await writeFile(path.join(root, "file"), "x");
    const inspect = createDirectoryInspector({ platform: "linux", execPath: "/nonexistent" });
    const states = await inspect([root, path.join(root, "file"), path.join(root, "gone")]);
    expect(Object.fromEntries(states)).toEqual({
      [root]: "directory",
      [path.join(root, "file")]: "missing",
      [path.join(root, "gone")]: "missing",
    });
  });
});
