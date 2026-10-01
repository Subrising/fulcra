import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packages = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")).packages;

test("EAS creates and reads a local app archive with the maintained tar dependency", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-eas-archive-"));
  const entry = require.resolve("eas-cli/build/commands/upload.js");
  const easRequire = createRequire(entry);
  // Exercise the installed command's private archive functions; all network upload
  // is replaced at its boundary, before loading or calling the command.
  const uploads = easRequire("../uploads");
  const paths = easRequire("../utils/paths");
  const uploaded = [];
  t.mock.method(paths, "getTmpDirectory", () => dir);
  t.mock.method(uploads, "uploadFileAtPathToGCSAsync", async (_client, _kind, file) => {
    uploaded.push(file);
    return "local-fixture-only";
  });
  const command = new Module(entry);
  command.filename = entry;
  command.paths = Module._nodeModulePaths(path.dirname(entry));
  command._compile(
    readFileSync(entry, "utf8") +
      "\nexports.fixture = { uploadAppArchiveAsync, extractAppMetadataAsync };",
    entry,
  );
  try {
    const app = path.join(dir, "Fixture.app");
    await mkdir(path.join(app, "EXUpdates.bundle"), { recursive: true });
    await writeFile(path.join(app, "EXUpdates.bundle/fingerprint"), "local-fingerprint");
    assert.equal(
      await command.exports.fixture.uploadAppArchiveAsync({}, app),
      "local-fixture-only",
    );
    assert.equal(uploaded.length, 1);
    const metadata = await command.exports.fixture.extractAppMetadataAsync(uploaded[0], "ios");
    assert.equal(metadata.fingerprintHash, "local-fingerprint");
    assert.equal(metadata.simulator, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
const uuidCopies = Object.entries(packages).filter(
  ([name, value]) =>
    name.endsWith("node_modules/uuid") && Number(value.version.split(".")[0]) <= 11,
);
const xmlCopies = Object.keys(packages).filter((name) => name.endsWith("/@xmldom/xmldom"));
const v4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

for (const [name, metadata] of uuidCopies) {
  const uuid = require(path.join(root, name));
  test(`${name} preserves v4 IDs, known vectors and valid output buffers`, () => {
    assert.equal(require(path.join(root, name, "package.json")).version, metadata.version);
    const ids = Array.from({ length: 128 }, (_, sample) =>
      uuid.v4({ random: Array.from({ length: 16 }, (_value, byte) => (sample + byte) % 256) }),
    );
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, v4Pattern);
    assert.equal(uuid.v3("www.example.com", uuid.v3.DNS), "5df41881-3aed-3515-88a7-2f4a814cf09e");
    assert.equal(uuid.v5("www.example.com", uuid.v5.DNS), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
    const buffer = new Uint8Array(24).fill(0xaa);
    assert.equal(uuid.v5("www.example.com", uuid.v5.DNS, buffer, 4), buffer);
    assert.deepEqual([...buffer.slice(0, 4), ...buffer.slice(20)], Array(8).fill(0xaa));
    assert.equal(
      Buffer.from(buffer.slice(4, 20)).toString("hex"),
      "2ed6657de927568b95e12665a8aea6a2",
    );
  });
  test(`${name} rejects invalid v3/v5 buffer bounds before mutation`, () => {
    for (const version of ["v3", "v5"])
      for (const [size, offset] of [
        [8, 4],
        [24, 20],
        [24, -1],
      ]) {
        const buffer = new Uint8Array(size).fill(0xaa);
        assert.throws(() => uuid[version]("x", uuid[version].DNS, buffer, offset), RangeError);
        assert(buffer.every((value) => value === 0xaa));
      }
  });
}

test("server named ESM import generates the existing v4 format", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import {v4} from 'uuid'; process.stdout.write(v4());"],
    { cwd: path.join(root, "packages/server"), encoding: "utf8", timeout: 3000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, v4Pattern);
});

test("Expo Bunyan retains its real CommonJS v1 log identifiers", () => {
  const records = [];
  const logger = require("@expo/bunyan").createLogger({
    name: "owned-uuid-fixture",
    streams: [
      {
        type: "raw",
        stream: {
          write(record) {
            records.push(record);
          },
        },
      },
    ],
  });
  logger.info("fixture");
  assert.equal(records.length, 1);
  assert.match(
    records[0].id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("Xcode parses, adds an identified group and round-trips project metadata", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-xcode-"));
  try {
    const file = path.join(directory, "project.pbxproj");
    await writeFile(
      file,
      `// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {
/* Begin PBXGroup section */
AAAAAAAAAAAAAAAAAAAAAAAA = { isa = PBXGroup; children = (); sourceTree = "<group>"; };
/* End PBXGroup section */
/* Begin PBXProject section */
BBBBBBBBBBBBBBBBBBBBBBBB = { isa = PBXProject; mainGroup = AAAAAAAAAAAAAAAAAAAAAAAA; targets = (); };
/* End PBXProject section */
}; rootObject = BBBBBBBBBBBBBBBBBBBBBBBB; }\n`,
    );
    const project = require("xcode").project(file).parseSync();
    const added = project.addPbxGroup([], "OrcaFixture", "Sources");
    assert.match(added.uuid, /^[0-9A-F]{24}$/);
    assert(project.allUuids().includes(added.uuid));
    await writeFile(file, project.writeSync());
    const restored = require("xcode").project(file).parseSync();
    assert.equal(restored.hash.project.objects.PBXGroup[added.uuid].name, "OrcaFixture");
    assert.equal(restored.hash.project.objects.PBXGroup[added.uuid].path, "Sources");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const name of xmlCopies) {
  const xml = require(path.join(root, name));
  test(`${name} preserves ordinary XML and reports malformed end tags`, () => {
    const errors = [];
    const parser = new xml.DOMParser({
      errorHandler: {
        warning(message) {
          errors.push(message);
        },
        error(message) {
          errors.push(message);
        },
        fatalError(message) {
          errors.push(message);
        },
      },
    });
    const doc = parser.parseFromString(
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Orca &amp; Friends"/></manifest>',
      "application/xml",
    );
    assert.equal(errors.length, 0);
    assert.equal(doc.documentElement.firstChild.getAttribute("android:label"), "Orca & Friends");
    parser.parseFromString("<root></root\n extra>", "application/xml");
    assert(errors.some((message) => message.includes("trailing content")));
  });
  test(`${name} enforces strict serialization of constructed malformed nodes`, () => {
    for (const kind of ["cdata", "comment", "pi", "doctype", "element", "attribute", "entity"]) {
      const doc = new xml.DOMImplementation().createDocument(null, "root", null);
      assert.throws(
        () => {
          if (kind === "cdata")
            doc.documentElement.appendChild(doc.createCDATASection("before]]><injected/>after"));
          if (kind === "comment")
            doc.documentElement.appendChild(doc.createComment("bad--><injected/>"));
          if (kind === "pi")
            doc.documentElement.appendChild(
              doc.createProcessingInstruction("target", "bad?><injected/>"),
            );
          if (kind === "doctype") {
            const node = doc.implementation.createDocumentType("root", "", "");
            node.name = "root><injected/";
            doc.insertBefore(node, doc.documentElement);
          }
          if (kind === "element")
            doc.documentElement.appendChild(doc.createElement("x><injected/"));
          if (kind === "attribute") doc.documentElement.setAttribute('x="1" y', "value");
          if (kind === "entity")
            doc.documentElement.appendChild(doc.createEntityReference("bad;<injected/>"));
          new xml.XMLSerializer().serializeToString(doc, false, null, { requireWellFormed: true });
        },
        undefined,
        kind,
      );
    }
  });
}

test("XML parsing and serialization tolerate bounded deep valid documents", () => {
  const modulePath = path.join(root, xmlCopies[0]);
  const script = `const xml = require(process.argv[1]); const input='<n>'.repeat(12000)+'</n>'.repeat(12000); const doc=new xml.DOMParser().parseFromString(input,'application/xml'); process.stdout.write(String(new xml.XMLSerializer().serializeToString(doc).length));`;
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=96", "-e", script, modulePath],
    { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "83997");
});

test("every installed plist consumer round-trips native configuration values", () => {
  const names = Object.keys(packages).filter(
    (name) => name.endsWith("/@expo/plist") || name.endsWith("node_modules/plist"),
  );
  assert(names.length > 0);
  for (const name of names) {
    const module = require(path.join(root, name));
    const plist = module.default ?? module;
    const value = {
      CFBundleIdentifier: "test.orca.fixture",
      CFBundleDisplayName: "Orca & <Friends>",
      enabled: true,
      count: 3,
      fraction: 1.5,
      array: ["portrait", "landscape"],
      nested: { text: 'quoted " ]]> literal' },
    };
    // Plist versions return both plain and null-prototype dictionaries.
    assert.deepEqual(JSON.parse(JSON.stringify(plist.parse(plist.build(value)))), value, name);
  }
});

test("each real UUID and XML consumer resolves and executes the intended release", async () => {
  let uuidConsumers = 0;
  let xmlConsumers = 0;
  for (const [name, metadata] of Object.entries(packages)) {
    const consumer = createRequire(path.join(root, name, "package.json"));
    if (metadata.dependencies?.uuid) {
      uuidConsumers++;
      const expected = name === "node_modules/mermaid" ? "14.0.1" : "11.1.1";
      assert.equal(consumer("uuid/package.json").version, expected, name);
      const uuid = await import(pathToFileURL(consumer.resolve("uuid")).href);
      assert.match(uuid.v4(), v4Pattern, name);
    }
    if (metadata.dependencies?.["@xmldom/xmldom"]) {
      xmlConsumers++;
      assert.equal(consumer("@xmldom/xmldom/package.json").version, "0.8.15", name);
      const xml = consumer("@xmldom/xmldom");
      const doc = new xml.DOMParser().parseFromString(
        "<root>Orca &amp; Friends</root>",
        "application/xml",
      );
      assert.equal(doc.documentElement.textContent, "Orca & Friends", name);
    }
  }
  assert.equal(uuidConsumers, 7);
  assert.equal(xmlConsumers, 9);
});

test("legacy plist wrappers retain their documented permissive malformed-input behavior", () => {
  // These wrappers suppress parser diagnostics; the dependency upgrade does not
  // turn them into strict validators. Keep that boundary explicit.
  const names = Object.keys(packages).filter(
    (name) => name.endsWith("/@expo/plist") || name.endsWith("node_modules/plist"),
  );
  for (const name of names) {
    const module = require(path.join(root, name));
    const plist = module.default ?? module;
    const duplicate = '<plist version="1.0" version="1.0"><dict/></plist>';
    if (name.endsWith("node_modules/plist") && !name.endsWith("/@expo/plist")) {
      assert.throws(() => plist.parse(duplicate), /Attribute version redefined/, name);
    } else {
      assert.deepEqual(JSON.parse(JSON.stringify(plist.parse(duplicate))), {}, name);
    }
    assert.deepEqual(
      JSON.parse(JSON.stringify(plist.parse("<plist><dict/></plist\n extra>"))),
      {},
      name,
    );
  }
});
