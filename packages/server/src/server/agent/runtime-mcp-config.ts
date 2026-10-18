import { agentMcpToken } from "./agent-mcp-token.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";

const PASEO_MCP_SERVER_NAME = "paseo";
const PASEO_MCP_PATHNAME = "/mcp/agents";

export function stripInternalPaseoMcpServer<T extends object>(config: T): T {
  if (!("mcpServers" in config)) return config;
  const mcpServers = config.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || !("paseo" in mcpServers)) {
    return config;
  }

  const paseoServer = mcpServers[PASEO_MCP_SERVER_NAME];
  if (!paseoServer || !isInternalPaseoMcpServer(paseoServer)) {
    return config;
  }

  const nextMcpServers = { ...mcpServers };
  delete nextMcpServers[PASEO_MCP_SERVER_NAME];

  const next = { ...config };
  if (Object.keys(nextMcpServers).length > 0) {
    next.mcpServers = nextMcpServers;
  } else {
    delete next.mcpServers;
  }
  return next;
}

export function withRuntimePaseoMcpServer(params: {
  config: AgentSessionConfig;
  agentId: string;
  mcpBaseUrl: string | null;
  /**
   * Capability token authenticating the injected connection to the daemon's
   * Agent MCP endpoint. The daemon password is gated off this route, so without
   * this header the agent's MCP requests are rejected when a password is set.
   */
  mcpAuthToken: string | null;
  /** Host-issued particular-launch witness; confers no ordinary action authority. Never persisted. */
  nativeReportWitness?: string;
}): AgentSessionConfig {
  const storedConfig = stripInternalPaseoMcpServer(params.config);
  if (!params.mcpBaseUrl || storedConfig.mcpServers?.[PASEO_MCP_SERVER_NAME]) {
    return storedConfig;
  }

  return {
    ...storedConfig,
    mcpServers: {
      [PASEO_MCP_SERVER_NAME]: {
        type: "http",
        url: `${params.mcpBaseUrl}?callerAgentId=${params.agentId}`,
        ...(params.mcpAuthToken || params.nativeReportWitness
          ? {
              headers: {
                ...(params.mcpAuthToken
                  ? {
                      Authorization: `Bearer ${agentMcpToken(params.mcpAuthToken, params.agentId)}`,
                    }
                  : {}),
                ...(params.nativeReportWitness
                  ? { "X-Paseo-Report-Origin": params.nativeReportWitness }
                  : {}),
              },
            }
          : {}),
      },
      ...storedConfig.mcpServers,
    },
  };
}

function isInternalPaseoMcpServer(config: unknown): boolean {
  if (
    !config ||
    typeof config !== "object" ||
    !("type" in config) ||
    !("url" in config) ||
    typeof config.url !== "string" ||
    (config.type !== "http" && config.type !== "sse")
  ) {
    return false;
  }

  try {
    return new URL(config.url).pathname === PASEO_MCP_PATHNAME;
  } catch {
    return false;
  }
}

export function matchesPaseoInjectLabels(
  labels: Record<string, string> | undefined,
  required: Record<string, string>,
): boolean {
  return Object.entries(required).every(
    ([key, value]) =>
      labels !== undefined &&
      Object.hasOwn(labels, key) &&
      (labels[key] === value || (key === "fulcra.mcp" && value === "on" && labels[key] === "lead")),
  );
}

export function isPaseoPolicyLabelWrite(
  labels: Record<string, unknown> | undefined,
  required: Record<string, string>,
): boolean {
  return (
    !!labels &&
    (Object.keys(required).some((key) => Object.hasOwn(labels, key)) ||
      Object.hasOwn(labels, "fulcra.mcp.groups") ||
      Object.hasOwn(labels, "fulcra.mcp"))
  );
}

/** Token filter label rules keep the Paseo tool list out of worker sessions. */
export function assertPaseoInjectionLabelWrite(input: {
  labels: Record<string, unknown> | undefined;
  required: Record<string, string>;
  callerAgentId?: string;
  callerLabels?: Record<string, string>;
  agentInput: boolean;
}): void {
  if (!isPaseoPolicyLabelWrite(input.labels, input.required)) return;
  if (!input.callerAgentId && !input.agentInput) return;
  if (
    input.callerAgentId &&
    matchesPaseoInjectLabels(input.callerLabels, input.required) &&
    (Object.keys(input.required).length > 0 ||
      ["on", "lead"].includes(input.callerLabels?.["fulcra.mcp"] ?? ""))
  )
    return;
  throw new Error(
    "MCP token filter labels are reserved. Only the user or a lead with all matching injection labels can change them.",
  );
}
