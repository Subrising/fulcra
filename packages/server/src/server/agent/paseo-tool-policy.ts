import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

import { LEAD_PASEO_TOOLS, PASEO_TOOL_GROUPS } from "@getpaseo/protocol/paseo-tool-names";

export function sessionPaseoToolPolicy(
  policy: ProviderPaseoToolsPolicy | undefined,
  labels: Record<string, string> | undefined,
): ProviderPaseoToolsPolicy | undefined {
  const groups = labels?.["fulcra.mcp.groups"];
  const selected = groups ? groups.split(",").map((name) => name.trim()) : [];
  for (const group of selected) {
    if (!Object.hasOwn(PASEO_TOOL_GROUPS, group))
      throw new Error(`Unknown Fulcra MCP tool group: ${group}`);
  }
  if (labels?.["fulcra.mcp"] !== "lead") {
    if (selected.length) throw new Error("Fulcra MCP groups require the lead preset");
    return policy;
  }
  const allowed = new Set<NonNullable<ProviderPaseoToolsPolicy["allowedTools"]>[number]>(
    LEAD_PASEO_TOOLS,
  );
  for (const group of selected)
    for (const name of PASEO_TOOL_GROUPS[group as keyof typeof PASEO_TOOL_GROUPS])
      allowed.add(name);
  return {
    ...policy,
    allowedTools: [...allowed].filter(
      (name) => !policy?.allowedTools || policy.allowedTools.includes(name),
    ),
  };
}

interface ProviderPaseoToolSettings {
  paseoTools?: ProviderPaseoToolsPolicy;
}

export function resolvePaseoToolPolicy(
  providerId: string,
  providerSettings: Readonly<Record<string, ProviderPaseoToolSettings>> | undefined,
): ProviderPaseoToolsPolicy | undefined {
  return providerSettings?.[providerId]?.paseoTools;
}

export function isPaseoToolEnabled(
  policy: ProviderPaseoToolsPolicy | undefined,
  toolName: string,
): boolean {
  if (toolName === "speak") {
    return true;
  }
  if (!isPaseoToolPolicyEnabled(policy)) {
    return false;
  }
  return (
    (!policy?.allowedTools || (policy.allowedTools as readonly string[]).includes(toolName)) &&
    !policy?.disabledTools?.includes(toolName)
  );
}

export function isPaseoToolPolicyEnabled(policy: ProviderPaseoToolsPolicy | undefined): boolean {
  return policy?.enabled !== false;
}
