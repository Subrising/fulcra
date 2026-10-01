import {
  RadiusScratchInputSchema,
  RadiusScratchPruneInputSchema,
  RadiusScratchOutputSchema,
} from "@getpaseo/protocol/radius-scratch";
import { defineContract } from "./rpc-contract";
import type { RadiusScratchInput, RadiusScratchOutput } from "@getpaseo/protocol/radius-scratch";
/** Original mounted app/physical client lifetime only; no authentication or grant supplied by this prop. */
export interface RadiusScratchOwnerAdapter {
  checkOriginalLifetime(): void;
  simulate(input: RadiusScratchInput, signal: AbortSignal): Promise<RadiusScratchOutput>;
  pruneAndSimulate(
    input: RadiusScratchInput & { confirmDestructive: true },
    signal: AbortSignal,
  ): Promise<RadiusScratchOutput>;
}
export const radiusScratchSimulateRpc = defineContract({
  name: "organization.radius.scratch.simulate",
  input: RadiusScratchInputSchema,
  output: RadiusScratchOutputSchema,
});
export const radiusScratchPruneSimulateRpc = defineContract({
  name: "organization.radius.scratch.prune-simulate",
  input: RadiusScratchPruneInputSchema,
  output: RadiusScratchOutputSchema,
});
