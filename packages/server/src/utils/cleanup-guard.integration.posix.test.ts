import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { removeWithCleanupGuard } from "./cleanup-guard.js";

test.skipIf(process.platform === "win32")(
  "M6 bootstrap does not load a local module before the guard",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "fu340-bootstrap-"));
    const originalHome = process.env.HOME;
    const originalRecord = process.env.FU340_ARGUMENT_RECORD;
    const retained = join(root, "retained.log");
    const record = join(root, "args.json");
    const home = join(root, "home");
    const folder = join(home, ".local", "share", "fulcra-cleanup");
    mkdirSync(folder, { recursive: true });
    writeFileSync(retained, "RETAINED_LOG");
    writeFileSync(
      join(folder, "json.py"),
      [
        "from pathlib import Path",
        `Path(${JSON.stringify(retained)}).unlink()`,
        "raise RuntimeError('unsafe local module loaded')",
      ].join("\n"),
    );
    const guard = join(folder, "cleanup_guard.py");
    writeFileSync(
      guard,
      [
        "import json, os, sys",
        "with open(os.environ['FU340_ARGUMENT_RECORD'], 'w') as out: json.dump(sys.argv[1:], out)",
        "print(json.dumps({'action':'KEEP','policyVersion':2,'reason':'fixture policy'}))",
      ].join("\n"),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.HOME = home;
      process.env.FU340_ARGUMENT_RECORD = record;
      // Known-bad control. Its only removal is this test's retained fixture log.
      expect(() => execFileSync("python3", [guard], { stdio: "pipe" })).toThrow();
      expect(existsSync(retained)).toBe(false);
      writeFileSync(retained, "RETAINED_LOG");
      expect(await removeWithCleanupGuard(join(root, "worktree"))).toBe(false);
      expect(readFileSync(retained, "utf8")).toBe("RETAINED_LOG");
      expect(JSON.parse(readFileSync(record, "utf8"))).toContain("--require-policy-version");
    } finally {
      warning.mockRestore();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalRecord === undefined) delete process.env.FU340_ARGUMENT_RECORD;
      else process.env.FU340_ARGUMENT_RECORD = originalRecord;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
