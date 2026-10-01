import {
  AgentAttachmentSchema,
  AgentPermissionResponseSchema,
  PluginCatalogGetResponseSchema,
} from "./messages.js";
import type {
  AgentPromptInput,
  AgentPermissionResponse,
  AgentPersistenceHandle,
} from "./agent-types.js";
import type { ActiveTurnBehavior } from "./messages.js";
// Move these existing primitives into protocol/trusted-input; plugin/server re-exports.
export type TrustedInputKind =
  | "prompt"
  | "steer"
  | "replace"
  | "cancel"
  | "interrupt"
  | "archive"
  | "close"
  | "rewind"
  | "configure"
  | "unarchive"
  | "permission";
export interface InputSequence {
  readonly boot: string;
  readonly humanAt: number;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type Sha256 = string & { readonly __sha256: unique symbol }; // /^[a-f0-9]{64}$/
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export interface NormalizedPromptOptionsV11 {
  readonly sessionMode: string | null;
  readonly unarchive: boolean | null;
  readonly activeTurnBehavior: ActiveTurnBehavior | null;
  readonly replaceRunning: boolean | null;
  readonly clearPendingPermissions: boolean;
  readonly expectedTurnId: string | null;
  readonly outputSchema: JsonValue | null;
  readonly resumeFrom: DeepReadonly<AgentPersistenceHandle> | null;
  readonly maxThinkingTokens: number | null;
}
export type TrustedCommandNameV11 =
  | "cancel"
  | "interrupt"
  | "archive"
  | "close"
  | "rewind"
  | "unarchive"
  | "set-mode"
  | "set-model"
  | "set-thinking"
  | "set-feature"
  | "set-metadata"
  | "set-labels"
  | "detach"
  | "adopt-parent"
  | "reload";
export type TrustedPayloadV11 =
  | {
      readonly type: "prompt";
      readonly prompt: AgentPromptInput;
      readonly options: NormalizedPromptOptionsV11;
    }
  | {
      readonly type: "permission";
      readonly requestId: string;
      readonly response: AgentPermissionResponse;
    }
  | {
      readonly type: "command";
      readonly command: TrustedCommandNameV11;
      readonly arguments: JsonObject;
    };

export interface ProvenanceBindingV11 {
  readonly agentId: string; // validated full UUID
  readonly kind: TrustedInputKind; // PRIMARY operation, not a nested cancellation
  readonly messageId: string | null;
  readonly payloadDigest: Sha256;
  readonly attemptId: string; // controller's journal attempt UUID
}
export interface TrustedOperationV11 {
  readonly operationId: string; // host-generated UUID, never accepted from wire
  readonly agentId: string;
  readonly kind: TrustedInputKind;
  readonly messageId: string | null;
  readonly payloadDigest: Sha256;
  readonly attemptId: string | null; // null for unattributed input
  readonly pluginId: string | null; // host-verified owner of the capability
}
export interface TrustedInputV11 {
  /** Host-owned queue admission; absence is the ordinary effect fence. */
  readonly admissionPhase?: "enqueue";
  readonly kind: TrustedInputKind; // boundary currently being checked
  readonly messageId?: string;
  readonly source: "human" | "agent" | "daemon" | "plugin";
  readonly provenance: { readonly pluginId: string } | null;
  /** Host-only purpose; wire callers cannot supply it. */
  readonly cause?: "shutdown" | "parent-adoption";
  readonly operation: TrustedOperationV11;
}
// Replaces the trusted-only V1 issuance signature:
export type IssueProvenanceV11 = (binding: ProvenanceBindingV11) => string;

function canonicalDescriptors(value: object): Record<string, PropertyDescriptor> {
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new TypeError("Non-plain canonical object");
  if (Object.getOwnPropertySymbols(value).length)
    throw new TypeError("Canonical symbols forbidden");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === "length") continue;
    if (!("value" in descriptor) || !descriptor.enumerable)
      throw new TypeError("Canonical accessor or hidden field");
  }
  return descriptors;
}

/** Strict JSON bytes. Inspect descriptors before reading so accessors never execute. */
export function canonicalJson(root: unknown): string {
  const active = new Set<object>();
  function visit(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== "object" || !value) throw new TypeError("Unsupported canonical value");
    if (active.has(value)) throw new TypeError("Cyclic canonical value");
    const descriptors = canonicalDescriptors(value);
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(descriptors).length !== value.length + 1)
          throw new TypeError("Sparse or extended array");
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!descriptors[i]) throw new TypeError("Sparse array");
          items.push(visit(descriptors[i].value));
        }
        return "[" + items.join(",") + "]";
      }
      return (
        "{" +
        Object.keys(descriptors)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + visit(descriptors[key].value))
          .join(",") +
        "}"
      );
    } finally {
      active.delete(value);
    }
  }
  return visit(root);
}

export const trustedInputKinds = [
  "prompt",
  "steer",
  "replace",
  "cancel",
  "interrupt",
  "archive",
  "close",
  "rewind",
  "configure",
  "unarchive",
  "permission",
] as const;
const optionDefaults: NormalizedPromptOptionsV11 = {
  sessionMode: null,
  unarchive: null,
  activeTurnBehavior: null,
  replaceRunning: null,
  clearPendingPermissions: false,
  expectedTurnId: null,
  outputSchema: null,
  resumeFrom: null,
  maxThinkingTokens: null,
};

function exactKeys(value: object, keys: readonly string[]): void {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new TypeError(`Unsupported field: ${key}`);
}

export function normalizeTrustedPromptOptions(
  options: Partial<NormalizedPromptOptionsV11> = {},
): NormalizedPromptOptionsV11 {
  canonicalJson(options);
  exactKeys(options, Object.keys(optionDefaults));
  const result = { ...optionDefaults, ...options };
  for (const key of ["sessionMode", "expectedTurnId"] as const)
    if (result[key] !== null && typeof result[key] !== "string")
      throw new TypeError(`Invalid ${key}`);
  for (const key of ["unarchive", "replaceRunning"] as const)
    if (result[key] !== null && typeof result[key] !== "boolean")
      throw new TypeError(`Invalid ${key}`);
  if (typeof result.clearPendingPermissions !== "boolean")
    throw new TypeError("Invalid clearPendingPermissions");
  if (
    result.activeTurnBehavior !== null &&
    !["steer", "interrupt"].includes(result.activeTurnBehavior)
  )
    throw new TypeError("Invalid activeTurnBehavior");
  if (
    result.maxThinkingTokens !== null &&
    (!Number.isSafeInteger(result.maxThinkingTokens) || result.maxThinkingTokens < 0)
  )
    throw new TypeError("Invalid maxThinkingTokens");
  if (result.resumeFrom !== null) {
    exactKeys(result.resumeFrom, ["provider", "sessionId", "nativeHandle", "metadata"]);
    if (
      typeof result.resumeFrom.provider !== "string" ||
      typeof result.resumeFrom.sessionId !== "string"
    )
      throw new TypeError("Invalid persistence");
  }
  return result;
}

function validatePromptBlock(block: import("./agent-types.js").AgentPromptContentBlock): void {
  if (block.type === "text" && !("mimeType" in block)) {
    exactKeys(block, ["type", "text"]);
    if (typeof block.text !== "string") throw new TypeError("Invalid text block");
  } else if (block.type === "image") {
    exactKeys(block, ["type", "data", "mimeType"]);
    if (typeof block.data !== "string" || typeof block.mimeType !== "string")
      throw new TypeError("Invalid image block");
  } else {
    const parsed = AgentAttachmentSchema.safeParse(block);
    if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(block))
      throw new TypeError("Unsupported attachment");
  }
}

function validatePromptPayload(
  payload: Extract<TrustedPayloadV11, { type: "prompt" }>,
  kind: TrustedInputKind,
): void {
  exactKeys(payload, ["type", "prompt", "options"]);
  if (!["prompt", "steer", "replace"].includes(kind)) throw new TypeError("Invalid prompt kind");
  if (typeof payload.prompt !== "string" && !Array.isArray(payload.prompt))
    throw new TypeError("Invalid prompt");
  if (Array.isArray(payload.prompt)) payload.prompt.forEach(validatePromptBlock);
  if (Object.keys(payload.options).length !== Object.keys(optionDefaults).length)
    throw new TypeError("Incomplete prompt options");
  normalizeTrustedPromptOptions(payload.options);
}

function validatePermissionPayload(
  payload: Extract<TrustedPayloadV11, { type: "permission" }>,
  kind: TrustedInputKind,
): void {
  exactKeys(payload, ["type", "requestId", "response"]);
  if (kind !== "permission" || typeof payload.requestId !== "string")
    throw new TypeError("Invalid permission payload");
  const response = payload.response;
  if (!AgentPermissionResponseSchema.safeParse(response).success)
    throw new TypeError("Invalid permission response");
  exactKeys(
    response,
    response.behavior === "allow"
      ? ["behavior", "selectedActionId", "updatedInput", "updatedPermissions"]
      : ["behavior", "selectedActionId", "message", "interrupt"],
  );
}

function stringArgument(args: JsonObject, key: string, nullable = false): void {
  if (!Object.hasOwn(args, key)) throw new TypeError(`Missing command argument ${key}`);
  if (nullable && args[key] === null) return;
  if (typeof args[key] !== "string") throw new TypeError(`Invalid command argument ${key}`);
}
function labelsArgument(labels: JsonValue, nullable = false): void {
  if (!labels || typeof labels !== "object" || Array.isArray(labels))
    throw new TypeError("Invalid labels");
  if (
    Object.values(labels).some(
      (value) => typeof value !== "string" && !(nullable && value === null),
    )
  )
    throw new TypeError("Invalid label value");
}
function metadataArgument(metadata: JsonValue): void {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new TypeError("Invalid metadata");
  exactKeys(metadata, ["title", "labels"]);
  if (Object.hasOwn(metadata, "title")) stringArgument(metadata as JsonObject, "title");
  if (Object.hasOwn(metadata, "labels")) labelsArgument((metadata as JsonObject).labels);
}
function reloadArguments(args: JsonObject): void {
  if (args.options !== undefined) {
    if (!args.options || typeof args.options !== "object" || Array.isArray(args.options))
      throw new TypeError("Invalid reload options");
    exactKeys(args.options, ["rehydrateFromDisk"]);
    const value = (args.options as JsonObject).rehydrateFromDisk;
    if (value !== undefined && typeof value !== "boolean")
      throw new TypeError("Invalid rehydrate option");
  }
  if (args.overrides !== undefined) {
    if (!args.overrides || typeof args.overrides !== "object" || Array.isArray(args.overrides))
      throw new TypeError("Invalid reload overrides");
    exactKeys(args.overrides, [
      "provider",
      "cwd",
      "systemPrompt",
      "modeId",
      "model",
      "thinkingOptionId",
      "featureValues",
      "title",
      "providerOptions",
      "toolPolicy",
      "mcpServers",
      "internal",
    ]);
  }
}

interface CommandSchema {
  readonly kind: TrustedInputKind;
  readonly keys: readonly string[];
  validate?(args: JsonObject): void;
}
const commandSchemas: Record<TrustedCommandNameV11, CommandSchema> = {
  cancel: { kind: "cancel", keys: [] },
  interrupt: { kind: "interrupt", keys: [] },
  close: {
    kind: "close",
    keys: ["purgeHistory"],
    validate: (args) => {
      if (Object.hasOwn(args, "purgeHistory") && typeof args.purgeHistory !== "boolean")
        throw new TypeError("Invalid history purge choice");
    },
  },
  archive: {
    kind: "archive",
    keys: ["archivedAt"],
    validate: (args) => {
      if (Object.hasOwn(args, "archivedAt")) stringArgument(args, "archivedAt");
    },
  },
  rewind: {
    kind: "rewind",
    keys: ["messageId", "mode"],
    validate: (args) => {
      stringArgument(args, "messageId");
      if (!["conversation", "files", "both"].includes(String(args.mode)))
        throw new TypeError("Invalid rewind mode");
    },
  },
  unarchive: {
    kind: "unarchive",
    keys: ["workspaceId", "labels"],
    validate: (args) => {
      if (Object.hasOwn(args, "workspaceId")) stringArgument(args, "workspaceId");
      if (Object.hasOwn(args, "labels")) labelsArgument(args.labels, true);
    },
  },
  "set-mode": {
    kind: "configure",
    keys: ["modeId"],
    validate: (args) => stringArgument(args, "modeId"),
  },
  "set-model": {
    kind: "configure",
    keys: ["modelId"],
    validate: (args) => stringArgument(args, "modelId", true),
  },
  "set-thinking": {
    kind: "configure",
    keys: ["thinkingOptionId"],
    validate: (args) => stringArgument(args, "thinkingOptionId", true),
  },
  "set-feature": {
    kind: "configure",
    keys: ["featureId", "value"],
    validate: (args) => {
      stringArgument(args, "featureId");
      if (!Object.hasOwn(args, "value")) throw new TypeError("Missing feature value");
    },
  },
  "set-metadata": {
    kind: "configure",
    keys: ["metadata"],
    validate: (args) => metadataArgument(args.metadata),
  },
  "set-labels": {
    kind: "configure",
    keys: ["labels"],
    validate: (args) => labelsArgument(args.labels),
  },
  "adopt-parent": {
    kind: "configure",
    keys: [
      "parentAgentId",
      "expectedParentAgentId",
      "childNativeSessionId",
      "parentNativeSessionId",
    ],
    validate: (args) => {
      for (const key of ["parentAgentId", "childNativeSessionId", "parentNativeSessionId"])
        stringArgument(args, key);
      if (args.expectedParentAgentId !== null) stringArgument(args, "expectedParentAgentId");
    },
  },
  detach: { kind: "configure", keys: [] },
  reload: { kind: "configure", keys: ["overrides", "options"], validate: reloadArguments },
};
function validateCommandPayload(
  payload: Extract<TrustedPayloadV11, { type: "command" }>,
  kind: TrustedInputKind,
): void {
  exactKeys(payload, ["type", "command", "arguments"]);
  if (!Object.hasOwn(commandSchemas, payload.command)) throw new TypeError("Invalid command");
  const schema = commandSchemas[payload.command];
  if (schema.kind !== kind) throw new TypeError("Invalid command kind");
  exactKeys(payload.arguments, schema.keys);
  schema.validate?.(payload.arguments);
}

export function canonicalTrustedPayload(input: {
  agentId: string;
  kind: TrustedInputKind;
  messageId: string | null;
  payload: TrustedPayloadV11;
}): string {
  canonicalJson(input);
  exactKeys(input, ["agentId", "kind", "messageId", "payload"]);
  if (
    typeof input.agentId !== "string" ||
    !trustedInputKinds.includes(input.kind) ||
    (input.messageId !== null && typeof input.messageId !== "string")
  )
    throw new TypeError("Invalid trusted envelope");
  switch (input.payload.type) {
    case "prompt":
      validatePromptPayload(input.payload, input.kind);
      break;
    case "permission":
      validatePermissionPayload(input.payload, input.kind);
      break;
    case "command":
      validateCommandPayload(input.payload, input.kind);
      break;
    default:
      throw new TypeError("Invalid trusted payload");
  }
  return canonicalJson({ v: 1, ...input });
}

export type TrustedHookNameV11 = "input" | "permission" | "deny" | "mcp" | "codex";
export interface TrustedPluginReportV11 {
  readonly id: string;
  readonly contract: "1.1";
  readonly hooks: readonly TrustedHookNameV11[];
}
export interface PluginCatalogV11 {
  readonly plugins: readonly {
    readonly id: string;
    readonly clientBundle: string;
    readonly requirements?: import("./messages.js").PluginRequirements;
  }[];
  readonly trustedHost?: { readonly contract: "1.1"; readonly boot: string };
  readonly trustedPlugins?: readonly TrustedPluginReportV11[];
}

function omitOptionalProperties(
  value: object,
  allowed: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new TypeError("Non-plain protocol value");
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError("Protocol symbol forbidden");
  const copy: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!allowed.includes(key) || !("value" in descriptor) || !descriptor.enumerable)
      throw new TypeError(`Unsupported protocol property ${key}`);
    if (descriptor.value === undefined && optional.includes(key)) continue;
    copy[key] = descriptor.value;
  }
  return copy;
}

export function normalizeTrustedPermissionResponse(
  response: AgentPermissionResponse,
): AgentPermissionResponse {
  const behavior = Object.getOwnPropertyDescriptor(response, "behavior")?.value;
  const optional =
    behavior === "allow"
      ? ["selectedActionId", "updatedInput", "updatedPermissions"]
      : ["selectedActionId", "message", "interrupt"];
  const copy = omitOptionalProperties(response, ["behavior", ...optional], optional);
  canonicalJson(copy);
  return AgentPermissionResponseSchema.parse(copy);
}

export function normalizeTrustedPromptInput(prompt: AgentPromptInput): AgentPromptInput {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt) || Object.getPrototypeOf(prompt) !== Array.prototype)
    throw new TypeError("Invalid prompt input");
  const descriptors = Object.getOwnPropertyDescriptors(prompt);
  if (
    Object.getOwnPropertySymbols(prompt).length ||
    Object.keys(descriptors).length !== prompt.length + 1
  )
    throw new TypeError("Sparse or extended prompt array");
  for (let i = 0; i < prompt.length; i++)
    if (!descriptors[i] || !("value" in descriptors[i]))
      throw new TypeError("Prompt accessor or sparse array");
  return prompt.map((block) => {
    const type = Object.getOwnPropertyDescriptor(block, "type")?.value;
    if ((type === "text" && !Object.hasOwn(block, "mimeType")) || type === "image") {
      canonicalJson(block);
      return block;
    }
    const schema = AgentAttachmentSchema.options
      .map((candidate) => ("in" in candidate ? candidate.in : candidate))
      .find((candidate) => candidate.shape.type.value === type);
    if (!schema) throw new TypeError("Unsupported attachment type");
    const keys = Object.keys(schema.shape);
    const optional = Object.entries(schema.shape)
      .filter(([, field]) => field.isOptional())
      .map(([key]) => key);
    const copy = omitOptionalProperties(block, keys, optional);
    canonicalJson(copy);
    const parsed = AgentAttachmentSchema.parse(copy);
    // Defaults are part of the validated public normalisation, shared by issuer and host.
    return parsed;
  });
}

/** A validated wire catalog with a complete own V1.1 report; other reports may be legacy. */
export type VerifiedTrustedCatalogV11 = Omit<
  import("zod").infer<typeof PluginCatalogGetResponseSchema>["payload"],
  "requestId" | "trustedHost" | "trustedPlugins"
> & {
  readonly trustedHost: { readonly contract: "1.1"; readonly boot: string };
  readonly trustedPlugins: readonly {
    readonly id: string;
    readonly contract?: "1.1";
    readonly hooks: readonly string[];
  }[];
};
export function isTrustedCatalogV11(
  catalog: unknown,
  ownId: string,
  boot: string,
): catalog is VerifiedTrustedCatalogV11 {
  const parsed = PluginCatalogGetResponseSchema.shape.payload
    .omit({ requestId: true })
    .safeParse(catalog);
  if (!parsed.success || !ownId || !boot) return false;
  const { trustedHost, trustedPlugins } = parsed.data;
  if (trustedHost?.contract !== "1.1" || trustedHost.boot !== boot || !trustedPlugins) return false;
  if (new Set(trustedPlugins.map((report) => report.id)).size !== trustedPlugins.length)
    return false;
  const own = trustedPlugins.find((report) => report.id === ownId);
  const required: TrustedHookNameV11[] = ["input", "permission", "deny", "mcp", "codex"];
  // Known V1.1 extensions: the queued-receipt observer and the automatic
  // permission-policy callback. Neither replaces any required admission hook.
  const allowed = new Set<string>([...required, "queuedReceipt", "automatic"]);
  return (
    own?.contract === "1.1" &&
    new Set(own.hooks).size === own.hooks.length &&
    own.hooks.every((hook) => allowed.has(hook)) &&
    required.every((hook) => own.hooks.includes(hook))
  );
}
