import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const fixture = process.env.FULCRA_REPRO_FIXTURE;
const options = {
  skip: fixture
    ? false
    : "No FULCRA_REPRO_FIXTURE: prepare two client builds under heavy-lock; this is not reproducibility acceptance",
};
test(
  "F1.1 independently staged real Command Centre clients have identical bytes and manifest pins",
  options,
  () => {
    const root = process.env.FULCRA_REPRO_FIXTURE;
    assert(root, "Prepare the two client builds under heavy-lock first");
    const first = fs.readFileSync(path.join(root, "first.js")),
      second = fs.readFileSync(path.join(root, "second.js"));
    const a = JSON.parse(fs.readFileSync(path.join(root, "first.json"))),
      b = JSON.parse(fs.readFileSync(path.join(root, "second.json")));
    assert.notEqual(a.staging, b.staging);
    assert.equal(a.client, b.client, "independent staging must not change the pin");
    assert(first.equals(second), "client files must be byte-identical");
    assert.equal(a.client, createHash("sha256").update(first).digest("hex"));
    assert(!first.includes(Buffer.from(a.staging)) && !second.includes(Buffer.from(b.staging)));
  },
);

test("F1.1 stable compilation root retains transitive shared import rejection", options, () => {
  const result = JSON.parse(
    fs.readFileSync(path.join(process.env.FULCRA_REPRO_FIXTURE, "boundary.json")),
  );
  assert.match(result.error, /plugin shared/);
});
