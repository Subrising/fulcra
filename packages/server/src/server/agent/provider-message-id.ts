import { createHash } from "node:crypto";

/** Claude requires a UUID. Keep queue batch IDs stable across native history reloads. */
export function providerMessageId(
  messageId: string,
): `${string}-${string}-${string}-${string}-${string}` {
  const hash = createHash("sha256").update(`fulcra-input:${messageId}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
