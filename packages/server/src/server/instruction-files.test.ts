import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertInstructionPath,
  INSTRUCTION_FILE_POLICY,
  offerInstructionUpdate,
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

describe("bundled update offers", () => {
  it("keeps the exact instruction file policy", () => {
    expect(INSTRUCTION_FILE_POLICY).toBe(
      "Fulcra never overwrites, modifies or reinstalls a file that the user or an agent edited. If an upstream (Paseo) or Fulcra update brings a newer bundled version of an edited file, write it beside the file as <name>.new (or a dated copy), keep the user's file, and tell the owner once. Install a bundled file only if it is missing or byte-identical to an older bundled version.",
    );
  });
  it("keeps an edited file, writes .new, and tells the owner once across module reloads", async () => {
    const { file } = setup();
    fs.writeFileSync(file, "user or agent edit");
    const before = fs.statSync(file);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = offerInstructionUpdate(file, Buffer.from("new bundle"));
    expect(first).toEqual({ path: `${file}.new`, created: true });
    expect(fs.readFileSync(file, "utf8")).toBe("user or agent edit");
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(`${file}.new`, "utf8")).toBe("new bundle");
    vi.resetModules();
    const reloaded = await import("./instruction-files.js");
    expect(reloaded.offerInstructionUpdate(file, Buffer.from("new bundle"))).toEqual({
      path: `${file}.new`,
      created: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("keeps edited update copies and uses a dated copy for another version", () => {
    const { file } = setup();
    fs.writeFileSync(`${file}.new`, "edited pending copy");
    const result = offerInstructionUpdate(file, Buffer.from("next bundle"));
    expect(result.created).toBe(true);
    expect(result.path).toMatch(/\.new\.\d{8}\.[a-f0-9]{16}$/);
    expect(fs.readFileSync(`${file}.new`, "utf8")).toBe("edited pending copy");
    expect(fs.readFileSync(result.path!, "utf8")).toBe("next bundle");
    expect(offerInstructionUpdate(file, Buffer.from("next bundle")).created).toBe(false);
  });
});
