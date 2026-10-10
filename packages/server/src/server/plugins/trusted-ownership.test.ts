import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { packagedPluginsDirectory } from "./packaged-directory.js";
import { unsafeOwnership, windowsAclIsSafe } from "./trusted-ownership.js";

const stat = (mode: number, uid: number) => ({ mode, uid }) as never;

test("POSIX rule: group/other write or a foreign owner is refused", () => {
  const options = { platform: "linux" as const };
  expect(unsafeOwnership("f", stat(0o100644, 0), options)).toBe(false);
  expect(unsafeOwnership("f", stat(0o100666, 0), options)).toBe(true);
  expect(unsafeOwnership("f", stat(0o100644, 424242), options)).toBe(true);
  expect(unsafeOwnership("f", stat(0o100644, 424242), { ...options, checkOwner: false })).toBe(
    false,
  );
});

test("Windows rule follows the ACL probe and ignores mode bits", () => {
  const stat666 = stat(0o100666, 0);
  expect(unsafeOwnership("f", stat666, { platform: "win32", aclIsSafe: () => true })).toBe(false);
  expect(unsafeOwnership("f", stat666, { platform: "win32", aclIsSafe: () => false })).toBe(true);
});

test.runIf(process.platform === "win32")(
  "Windows: only this user and the OS may change a trusted folder; anything else fails closed",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "acl-"));
    const icacls = (...args: string[]) =>
      execFileSync("icacls.exe", [root, ...args], { stdio: "pipe" });
    try {
      // Reset to explicit entries so the result does not depend on what the temp folder inherits.
      icacls(
        "/inheritance:r",
        "/grant:r",
        `${process.env.USERNAME}:(OI)(CI)F`,
        "/grant:r",
        "SYSTEM:(OI)(CI)F",
      );
      expect(windowsAclIsSafe(root)).toBe(true);
      icacls("/grant", "Everyone:(OI)(CI)W");
      expect(windowsAclIsSafe(root)).toBe(false);
      expect(windowsAclIsSafe(path.join(root, "missing"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.runIf(process.platform === "win32")(
  "Windows: bundled plugins resolve beside app.asar in the resources folder",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cc-win-"));
    try {
      execFileSync(
        "icacls.exe",
        [
          root,
          "/inheritance:r",
          "/grant:r",
          `${process.env.USERNAME}:(OI)(CI)F`,
          "/grant:r",
          "SYSTEM:(OI)(CI)F",
        ],
        { stdio: "pipe" },
      );
      const resources = path.join(root, "resources");
      await mkdir(path.join(resources, "bundled-plugins"), { recursive: true });
      await writeFile(path.join(resources, "app.asar"), "");
      const entry = pathToFileURL(path.join(resources, "app.asar", "worker.js")).href;
      const found = packagedPluginsDirectory(entry, true);
      expect(found && path.basename(found)).toBe("bundled-plugins");
      expect(existsSync(found as string) && lstatSync(found as string).isDirectory()).toBe(true);
      expect(() => packagedPluginsDirectory("file:///C:/nowhere/worker.js", true)).toThrow(
        "packaged app",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
