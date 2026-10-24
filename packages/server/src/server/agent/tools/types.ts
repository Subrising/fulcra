import type { NativeArtifactInvocation } from "../../native-artifact-origin.js";
import type { NativeReportOrigin } from "../../report-origin.js";
import type { z } from "zod";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

export class PaseoToolInputError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly issues?: z.ZodError["issues"],
  ) {
    super(message);
    this.name = "PaseoToolInputError";
  }
}

export interface PaseoToolExecutionContext {
  signal?: AbortSignal;
  /** Host-captured before input parsing awaits; caller-supplied matching objects refuse. */
  nativeArtifactInvocation?: NativeArtifactInvocation;
  sendUpdate?: (update: PaseoToolResult) => void;
}

export interface PaseoToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface PaseoToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape | z.ZodType;
  outputSchema?: z.ZodRawShape;
}

export interface PaseoToolDefinition extends PaseoToolConfig {
  name: string;
  description: string;
  handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;
}

export interface PaseoToolCatalog {
  tools: ReadonlyMap<string, PaseoToolDefinition>;
  getTool(name: string): PaseoToolDefinition | undefined;
  executeTool(
    name: string,
    input: unknown,
    context?: PaseoToolExecutionContext,
  ): Promise<PaseoToolResult>;
}

export interface PaseoToolRuntimeContext {
  nativeReportOrigin?: NativeReportOrigin;
  callerAgentId?: string;
  /** True when the caller id was proven by the agent's own token. Unset means trusted host code. */
  callerVerified?: boolean;
  paseoToolPolicy?: ProviderPaseoToolsPolicy;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
}

export type PaseoToolCatalogFactory = (
  context: PaseoToolRuntimeContext,
) => PaseoToolCatalog | Promise<PaseoToolCatalog>;
