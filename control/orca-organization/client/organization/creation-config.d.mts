import type { PaseoAgentConfig } from "@getpaseo/client";
import type { AgentMode, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
export function intakeProvider(model: string): string;
export function selectIntakeMode(input: {
  modes: AgentMode[];
  configuredMode?: string | null;
  defaultMode?: string | null;
}): string;
export function validateIntakeCreation(input: {
  config: PaseoAgentConfig;
  entries: ProviderSnapshotEntry[];
}): PaseoAgentConfig;
