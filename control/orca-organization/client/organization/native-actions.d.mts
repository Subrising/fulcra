import type { PaseoApi, PaseoAgentConfig } from "@getpaseo/client";
import type {
  Intake,
  WorkspaceUmbrella,
  OrganizationProject,
  OrganizationCommand,
} from "../../shared/workspace-organization";
type RecordEffect = (command: Record<string, unknown>) => Promise<unknown>;
export function createIntakeChat(input: {
  intake: Intake;
  project: OrganizationProject;
  api: PaseoApi;
  config: PaseoAgentConfig;
  deliveryId: string;
  agentId: string;
  taskId?: string | null;
  canReuseContext?: (serverId: string) => boolean;
  record: RecordEffect;
}): Promise<{ serverId: string; agentId: string }>;
export function askIntakePrime(input: {
  intake: Intake;
  workspace: WorkspaceUmbrella;
  api: PaseoApi | (() => PaseoApi);
  available?: boolean;
  binding: {
    sessionId: string | null;
    humanHeld?: boolean | null;
    session?: { mode: string; generation: number } | null;
    dispatch?: { supported: boolean } | null;
  } | null;
  sendOwned?: (input: {
    method: "operator-native-queue";
    input: { sessionId: string; messageId: string; text: string; expectedGeneration: number };
  }) => Promise<{ ok: true; result: unknown } | { ok: false; dispatched: boolean }>;
  requestId: string;
  record: RecordEffect;
}): Promise<string | null>;

export function intakeRoutingPrompt(intake: Intake, workspace: WorkspaceUmbrella): string;
