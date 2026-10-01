import {
  RadiusScratchInputSchema,
  RadiusScratchPruneInputSchema,
  RadiusScratchOutputSchema,
} from "@getpaseo/protocol/radius-scratch";
import type { ManagementAuthority } from "./management.js";
import type { ControllerDistribution } from "./controller-distribution.js";

/** Private host bootstrap only. Neither request fields nor the helper factory supply authority. */
export function registerNativeRadiusScratch(
  management: ManagementAuthority,
  distribution: ControllerDistribution | undefined,
): void {
  if (!distribution?.simulateRadiusScratch) return;
  const simulate = distribution.simulateRadiusScratch.bind(distribution);
  for (const method of ["radius-scratch-simulate", "radius-scratch-prune-and-simulate"]) {
    management.registerOwnerHandler(method, async (command, owner) => {
      owner.requireOwner();
      const destructive = method === "radius-scratch-prune-and-simulate";
      const parsed = (
        destructive ? RadiusScratchPruneInputSchema : RadiusScratchInputSchema
      ).safeParse(command.input);
      if (!parsed.success) throw new Error("Invalid bounded Radius scratch input");
      const input = RadiusScratchInputSchema.parse({
        attemptId: parsed.data.attemptId,
        plan: parsed.data.plan,
        expectedRevision: parsed.data.expectedRevision,
      });
      owner.requireOwner();
      let result: unknown;
      try {
        // The destructive closure exists ONLY for this original, explicitly selected owner purpose.
        result = simulate(input, owner.requireOwner, destructive ? owner.requireOwner : undefined);
      } catch {
        owner.requireOwner(); // Preserve actual owner/source refusal instead of converting it to a data error.
        throw new Error("Radius scratch simulation is unavailable or refused.");
      }
      owner.requireOwner();
      const output = RadiusScratchOutputSchema.safeParse(result);
      if (!output.success || output.data.attemptId !== input.attemptId)
        throw new Error("Radius scratch outcome is unconfirmed.");
      owner.requireOwner();
      return output.data;
    });
  }
}
