import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCommitSnapshot } from "./read-commit.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: undefined },
  }).trim();
}

function hasLocalObject(cwd: string, oid: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", oid], {
      cwd,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// FULCRA(partial-clone): a --filter=blob:none clone must not fetch every blob to list a commit.
describe("readCommitSnapshot in a partial clone", () => {
  it("reads the code without fetching blobs the map does not parse", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "read-commit-partial-"));
    dirs.push(root);
    const source = path.join(root, "source");
    mkdirSync(path.join(source, "src"), { recursive: true });
    git(source, "init", "-q", "-b", "main");
    git(source, "config", "uploadpack.allowFilter", "true");
    git(source, "config", "uploadpack.allowAnySHA1InWant", "true");
    writeFileSync(path.join(source, "package.json"), '{"name":"demo"}\n');
    writeFileSync(path.join(source, "src", "index.ts"), 'export const a = "first";\n');
    git(source, "add", ".");
    git(source, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "one");
    writeFileSync(path.join(source, "src", "index.ts"), 'export const a = "second";\n');
    writeFileSync(path.join(source, "picture.png"), Buffer.alloc(2 * 1024 * 1024, 7));
    git(source, "add", ".");
    git(source, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "two");
    const head = git(source, "rev-parse", "HEAD");
    const picture = git(source, "rev-parse", "HEAD:picture.png");

    const clone = path.join(root, "clone");
    git(root, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${source}`, clone);
    expect(hasLocalObject(clone, picture)).toBe(false);

    return readCommitSnapshot(clone, head).then((snapshot) => {
      expect(snapshot.files.map((f) => f.path).sort()).toEqual([
        "package.json",
        "picture.png",
        "src/index.ts",
      ]);
      expect(snapshot.texts.get("src/index.ts")).toBe('export const a = "second";\n');
      expect(hasLocalObject(clone, picture)).toBe(false);
    });
  });
});
