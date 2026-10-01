import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfferStore } from "./offer-store.js";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "fulcra-pair-test-"));
  homes.push(home);
  return { home, store: new OfferStore(home) };
}
it("consumes a screenshot offer exactly once, including across store instances", () => {
  const { home, store } = setup();
  const offer = store.mint();
  expect(store.claim(offer.id, offer.secret)).toBe(true);
  expect(new OfferStore(home).claim(offer.id, offer.secret)).toBe(false);
});
it("refuses expired offers and wrong secrets without consuming a valid offer", () => {
  const { store } = setup();
  const offer = store.mint(600, 1000);
  expect(store.claim(offer.id, "wrong", 2000)).toBe(false);
  expect(store.claim(offer.id, offer.secret, 601000)).toBe(false);
});
it("keeps at most four offers and stores only hashes in a private file", () => {
  const { home, store } = setup();
  const first = store.mint();
  for (let n = 0; n < 4; n++) store.mint();
  expect(store.claim(first.id, first.secret)).toBe(false);
  const path = join(home, "pairing-offers.json");
  expect(readFileSync(path, "utf8")).not.toContain(first.secret);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
