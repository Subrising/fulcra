import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const tool = new URL("./v5-exact-audit.mjs", import.meta.url);
test("V5 consumes the exact audit: confined links scanned, escape and changed reviews fail", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v5-audit-"));
  try {
    const app = path.join(root, "Fulcra.app");
    fs.mkdirSync(path.join(app, "Contents/Frameworks/Example.framework/Versions/A"), {
      recursive: true,
    });
    const file = "Contents/Frameworks/Example.framework/Versions/A/library";
    fs.writeFileSync(path.join(app, file), "generic timeout 3200 ms");
    fs.symlinkSync("A", path.join(app, "Contents/Frameworks/Example.framework/Versions/Current"));
    const reviews = path.join(root, "reviews.json");
    fs.writeFileSync(reviews, "[]");
    const run = () =>
      spawnSync(process.execPath, [tool.pathname, app, reviews], { encoding: "utf8" });
    let r = run();
    assert.equal(r.status, 1);
    const red = JSON.parse(r.stdout);
    assert.equal(red.unexempted.length, 1);
    const hit = red.unexempted[0];
    fs.writeFileSync(
      reviews,
      JSON.stringify([
        {
          ...hit,
          kind: "vendor-generic",
          justification: "Fixture numeric timeout, not a personal path.",
        },
      ]),
    );
    r = run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(JSON.parse(r.stdout).passed, true);
    fs.appendFileSync(path.join(app, file), " changed");
    assert.equal(run().status, 1);
    fs.writeFileSync(path.join(root, "outside"), "safe");
    fs.symlinkSync(path.join(root, "outside"), path.join(app, "escape"));
    assert.equal(run().status, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("V5 checker passes explicit reviewed matches and requires structured complete audit", () => {
  const script = fs.readFileSync(new URL("../docs/v5/v5-check.sh", import.meta.url), "utf8");
  assert.match(script, /--scan-reviews/);
  assert.match(script, /v5-exact-audit\.mjs/);
  assert.match(script, /audit\['passed'\]/);
  assert.doesNotMatch(script, /'No machine ties: PASS' in r.stdout/);
});
