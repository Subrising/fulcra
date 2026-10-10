import fs from "node:fs";
import { privateOwned } from "../../orca-organization/server/owned.mjs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export const canonical = (x) =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
export const digest = (x) => createHash("sha256").update(canonical(x)).digest("hex");
export const exact = (x, keys) => x && !Array.isArray(x) && Object.keys(x).sort().join() === keys;
// Only absent provider is the legacy Codex creation format. Invalid explicit values refuse.
export function bookProvider(creation) {
  if (!creation || typeof creation !== "object" || Array.isArray(creation))
    throw Error("Invalid Book creation identity");
  const provider = Object.hasOwn(creation, "provider") ? creation.provider : "codex";
  if (!["codex", "claude"].includes(provider)) throw Error("Unknown Book creation provider");
  return provider;
}
export function secret(file) {
  if (fs.realpathSync(file) !== file) throw Error("Receiver secret path changed");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const s = fs.fstatSync(fd),
      value = fs.readFileSync(fd, "utf8");
    if (!s.isFile() || !privateOwned(s, file) || !/^[A-Za-z0-9_-]{43}$/.test(value))
      throw Error("Private receiver secret required");
    return value;
  } finally {
    fs.closeSync(fd);
  }
}
export function sign(body, key) {
  return { body, mac: createHmac("sha256", key).update(canonical(body)).digest("hex") };
}
export function verify(wire, key) {
  if (
    !exact(wire, "body,mac") ||
    !/^[a-f0-9]{64}$/.test(wire.mac) ||
    !timingSafeEqual(Buffer.from(wire.mac), Buffer.from(sign(wire.body, key).mac))
  )
    throw Error("Receiver authentication failed");
  return wire.body;
}
