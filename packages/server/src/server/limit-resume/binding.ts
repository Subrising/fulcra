import { createHash } from "node:crypto";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";

/** A fingerprint is a comparison value, never input authorization; plaintext prompts/credentials are not queued. */
export function fingerprintLimitResumeBinding(
  config: AgentSessionConfig,
  observed: {
    provider: string;
    cwd: string;
    sessionId: string | null;
    account: string;
    appendSystemPrompt: string;
    lastUserMessageAt: string | null;
  },
): string | null {
  // These servers can carry credentials in env/headers/args. Do not inspect them to make a binding.
  if (Object.keys(config.mcpServers ?? {}).length > 0) return null;
  const options = config.providerOptions ?? {};
  const safeOptionNames = new Set([
    "approval_policy",
    "sandbox_mode",
    "reasoning_effort",
    "service_tier",
    "model_provider",
    "network_access",
  ]);
  if (Object.keys(options).some((key) => !safeOptionNames.has(key))) return null;
  const orderedOptions = Object.keys(options)
    .sort()
    .map((key) => [key, options[key]]);
  const features = Object.keys(config.featureValues ?? {})
    .sort()
    .map((key) => [key, config.featureValues![key]]);
  const intent = createHash("sha256")
    .update(
      JSON.stringify([
        config.systemPrompt ?? "",
        observed.appendSystemPrompt,
        config.toolPolicy ?? null,
      ]),
    )
    .digest("hex");
  const descriptor = [
    observed.provider,
    observed.cwd,
    observed.sessionId,
    config.model,
    config.modeId,
    config.thinkingOptionId ?? null,
    features,
    orderedOptions,
    observed.account,
    intent,
    observed.lastUserMessageAt,
  ];
  return `v1:${createHash("sha256").update(JSON.stringify(descriptor)).digest("hex")}`;
}
