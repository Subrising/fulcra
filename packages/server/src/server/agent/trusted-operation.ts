import {
  TRUSTED_OPERATION,
  CODEX_TURN_ADMISSION,
  NATIVE_QUEUED_FINAL,
  FINAL_INPUT_CHECK,
} from "./agent-sdk-types.js";
import {
  normalizeTrustedPromptOptions,
  normalizeTrustedPromptInput,
  canonicalJson,
  type NormalizedPromptOptionsV11,
  type TrustedPayloadV11,
  type TrustedCommandNameV11,
  type JsonObject,
} from "@getpaseo/protocol/trusted-input";
import type { AgentPromptInput, AgentRunOptions } from "./agent-sdk-types.js";

const optionSubsets = new WeakMap<TrustedPayloadV11, ReadonlySet<string>>();
export function promptOptionSubset(payload: TrustedPayloadV11): ReadonlySet<string> | undefined {
  return optionSubsets.get(payload);
}
export function promptPayload(
  prompt: AgentPromptInput,
  options?: AgentRunOptions,
  outer: Partial<NormalizedPromptOptionsV11> = {},
): TrustedPayloadV11 {
  for (const symbol of Object.getOwnPropertySymbols(options ?? {}))
    if (
      symbol !== TRUSTED_OPERATION &&
      symbol !== CODEX_TURN_ADMISSION &&
      symbol !== NATIVE_QUEUED_FINAL &&
      symbol !== FINAL_INPUT_CHECK
    )
      throw new TypeError("Unsupported internal run option");
  const normalized: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(options ?? {}))) {
    if (!("value" in descriptor)) throw new TypeError("Run option accessors forbidden");
    // Dismissing question cards grants nothing, so it stays outside the trusted payload.
    if (key === "clearPendingQuestions") {
      if (descriptor.value !== undefined && typeof descriptor.value !== "boolean")
        throw new TypeError("Invalid clearPendingQuestions");
      continue;
    }
    if (
      ![
        "clientMessageId",
        "outputSchema",
        "resumeFrom",
        "maxThinkingTokens",
        "clearPendingPermissions",
        "expectedTurnId",
      ].includes(key)
    )
      throw new TypeError(`Unsupported run option ${key}`);
    if (key !== "clientMessageId" && descriptor.value !== undefined)
      normalized[key] = descriptor.value;
  }
  for (const [key, value] of Object.entries(outer))
    if (value !== undefined) normalized[key] = value;
  const payload: TrustedPayloadV11 = {
    type: "prompt",
    prompt: normalizeTrustedPromptInput(prompt),
    options: normalizeTrustedPromptOptions(normalized),
  };
  optionSubsets.set(
    payload,
    new Set(["outputSchema", "resumeFrom", "maxThinkingTokens", ...Object.keys(normalized)]),
  );
  return payload;
}
export function commandPayload(
  command: TrustedCommandNameV11,
  args: Record<string, unknown> = {},
): TrustedPayloadV11 {
  const values: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(args))) {
    if (!("value" in descriptor)) throw new TypeError("Command accessors forbidden");
    if (descriptor.value !== undefined) values[key] = descriptor.value;
  }
  canonicalJson(values);
  return { type: "command", command, arguments: values as JsonObject };
}

/** Isolate effect-bearing options from caller mutation while queued work awaits. */
export function snapshotRunOptions<T extends AgentRunOptions>(options: T): T {
  const copy = { ...options };
  for (const key of Object.keys(copy) as (keyof T)[]) {
    if (
      copy[key] === null &&
      ["outputSchema", "resumeFrom", "maxThinkingTokens", "expectedTurnId"].includes(String(key))
    )
      delete copy[key];
    else copy[key] = structuredClone(copy[key]);
  }
  return copy;
}

export function deferredPromptPayload(
  ...args: Parameters<typeof promptPayload>
): () => TrustedPayloadV11 {
  return () => promptPayload(...args);
}
export function deferredCommandPayload(
  ...args: Parameters<typeof commandPayload>
): () => TrustedPayloadV11 {
  return () => commandPayload(...args);
}
