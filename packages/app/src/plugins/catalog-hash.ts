type Digest = (algorithm: never, data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;

/**
 * SHA-256 of the catalog bytes, as hex. expo-crypto's digest takes a typed array. On iOS an ArrayBuffer is refused
 * ("The 3rd argument cannot be cast to type TypedArray"), so every paged catalog read failed there (10 Oct).
 */
export async function sha256Hex(
  bytes: Uint8Array,
  digest: Digest,
  algorithm: unknown,
): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = new Uint8Array(await digest(algorithm as never, copy));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
