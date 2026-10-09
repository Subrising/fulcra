import assert from "node:assert/strict";
import test from "node:test";
import { findInText, genericRules, parsePrivateRules } from "./check-machine-data.mjs";

test("a private rule finds its value and the report never repeats it", () => {
  const rules = parsePrivateRules("i\tzork-mini\n\t\\bQuux\\b\n# comment\n");
  assert.equal(rules.length, 2);
  const found = findInText("ok\nhost ZORK-MINI here\nquux lower\nQuux upper", rules, "a.txt");
  assert.deepEqual(found, ["a.txt:2 private-1", "a.txt:4 private-2"]);
  assert.ok(found.every((line) => !/zork|quux/i.test(line)));
});

// The sample is joined at run time, so this file does not trip the check itself.
test("the generic rule finds a device id shape and ignores ordinary ids", () => {
  assert.deepEqual(
    findInText(`udid ${["0000", "8110-", "000A1B2C3D4E5F60"].join("")}`, genericRules, "f"),
    ["f:1 device-id"],
  );
  assert.deepEqual(findInText("uuid 123e4567-e89b-12d3-a456-426614174000", genericRules, "f"), []);
});

test("no private patterns means only the generic rule runs", () => {
  assert.deepEqual(parsePrivateRules(""), []);
  assert.deepEqual(parsePrivateRules(undefined), []);
});
