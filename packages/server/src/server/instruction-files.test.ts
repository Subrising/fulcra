import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertInstructionPath,
  INSTRUCTION_BACKUP_PREFIX,
  replaceInstructionFile,
} from "./instruction-files.js";
const roots: string[] = [];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instruction-preserve-"));
  roots.push(root);
  const file = path.join(root, "CLAUDE.md");
  fs.writeFileSync(file, "installed");
  return { root, file };
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("checked instruction replacement", () => {
  it("updates an unchanged file and retains its displaced original", () => {
    const { root, file } = setup();
    expect(replaceInstructionFile(file, Buffer.from("new"), sha("installed"))).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    const backup = fs.readdirSync(root).find((n) => n.startsWith(INSTRUCTION_BACKUP_PREFIX))!;
    expect(fs.readFileSync(path.join(root, backup), "utf8")).toBe("installed");
  });
  it("preserves an edit made during staging", () => {
    const { file } = setup();
    const original = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        original(...args);
        if (String(args[0]).includes(".instruction-sync-stage-"))
          original(file, "concurrent local edit");
      },
    );
    syncBuiltinESMExports();
    expect(replaceInstructionFile(file, Buffer.from("new"), sha("installed"))).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("concurrent local edit");
  });
  it("restores an edit made while the old inode is displaced", () => {
    const { file } = setup();
    const original = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      original(from, to);
      if (String(from) === file) fs.writeFileSync(to, "late local edit");
    });
    syncBuiltinESMExports();
    expect(replaceInstructionFile(file, Buffer.from("new"), sha("installed"))).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("late local edit");
  });
  it.skipIf(process.platform === "win32")("rejects dangling and parent symbolic links", () => {
    const { root } = setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "instruction-outside-"));
    roots.push(outside);
    const parent = path.join(root, "linked");
    fs.symlinkSync(outside, parent, "dir");
    expect(() => assertInstructionPath(path.join(parent, "AGENTS.md"))).toThrow(/symbolic link/);
    const dangling = path.join(root, "dangling");
    fs.symlinkSync(path.join(outside, "missing"), dangling);
    expect(() => assertInstructionPath(dangling)).toThrow(/symbolic link/);
    expect(fs.existsSync(path.join(outside, "AGENTS.md"))).toBe(false);
  });
});
