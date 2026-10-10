import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { sha256Hex } from "./catalog-hash";

// A digest that behaves like expo-crypto on iOS: it accepts a typed array only.
const nativeLikeDigest = async (_algorithm: unknown, data: Uint8Array<ArrayBuffer>) => {
  if (!ArrayBuffer.isView(data))
    throw new Error("The 3rd argument cannot be cast to type TypedArray");
  const out = createHash("sha256").update(data).digest();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
};

it("hashes catalog bytes with a digest that accepts typed arrays only", async () => {
  const bytes = new TextEncoder().encode("plugin catalog page");
  const expected = createHash("sha256").update(bytes).digest("hex");
  await expect(sha256Hex(bytes, nativeLikeDigest as never, "SHA-256")).resolves.toBe(expected);
});

it("hashes a view into a larger buffer without its neighbours", async () => {
  const big = new Uint8Array([9, 9, 1, 2, 3, 9]);
  const view = big.subarray(2, 5);
  const expected = createHash("sha256")
    .update(new Uint8Array([1, 2, 3]))
    .digest("hex");
  await expect(sha256Hex(view, nativeLikeDigest as never, "SHA-256")).resolves.toBe(expected);
});
