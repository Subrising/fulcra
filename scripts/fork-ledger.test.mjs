import test from "node:test";
import assert from "node:assert/strict";
import { attribute } from "./fork-ledger.mjs";

test("a path that names a patch decides it", () => {
  assert.equal(
    attribute("packages/server/src/server/message-receipts/index.ts").patch,
    "orchestration",
  );
  assert.equal(attribute("packages/server/src/server/pairing/device-registry.ts").patch, "pairing");
  assert.equal(attribute(".github/workflows/ci.yml").patch, "build-ci");
});

test("shared files are attributed by hunk content and mixed ones become seams", () => {
  const hunk = (lines) => `@@ -1 +1 @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
  const receipts = hunk(Array(70).fill("recordReceipt(report)"));
  const admission = hunk(Array(60).fill("refuseUnlessAdmitted(seat)"));
  const single = attribute("packages/server/src/server/session.ts", receipts);
  assert.deepEqual(single, { patch: "orchestration", split: null });
  const mixed = attribute("packages/server/src/server/session.ts", receipts + admission);
  assert.equal(mixed.patch, "orchestration");
  assert.deepEqual(Object.keys(mixed.split), ["orchestration", "admission"]);
});

test("unattributed app code is product UI, other code is a core fix", () => {
  const plain = "@@ -1 +1 @@\n+const x = 1;\n";
  assert.equal(attribute("packages/app/src/components/button.tsx", plain).patch, "features");
  assert.equal(attribute("packages/server/src/utils/checkout-git.ts", plain).patch, "core-fixes");
});
