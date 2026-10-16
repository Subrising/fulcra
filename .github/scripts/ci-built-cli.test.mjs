import assert from "node:assert/strict";
import test from "node:test";
import { requireBuiltCli } from "./ci-built-cli.mjs";

test("the CI CLI runner refuses a partial compiled stack", async () => {
  const checked = [];
  await requireBuiltCli("/fixture", async (file) => checked.push(file));
  assert.equal(checked.length, 4);
  for (const missing of checked) {
    await assert.rejects(
      requireBuiltCli("/fixture", async (file) => {
        if (file === missing) throw new Error("missing");
      }),
      /Missing exact CI build input/,
    );
  }
});
