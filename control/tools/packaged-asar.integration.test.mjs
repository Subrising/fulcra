import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { auditPackagedBundle } from "./no-machine-ties.mjs";
// Needs the product checkout whose @electron/asar emits the archive: FULCRA_TEST_PRODUCT. Skipped where it is not set.
const skip = process.env.FULCRA_TEST_PRODUCT
  ? false
  : "FULCRA_TEST_PRODUCT is not set (in-tree product dependency checkout)";
test("audit reads archives emitted by the actual packaging dependency", { skip }, async () => {
  const require = createRequire(path.join(process.env.FULCRA_TEST_PRODUCT, "package.json"));
  const asar = await import(pathToFileURL(require.resolve("@electron/asar")).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "actual-asar-"));
  try {
    const source = path.join(temp, "input"),
      bundle = path.join(temp, "app"),
      archive = path.join(bundle, "Contents/Resources/app.asar");
    fs.mkdirSync(path.join(source, "node_modules/vendor"), { recursive: true });
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const content = ["", "Users", "runner", "source"].join("/");
    fs.writeFileSync(path.join(source, "node_modules/vendor/index.js"), content);
    fs.writeFileSync(path.join(source, "main.js"), "portable");
    await asar.createPackage(source, archive);
    const exemptions = [
      {
        file: "Contents/Resources/app.asar!/node_modules/vendor/index.js",
        sha256: createHash("sha256").update(content).digest("hex"),
        patterns: [content.slice(0, 7)],
        justification: "Fixture vendor compiler path",
      },
    ];
    assert.equal(auditPackagedBundle(bundle, exemptions).passed, true);
    fs.writeFileSync(path.join(source, "main.js"), content);
    await asar.createPackage(source, archive);
    const result = auditPackagedBundle(bundle, exemptions);
    assert.equal(result.passed, false);
    assert(result.unexempted.some((hit) => hit.file.endsWith("!/main.js")));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
