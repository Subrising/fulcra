// Reproduce the pre-v3 screenshot weakness without any daemon or external relay.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import assert from "node:assert/strict";
const scratch = mkdtempSync(resolve(".mh1-baseline-"));
try {
  writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
  for (const file of ["crypto", "base64", "encrypted-channel"]) {
    const source = execFileSync("git", ["show", `4b7a7c621:packages/relay/src/${file}.ts`], {
      encoding: "utf8",
    });
    writeFileSync(
      join(scratch, `${file}.js`),
      ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
  }
  const { generateKeyPair, exportPublicKey } = await import(
    pathToFileURL(join(scratch, "crypto.js")).href
  );
  const { createClientChannel, createDaemonChannel } = await import(
    pathToFileURL(join(scratch, "encrypted-channel.js")).href
  );
  const host = generateKeyPair();
  let admitted = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let client, server;
    const base = () => ({ onmessage: null, onclose: null, onerror: null, close() {} });
    server = {
      ...base(),
      send: (data) =>
        queueMicrotask(() => client.onmessage?.({ data, isBinary: data instanceof ArrayBuffer })),
    };
    client = {
      ...base(),
      send: (data) =>
        queueMicrotask(() => server.onmessage?.({ data, isBinary: data instanceof ArrayBuffer })),
    };
    const pending = createDaemonChannel(server, host, { onmessage: () => admitted++ });
    const app = await createClientChannel(client, exportPublicKey(host.publicKey));
    await pending;
    await app.send("hello from copied offer");
    await new Promise((done) => setTimeout(done, 10));
    app.close();
  }
  console.log(
    `Baseline: ${admitted} independent device keys used the same copied offer successfully.`,
  );
  assert.equal(admitted, 1, "A screenshot offer must authorise only one device");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
