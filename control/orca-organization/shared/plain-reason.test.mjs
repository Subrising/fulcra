import test from "node:test";
import assert from "node:assert/strict";
import { plainReason } from "./plain-reason.mjs";
test("U5-D06: controller refusal prefixes read in plain words; the rest of the reason and other text pass through", () => {
  assert.equal(
    plainReason("Orca native admission refused: coordinator not attached"),
    "Fulcra's safety check did not let this message through: coordinator not attached",
  );
  assert.equal(
    plainReason("Request failed: Orca native permission refused: remote grant changed"),
    "Fulcra's safety check did not allow this permission: remote grant changed",
  );
  assert.equal(
    plainReason("Orca native admission refused stale, busy or changed session"),
    "Fulcra's safety check did not let this message through: stale, busy or changed session",
  );
  assert.equal(
    plainReason("Orca native admission refused"),
    "Fulcra's safety check did not let this message through.",
  );
  assert.equal(
    plainReason("Human input has already reached this session"),
    "Human input has already reached this session",
  );
  assert.equal(plainReason(null), null);
});
