import {
  NativeArtifactContentSelectionSchema,
  type NativeArtifactContentGrant,
} from "@getpaseo/protocol/native-artifact-content";
import type { z } from "zod";
import type { PluginSurfaceRuntime } from "@/plugins/surface-runtime";
import { artifactContentGrantListRpc } from "../../../../control/orca-organization/shared/intercom";

type Selection = z.infer<typeof NativeArtifactContentSelectionSchema>;
/** Current protected owner-list descriptors only; these functions neither issue nor brand authority. */
export async function listManagedArtifactContentGrants(
  runtime: Pick<PluginSurfaceRuntime, "invoke">,
  input: Selection,
  checkOriginalLifetime: () => void,
): Promise<NativeArtifactContentGrant[]> {
  const selection = NativeArtifactContentSelectionSchema.parse(input);
  checkOriginalLifetime();
  const output = artifactContentGrantListRpc.output.parse(
    await runtime.invoke(artifactContentGrantListRpc.name, selection),
  );
  checkOriginalLifetime();
  const seen = new Set<string>();
  for (const grant of output.grants) {
    if (seen.has(grant.grantId) || new Set(grant.artifactIds).size !== grant.artifactIds.length)
      throw new Error("Content grant selection unavailable");
    seen.add(grant.grantId);
    if (
      JSON.stringify(grant.identity) !== JSON.stringify(selection.identity) ||
      grant.expectedEpoch !== selection.expectedEpoch ||
      grant.scope.projectId !== selection.scope.projectId ||
      grant.scope.taskId !== selection.scope.taskId
    )
      throw new Error("Content grant selection unavailable");
  }
  const now = Date.now();
  const current = output.grants.filter(
    (grant) => grant.expiresAt > now && grant.expiresAt - now <= 6 * 60 * 60 * 1000,
  );
  checkOriginalLifetime();
  return current;
}
/** Re-read the actual owner list immediately for the user's exact enumerated grant/artifact choice. */
export async function selectManagedArtifactContentGrant(
  runtime: Pick<PluginSurfaceRuntime, "invoke">,
  input: Selection,
  selected: { grantId: string; artifactId: string },
  checkOriginalLifetime: () => void,
): Promise<NativeArtifactContentGrant> {
  const selection = NativeArtifactContentSelectionSchema.parse(input);
  const choice = Object.freeze({ ...selected });
  const rows = await listManagedArtifactContentGrants(runtime, selection, checkOriginalLifetime);
  checkOriginalLifetime();
  const grant = rows.find((candidate) => candidate.grantId === choice.grantId);
  if (!grant || !grant.artifactIds.includes(choice.artifactId) || grant.expiresAt <= Date.now())
    throw new Error("Content grant selection unavailable");
  checkOriginalLifetime();
  return grant;
}
