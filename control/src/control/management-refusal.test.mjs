import test from "node:test";
import assert from "node:assert/strict";
import { managementReplyFailure, managementRefusal } from "./management-refusal.mjs";
test("deterministic precondition is invalid with a bounded public message", () => {
  const error = managementRefusal("Unresolved work must be reconciled before leadership transfer");
  assert.deepEqual(managementReplyFailure(error, true, false), {
    code: "invalid",
    message: "Unresolved work must be reconciled before leadership transfer",
  });
});
test("unclassified post-dispatch failure remains uncertain and private", () => {
  assert.deepEqual(managementReplyFailure(Error("private provider details"), true, false), {
    code: "uncertain",
  });
  assert.deepEqual(
    managementReplyFailure(Object.assign(Error("pretend safe"), { code: "invalid" }), true, false),
    { code: "uncertain" },
  );
});
test("read failures and pre-dispatch failures keep existing classifications", () => {
  assert.deepEqual(managementReplyFailure(Error("read failed"), true, true), {
    code: "unavailable",
  });
  assert.deepEqual(managementReplyFailure(Error("bad command"), false, false), { code: "invalid" });
});
