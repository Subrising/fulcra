import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { auditPackagedBundle } from "./no-machine-ties.mjs";
// Exact reviewed upstream bytes live in-repo; no sibling checkout or ASAR dependency.
const fixtures = {
  "node_modules/dotenv/README-es.md": new URL(
    "./fixtures/reviewed-pem/dotenv-README-es.b64",
    import.meta.url,
  ),
  "node_modules/jose/dist/webapi/key/import.js": new URL(
    "./fixtures/reviewed-pem/jose-import.txt",
    import.meta.url,
  ),
};
function createPackage(source, archive) {
  let offset = 0;
  const files = {},
    buffers = [];
  for (const relative of Object.keys(fixtures)) {
    let cursor = files;
    const parts = relative.split("/");
    for (const part of parts.slice(0, -1)) cursor = (cursor[part] ??= { files: {} }).files;
    const bytes = fs.readFileSync(path.join(source, relative));
    cursor[parts.at(-1)] = { size: bytes.length, offset: String(offset) };
    offset += bytes.length;
    buffers.push(bytes);
  }
  const json = Buffer.from(JSON.stringify({ files })),
    headerSize = 8 + json.length + ((4 - (json.length % 4)) % 4);
  const header = Buffer.alloc(8 + headerSize);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerSize, 4);
  header.writeUInt32LE(headerSize - 4, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  fs.writeFileSync(archive, Buffer.concat([header, ...buffers]));
}
const approved = JSON.parse(
  fs.readFileSync(new URL("./reviewed-pem-markers.json", import.meta.url)),
);
test("only the three prime-reviewed vendor marker occurrences may override a credential-shaped finding", async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/pem-review-")),
    src = path.join(root, "src"),
    bundle = path.join(root, "app"),
    archive = path.join(bundle, "Contents/Resources/app.asar");
  try {
    for (const e of approved) {
      const relative = e.file.split("!/")[1],
        target = path.join(src, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fixture = fs.readFileSync(fixtures[relative]);
      // Encoding preserves upstream Markdown whitespace through source checks.
      fs.writeFileSync(
        target,
        relative.endsWith("README-es.md")
          ? Buffer.from(fixture.toString("utf8"), "base64")
          : fixture,
      );
    }
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    await createPackage(src, archive);
    assert.equal(auditPackagedBundle(bundle).passed, false);
    const result = auditPackagedBundle(bundle, approved);
    assert.equal(result.passed, true);
    assert.equal(result.findings.length, 3);
    assert(result.findings.every((h) => h.reviewedFalsePositive === true));
    for (const key of ["file", "sha256", "line", "offset", "pattern", "context"]) {
      const entries = structuredClone(approved);
      entries[0][key] = typeof entries[0][key] === "number" ? entries[0][key] + 1 : "changed";
      assert.throws(() => auditPackagedBundle(bundle, entries), key);
    }
    const target = path.join(src, approved[0].file.split("!/")[1]);
    fs.appendFileSync(target, "\nchanged bytes\n");
    await createPackage(src, archive);
    assert.equal(
      auditPackagedBundle(bundle, approved).passed,
      false,
      "changed dependency bytes require renewed review",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
