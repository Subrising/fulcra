import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

// trusted-contribution.mjs needs the root workspace packages (@getpaseo/*). Without them this test skips; the
// real-host list in trusted-contribution.test.mjs covers the same names.
let privateDenyRules = null;
try {
  ({ privateDenyRules } = await import("./trusted-contribution.mjs"));
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

test("an agent cannot read or rewrite the pipe name file: it is in the protected controller state", {
  skip: privateDenyRules ? false : "workspace packages are not installed",
}, () => {
  const home = path.join(os.tmpdir(), "cc-home");
  const rules = privateDenyRules(home);
  for (const name of ["control.sock", "control.pipe", "control.pipe.*"])
    for (const tool of ["Read", "Edit", "Write"])
      assert.ok(rules.includes(`${tool}(/${path.join(home, name)})`), `${tool} ${name}`);
  assert.ok(rules.includes(`Bash(*${path.join(home, "control.pipe")}*)`));
});
