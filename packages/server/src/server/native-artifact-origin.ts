import {
  NativeArtifactProduceInputSchema,
  type ManagedArtifactClaim,
} from "@getpaseo/protocol/native-evidence";
import type { NativeReportOrigin } from "./report-origin.js";
import type { NativeReportIdentity } from "@getpaseo/protocol/native-intercom";

export interface NativeArtifactInvocation {
  readonly nativeArtifactInvocation: true;
}
interface CapturedInvocation {
  input: ReturnType<typeof NativeArtifactProduceInputSchema.parse>;
  claim: ManagedArtifactClaim;
  requireCurrent: () => void;
  origin: NativeReportOrigin;
  identity: NativeReportIdentity;
  used: boolean;
}
const invocations = new WeakMap<NativeArtifactInvocation, CapturedInvocation>();
/** Host-only capture before parsing awaits. Wire fields never carry this brand. */
export function createNativeArtifactInvocation(
  input: Omit<CapturedInvocation, "used">,
): NativeArtifactInvocation {
  input.requireCurrent();
  const handle = Object.freeze({ nativeArtifactInvocation: true as const });
  invocations.set(handle, {
    ...input,
    input: structuredClone(input.input),
    claim: structuredClone(input.claim),
    identity: structuredClone(input.identity),
    used: false,
  });
  return handle;
}
export function consumeNativeArtifactInvocation(handle: NativeArtifactInvocation) {
  const captured = invocations.get(handle);
  if (!captured || captured.used) throw new Error("Private unused artifact invocation required");
  captured.requireCurrent();
  captured.used = true;
  return captured;
}
