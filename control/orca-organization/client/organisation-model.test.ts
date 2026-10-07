import test from "node:test";
import assert from "node:assert/strict";
import { primeName } from "./organisation-model";

test("a main assistant seat reads as a name, without saying main twice", () => {
  assert.equal(primeName("delivery"), "Delivery main assistant");
  assert.equal(primeName("game-studio"), "Game studio main assistant");
  assert.equal(primeName("main"), "Main assistant");
  assert.equal(primeName("prime"), "Main assistant");
  assert.equal(primeName("fulcra-prime"), "Fulcra main assistant");
  assert.equal(primeName("main-assistant"), "Main assistant");
});
