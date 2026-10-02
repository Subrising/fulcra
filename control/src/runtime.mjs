import { fileURLToPath } from "node:url";
import { portable } from "./portable-config.mjs";
import { requiredSetting } from "./config.mjs";
export const runtime = portable;
export const root = fileURLToPath(new URL("../", import.meta.url));
export function verifyPins() {
  throw Error("TODO(V3): trusted host registration verification required");
}
export function password() {
  throw Error("TODO(V3): controller authentication must be supplied by the trusted plugin ctx");
}
export async function connect() {
  requiredSetting(portable.url, "daemon.url");
  password();
}
export function memoryConfig() {
  throw Error("Use canonicalMemoryConfig for the portable memory service");
}
