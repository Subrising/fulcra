import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { auditPackagedBundle } from "./packaged-audit.mjs";
import { approvedPublicLiteral, matchesPublicLiteral } from "./public-literal-policy.mjs";
const catalog = JSON.parse(
  fs.readFileSync(new URL("./reviewed-public-literals.json", import.meta.url)),
);

test("actual source-bound public package, schema/GUID and documentation examples match only their recorded occurrence", () => {
  assert(catalog.length > 0);
  for (const row of catalog) {
    assert(approvedPublicLiteral(row), row.file);
    assert(matchesPublicLiteral(row, row.file, row.sha256, row));
    for (const key of ["file", "sha256", "line", "offset", "pattern", "context"]) {
      const changed = structuredClone(row);
      changed[key] =
        key === "sha256"
          ? (changed[key][0] === "0" ? "1" : "0") + changed[key].slice(1)
          : typeof changed[key] === "number"
            ? changed[key] + 1
            : changed[key] + "changed";
      assert.equal(approvedPublicLiteral(changed), false, key);
    }
    for (const key of Object.keys(row.source)) {
      const changed = structuredClone(row);
      changed.source[key] =
        key === "sha256" || key === "commit"
          ? (changed.source[key][0] === "0" ? "1" : "0") + changed.source[key].slice(1)
          : changed.source[key] + "changed";
      assert.equal(approvedPublicLiteral(changed), false, `source.${key}`);
    }
  }
  assert(catalog.some((row) => row.source.kind === "public-standard"));
  assert(catalog.some((row) => row.source.literal === "/users/0/name"));
  assert(catalog.some((row) => row.source.package === "effect" && row.pattern === "/volumes/"));
  const guid = catalog.find((row) => row.pattern === "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  assert(guid);
  assert.equal(
    matchesPublicLiteral(guid, guid.file, guid.sha256, {
      ...guid,
      context: guid.context + "/Users/private-owner/secret",
    }),
    false,
  );
});

function makeArchive(file, bytes) {
  const files = {
    node_modules: {
      files: {
        uuid: {
          files: {
            dist: { files: { esm: { files: { "nil.js": { size: bytes.length, offset: "0" } } } } },
          },
        },
      },
    },
  };
  const json = Buffer.from(JSON.stringify({ files }));
  const headerSize = 8 + json.length + ((4 - (json.length % 4)) % 4);
  const header = Buffer.alloc(8 + headerSize);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerSize, 4);
  header.writeUInt32LE(headerSize - 4, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  fs.writeFileSync(file, Buffer.concat([header, bytes]));
}
test("real verified upstream fixture passes exact classification while nearby private/unknown/credential findings still fail", () => {
  const row = catalog.find(
    (item) => item.file === "Contents/Resources/app.asar!/node_modules/uuid/dist/esm/nil.js",
  );
  assert(row);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-literal-policy-"));
  const archive = path.join(root, "Contents/Resources/app.asar");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const bytes = fs.readFileSync(
    new URL("./fixtures/reviewed-public/uuid-nil.txt", import.meta.url),
  );
  try {
    makeArchive(archive, bytes);
    assert.equal(auditPackagedBundle(root).passed, false, "raw findings remain inspectable");
    const positive = auditPackagedBundle(root, [row]);
    assert.equal(positive.passed, true);
    assert(
      positive.findings.every(
        (hit) => hit.blocker && hit.sourceEvidence && hit.reviewedFalsePositive,
      ),
    );
    const privateValues = [
      "12345678-abcd-4000-8000-123456789abc",
      "/Users/private-owner/secret",
      "/Volumes/private-machine/data",
      "srv_privateHost",
      "sk-" + "a".repeat(40),
    ];
    for (const value of privateValues) {
      makeArchive(archive, Buffer.concat([bytes, Buffer.from(`\n${value}\n`)]));
      assert.equal(
        auditPackagedBundle(root, [row]).passed,
        false,
        "changed bound artifact refuses",
      );
      makeArchive(archive, bytes);
      const extra = path.join(root, "Contents/Resources/other.txt");
      fs.writeFileSync(extra, value);
      const result = auditPackagedBundle(root, [row]);
      assert.equal(result.passed, false, "independently scanned nearby material refuses");
      assert(result.unexempted.some((hit) => hit.file.endsWith("other.txt")));
      fs.unlinkSync(extra);
    }
    const fake = structuredClone(row);
    fake.pattern = privateValues[0];
    fake.source.literal = fake.pattern;
    assert.throws(() => auditPackagedBundle(root, [fake]), /Incomplete exact generic review/);
    const missingSource = structuredClone(row);
    delete missingSource.source;
    assert.throws(
      () => auditPackagedBundle(root, [missingSource]),
      /Incomplete exact generic review/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
