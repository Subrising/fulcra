import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
test("retained overlay and provider repair routes import without running a repair", () => {
  for (const route of ["./permission-overlay.py", "../../provider-patches/deploy.py"]) {
    const result = execFileSync(
      "python3",
      [
        "-B",
        "-c",
        'import importlib.util,sys\ns=importlib.util.spec_from_file_location("repair",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);assert callable(m.m.Switch);print("loaded")',
        fileURLToPath(new URL(route, import.meta.url)),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.trim(), "loaded");
  }
});
