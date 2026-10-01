import { checkReportPublication } from "./report-publication.js";
import { NativeReportIdentitySchema } from "@getpaseo/protocol/native-intercom";
import type { NativeReportIdentity } from "@getpaseo/protocol/native-intercom";

/** In-process launch witness. This is neither an action grant nor a wire credential. */
export interface NativeReportOrigin {
  readonly nativeReportOrigin: true;
}
const origins = new WeakMap<NativeReportOrigin, () => NativeReportIdentity>();

export function createNativeReportOrigin(check: () => NativeReportIdentity): NativeReportOrigin {
  const origin: NativeReportOrigin = Object.freeze({ nativeReportOrigin: true });
  origins.set(origin, check);
  return origin;
}

export function requireNativeReportOrigin(origin: NativeReportOrigin): NativeReportIdentity {
  const check = origins.get(origin);
  if (!check) throw new Error("Host-issued native report origin required");
  return Object.freeze(NativeReportIdentitySchema.parse(check()));
}

export interface NativeReportCreation {
  readonly nativeReportCreation: true;
}
const creations = new WeakMap<
  NativeReportCreation,
  (child: NativeReportIdentity) => Promise<void>
>();
export function createNativeReportCreation(
  enroll: (child: NativeReportIdentity) => Promise<void>,
): NativeReportCreation {
  const creation: NativeReportCreation = Object.freeze({ nativeReportCreation: true });
  creations.set(creation, enroll);
  return creation;
}
export async function enrollNativeReportCreation(
  creation: NativeReportCreation,
  child: NativeReportIdentity,
): Promise<void> {
  const enroll = creations.get(creation);
  if (!enroll) throw new Error("Host-issued native report creation required");
  // One effect attempt, including failed durability. Never retarget an old creation handle.
  creations.delete(creation);
  await enroll(Object.freeze({ ...child }));
}

const originPublications = new WeakMap<NativeReportOrigin, unknown>();
/** One stateless HTTP request owns its publication fence; concurrent reads cannot replace each other's checks. */
export function forkNativeReportOrigin(origin: NativeReportOrigin): NativeReportOrigin {
  requireNativeReportOrigin(origin);
  return createNativeReportOrigin(() => requireNativeReportOrigin(origin));
}
export function rememberNativeReportPublication(origin: NativeReportOrigin, result: unknown): void {
  requireNativeReportOrigin(origin);
  checkReportPublication(result);
  originPublications.set(origin, result);
}
export function checkNativeReportOriginPublication(origin: NativeReportOrigin): void {
  requireNativeReportOrigin(origin);
  checkReportPublication(originPublications.get(origin));
}
