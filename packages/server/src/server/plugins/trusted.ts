// FULCRA(trusted-bundle): configured routing preserves verified bundle/principal/lifetime admission.
import { requireTrustedBundleHost } from "./trusted-platform.js";
import { NativeQueuedMessageReceiptSchema } from "@getpaseo/protocol/native-intercom";
import type { ControllerDistribution } from "./controller-distribution.js";
import { admissionRequest, admissionCheck, admissionDiagnostic } from "./admission-outcome.js";
import { ManagementAuthority, type ManagementStartup } from "./management.js";
import { AccountActionsAudit, type AccountActionSink } from "./account-actions.js";
import { promptOptionSubset } from "../agent/trusted-operation.js";
import {
  canonicalTrustedPayload,
  canonicalJson,
  type TrustedPayloadV11,
  type TrustedOperationV11,
  type ProvenanceBindingV11,
  type Sha256,
} from "@getpaseo/protocol/trusted-input";
import type {
  TrustedPluginContributionV11,
  TrustedPluginServerV11,
  TrustedAgentV11,
  TrustedCodexTurnV11,
  QuotaReadFailureV11,
} from "@getpaseo/plugin/server";
import { deepFreeze, permissionFacts, runtimeFacts } from "./trusted-facts.js";
import type { AgentQuotaSnapshot } from "@getpaseo/protocol/messages";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AdmissionDecision,
  InputSequence,
  ProvenanceBinding,
  TrustedAgent,
  TrustedInput,
  TrustedInputKind,
  LegacyTrustedPluginContribution as TrustedPluginContribution,
  LegacyTrustedPluginServer as TrustedPluginServer,
} from "@getpaseo/plugin/server";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";

interface Agent {
  instanceId?: string;
  currentModeId?: string | null;
  runtimeInfo?: { sessionId?: string | null; model?: string | null };
  config?: { model?: string | null } | null;
  features?: readonly { id: string; type: string; value?: unknown }[];
  lastUserMessageAt?: Date | string | null;
  inFlightPermissionResponses?: ReadonlySet<string>;
  id: string;
  provider?: string;
  cwd?: string;
  archivedAt?: string | null;
  labels?: Record<string, string>;
  lifecycle?: string;
  workspaceId?: string;
  activeTurnId?: string | null;
  activeForegroundTurnId?: string | null;
  pendingPermissions?: ReadonlyMap<string, unknown>;
  persistence?: { sessionId: string } | null;
}

interface Hooks {
  input?: Parameters<TrustedPluginServer["admission"]["onInput"]>[0];
  mcp?: Parameters<TrustedPluginServer["admission"]["mcpRefresh"]>[0];
  codex?: Parameters<TrustedPluginServer["admission"]["codexTurn"]>[0];
  permission?: Parameters<TrustedPluginServer["guard"]>[1];
  deny?: Parameters<TrustedPluginServer["claude"]["deny"]>[0];
}
interface V11Hooks {
  queuedReceipt?: Parameters<TrustedPluginServerV11["admission"]["nativeQueuedReceipt"]>[0];
  input?: Parameters<TrustedPluginServerV11["admission"]["onInput"]>[0];
  mcp?: Parameters<TrustedPluginServerV11["admission"]["mcpRefresh"]>[0];
  codex?: Parameters<TrustedPluginServerV11["admission"]["codexTurn"]>[0];
  permission?: Parameters<TrustedPluginServerV11["guard"]>[1];
  deny?: Parameters<TrustedPluginServerV11["claude"]["deny"]>[0];
  automatic?: Parameters<TrustedPluginServerV11["permissions"]["automatic"]>[0];
}
export interface TrustedOperationHandle {
  readonly operation: TrustedOperationV11;
}
interface InputContext {
  token?: string;
  handle?: TrustedOperationHandle;
  payload?: TrustedPayloadV11;
  source: "human" | "agent" | "daemon";
  /** Set only by explicit host closures; never accepted from a wire caller. */
  cause?: "shutdown" | "parent-adoption";
  input?: TrustedInput;
  verified?: { pluginId: string; binding: ProvenanceBinding };
  counted: Set<string>;
}

export function refuseUntrustedHook(): never {
  throw new Error("Only trusted bundled plugins may register host security hooks");
}

export const untrustedHostHooks: TrustedPluginServer & TrustedPluginServerV11 = Object.freeze({
  inputObservations: Object.freeze({
    get boot(): string {
      return refuseUntrustedHook();
    },
    require: refuseUntrustedHook,
    nativeIdentity: refuseUntrustedHook,
  }),
  admission: Object.freeze({
    nativeQueuedReceipt: refuseUntrustedHook,
    onInput: refuseUntrustedHook,
    mcpRefresh: refuseUntrustedHook,
    codexTurn: refuseUntrustedHook,
  }),
  guard: refuseUntrustedHook,
  claude: Object.freeze({ deny: refuseUntrustedHook }),
  permissions: Object.freeze({ automatic: refuseUntrustedHook }),
  issueProvenance: refuseUntrustedHook,
  managementBridge: Object.freeze({ register: refuseUntrustedHook }),
});

export class AdmissionDeniedError extends Error {
  constructor(message = "Trusted plugin denied admission") {
    super(message);
    this.name = "AdmissionDeniedError";
  }
}

function observeThenable(value: unknown): void {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) {
    void Promise.resolve(value).catch(() => undefined);
    throw new AdmissionDeniedError("Trusted plugin denied admission: hooks must be synchronous");
  }
}

function requireAllow(decision: AdmissionDecision): void {
  observeThenable(decision);
  // Explicit allow only: promises, undefined and malformed replies fail closed too.
  if (decision !== "allow") throw new AdmissionDeniedError();
}

// Claude's SDK launches include probes without an agent. Enforce all active host
// restrictions at the sole query choke point, including these unscoped launches.
const claudeAuthorities = new Set<TrustedPlugins>();
export function trustedClaudeDenyRules(): string[] {
  return [...new Set([...claudeAuthorities].flatMap((authority) => authority.claudeDenyRules()))];
}

function permitsCommandConsequence(
  primary: Extract<TrustedPayloadV11, { type: "command" }>,
  payload: Extract<TrustedPayloadV11, { type: "command" }>,
): boolean {
  if (
    primary.command === "close" &&
    payload.command === "close" &&
    Object.keys(payload.arguments).length === 0
  )
    return true;
  if (primary.command === "reload" && payload.command === "interrupt") return true;
  if (primary.command === "reload" && payload.command === "unarchive")
    return (
      Object.keys(payload.arguments).length === 0 &&
      canonicalJson(primary.arguments.options ?? null) === '{"rehydrateFromDisk":true}'
    );
  if (payload.command === "cancel")
    return ["rewind", "reload", "interrupt", "archive"].includes(primary.command);
  return (
    primary.command === "archive" &&
    !Object.hasOwn(primary.arguments, "archivedAt") &&
    payload.command === "archive"
  );
}

function permitsNestedCommand(
  primary: TrustedPayloadV11,
  payload: TrustedPayloadV11,
  primaryKind: TrustedInputKind,
): boolean {
  if (payload.type !== "command") return false;
  if (primary.type === "command") return permitsCommandConsequence(primary, payload);
  if (primary.type !== "prompt") return false;
  switch (payload.command) {
    case "reload":
      // Stale-provider recovery may reopen the same configuration, never alter it.
      return Object.keys(payload.arguments).length === 0;
    case "cancel":
      return (
        primaryKind === "steer" ||
        primary.options.replaceRunning === true ||
        primary.options.activeTurnBehavior !== null
      );
    case "unarchive":
      return primary.options.unarchive === true && Object.keys(payload.arguments).length === 0;
    case "set-mode":
      return payload.arguments.modeId === primary.options.sessionMode;
    default:
      return false;
  }
}

export class TrustedPlugins {
  readonly boot = randomUUID();
  constructor(management?: ManagementStartup, options?: { accountActions?: AccountActionSink }) {
    this.management = new ManagementAuthority(management, options);
    Object.defineProperty(this, "boot", { value: this.boot, writable: false, configurable: false });
  }
  private readonly v11 = new Map<string, V11Hooks>();
  private readonly known = new Set<string>();
  private readonly deleted = new Set<string>();
  private indexed = false;
  private readonly handles = new WeakMap<TrustedOperationHandle, InputContext>();
  private nativeIdentityReader?: (
    id: string,
  ) => { instanceId: string; nativeSessionId: string } | null;
  /** Native manager-owned single reader. It never supplies action grants or accepts wire identity strings. */
  setNativeIdentityReader(
    reader: (id: string) => { instanceId: string; nativeSessionId: string } | null,
  ): void {
    if (this.nativeIdentityReader || typeof reader !== "function")
      throw new Error("Native identity reader already bound");
    this.nativeIdentityReader = reader;
  }
  hasV11Authority(): boolean {
    return this.v11.size > 0;
  }

  initializeKnownAgents(ids: readonly string[]): void {
    if (this.indexed) throw new Error("Agent index already initialized");
    for (const id of ids) this.known.add(id);
    if (this.v11.size) this.validateKnownAgents();
    this.indexed = true;
  }
  addKnownAgent(id: string): void {
    this.assertHealthy();
    if (
      (this.v11.size > 0 &&
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) ||
      this.deleted.has(id)
    )
      throw new Error("Invalid or deleted agent identity");
    this.known.add(id);
  }
  private validateKnownAgents(): void {
    for (const id of this.known) {
      if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || this.deleted.has(id))
        throw new Error("Invalid or deleted agent identity");
    }
  }
  /** Normalised prompt bytes already checked by admission, isolated from caller mutation. */
  dispatchPrompt(handle: TrustedOperationHandle) {
    const payload = this.handles.get(handle)?.payload;
    if (!payload || payload.type !== "prompt")
      throw new AdmissionDeniedError("Prompt operation unavailable");
    return structuredClone(payload.prompt);
  }

  deleteKnownAgent(id: string): void {
    this.known.delete(id);
    this.deleted.add(id);
  }
  requireSequence(id: string): Readonly<InputSequence> {
    this.assertHealthy();
    if (!this.indexed || !this.known.has(id) || this.deleted.has(id))
      throw new AdmissionDeniedError("Agent input observation unavailable");
    const sequence = this.sequence(id);
    if (
      !Number.isSafeInteger(sequence.humanAt) ||
      sequence.humanAt < 0 ||
      sequence.humanAt >= Number.MAX_SAFE_INTEGER
    )
      throw new AdmissionDeniedError("Unsafe human input counter");
    return Object.freeze(sequence);
  }
  /** This boot's human-input counters (absent = 0), for the clean-exit seal only; never an admission fact. */
  humanInputSnapshot(): Record<string, number> {
    return Object.fromEntries([...this.sequences].map(([id, sequence]) => [id, sequence.humanAt]));
  }
  captureOperation(): TrustedOperationHandle | undefined {
    return this.context.getStore()?.handle;
  }
  resumeOperation<T>(handle: TrustedOperationHandle | undefined, action: () => T): T {
    this.assertHealthy();
    if (!handle) return this.daemon(action);
    const context = this.handles.get(handle);
    if (!context) throw new AdmissionDeniedError("Unknown operation handle");
    return this.context.run(context, action);
  }
  /** Only a native manager-held original operation may publish ledger outcome facts. Not an input/grant route. */
  nativeQueuedReceipt(agent: Agent, handle: TrustedOperationHandle, raw: unknown): void {
    const context = this.handles.get(handle);
    if (!context || handle.operation.agentId !== agent.id || !handle.operation.pluginId)
      throw new AdmissionDeniedError("Unknown native receipt operation");
    const receipt = NativeQueuedMessageReceiptSchema.parse(raw);
    if (receipt.messageId !== handle.operation.messageId)
      throw new AdmissionDeniedError("Native receipt operation changed");
    const hook = this.v11.get(handle.operation.pluginId)?.queuedReceipt;
    if (hook) {
      const result: unknown = hook(
        this.agentV11(agent),
        handle.operation,
        deepFreeze(structuredClone(receipt)),
      );
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw new AdmissionDeniedError("Asynchronous native receipt observer refused");
      }
    }
  }
  private readonly plugins = new Map<string, Hooks>();
  private readonly builtInDeny: string[] = [];
  private readonly sequences = new Map<string, InputSequence>();
  private readonly tokens = new Map<
    string,
    { pluginId: string; binding: ProvenanceBinding; expires: number }
  >();
  private readonly context = new AsyncLocalStorage<InputContext>();
  private failed = false;

  readonly management: ManagementAuthority;
  /** FULCRA(trusted-bundle): routing identity only; physical bundle and hook checks remain mandatory. */
  get controllerPluginId(): string {
    return this.management.controllerPluginId;
  }
  requiresPackagedRuntime(id: string): boolean {
    return id === this.controllerPluginId && distributions.has(this);
  }
  claimsBundle(id: string): boolean {
    return this.plugins.has(id) || this.v11.has(id);
  }
  async verifyBundledDirectory(id: string, directory: string): Promise<string | undefined> {
    if (!this.claimsBundle(id)) return undefined;
    const expected = bundledDirectories.get(this)?.get(id);
    if (!expected || (await realpath(directory)) !== expected)
      throw new Error("Trusted plugin requires its distribution bundle");
    return expected;
  }

  revokeProvenance(pluginId: string): void {
    for (const [token, value] of this.tokens)
      if (value.pluginId === pluginId) this.tokens.delete(token);
  }

  registerV11(id: string, trusted: boolean, setup: TrustedPluginContributionV11): void {
    if (!trusted) refuseUntrustedHook();
    if (!this.indexed) throw new Error("Trusted setup requires complete agent index");
    this.validateKnownAgents();
    if (this.plugins.has(id) || this.v11.has(id)) throw new Error("Duplicate trusted plugin");
    const hooks: V11Hooks = {};
    let registering = true;
    const set = <K extends keyof V11Hooks>(key: K, value: NonNullable<V11Hooks[K]>) => {
      if (!registering || hooks[key]) throw new Error("Invalid trusted hook registration");
      if (key === "codex") {
        const callbacks = value as V11Hooks["codex"];
        if (
          typeof callbacks?.check !== "function" ||
          typeof callbacks.onQuotaReadFailure !== "function"
        )
          throw new Error("Both Codex callbacks required");
        hooks[key] = Object.freeze({ ...callbacks }) as V11Hooks[K];
      } else {
        if (typeof value !== "function") throw new Error("Invalid trusted hook");
        hooks[key] = value;
      }
    };
    try {
      const result = setup({
        managementBridge: {
          register: (handler) => {
            if (!registering) throw new Error("Management bridge registration closed");
            this.management.register(id, handler);
          },
        },
        inputObservations: Object.freeze({
          boot: this.boot,
          require: (agentId: string) => this.requireSequence(agentId),
          nativeIdentity: (agentId: string) => {
            this.requireSequence(agentId);
            const identity = this.nativeIdentityReader?.(agentId);
            return identity ? Object.freeze({ ...identity }) : null;
          },
        }),
        admission: {
          nativeQueuedReceipt: (h) => set("queuedReceipt", h),
          onInput: (h) => set("input", h),
          mcpRefresh: (h) => set("mcp", h),
          codexTurn: (h) => set("codex", h),
        },
        guard: (name, h) => {
          if (name !== "agent.permission_respond") throw new Error("Invalid guard");
          set("permission", h);
        },
        claude: { deny: (h) => set("deny", h) },
        permissions: { automatic: (h) => set("automatic", h) },
        issueProvenance: (binding) => {
          this.assertHealthy();
          if (!this.v11.has(id)) throw new Error("Trusted plugin is not active");
          canonicalJson(binding);
          if (
            Object.keys(binding).sort().join(",") !==
              "agentId,attemptId,kind,messageId,payloadDigest" ||
            !/^[a-f0-9]{64}$/.test(binding.payloadDigest) ||
            !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.attemptId) ||
            !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.agentId)
          )
            throw new Error("Invalid provenance binding");
          const now = Date.now();
          for (const [token, value] of this.tokens)
            if (value.expires <= now) this.tokens.delete(token);
          if (this.tokens.size >= 4096) throw new Error("Too many outstanding provenance tokens");
          const token = randomUUID();
          this.tokens.set(token, {
            pluginId: id,
            binding: structuredClone(binding) as unknown as ProvenanceBinding,
            expires: now + 60_000,
          });
          return token;
        },
      });
      observeThenable(result);
      if (result !== undefined) throw new Error("Trusted setup must return void");
      this.v11.set(id, hooks);
      claudeAuthorities.add(this);
    } catch (error) {
      this.failed = true;
      this.management.close();
      throw error;
    } finally {
      registering = false;
    }
  }

  /** Called only by the host bundle loader, never through plugin IPC or RPC. */
  register(id: string, trusted: boolean, setup: TrustedPluginContribution): void {
    if (!trusted) refuseUntrustedHook();
    if (this.plugins.has(id) || this.v11.has(id))
      throw new Error(`Duplicate trusted plugin: ${id}`);
    const hooks: Hooks = {};
    let registering = true;
    const set = <K extends keyof Hooks>(key: K, handler: NonNullable<Hooks[K]>) => {
      if (!registering || hooks[key] || typeof handler !== "function") {
        throw new Error(`Invalid trusted hook registration: ${key}`);
      }
      hooks[key] = handler;
    };
    try {
      const result = setup({
        admission: {
          onInput: (handler) => set("input", handler),
          mcpRefresh: (handler) => set("mcp", handler),
          codexTurn: (handler) => set("codex", handler),
        },
        guard: (name, handler) => {
          if (name !== "agent.permission_respond") throw new Error("Unknown trusted guard");
          set("permission", handler);
        },
        claude: { deny: (handler) => set("deny", handler) },
        issueProvenance: (binding) => {
          if (!this.plugins.has(id) || this.failed) throw new Error("Trusted plugin is not active");
          const now = Date.now();
          for (const [token, value] of this.tokens)
            if (value.expires <= now) this.tokens.delete(token);
          if (this.tokens.size >= 4096) throw new Error("Too many outstanding provenance tokens");
          const token = randomUUID();
          this.tokens.set(token, {
            pluginId: id,
            binding: structuredClone(binding),
            expires: now + 60_000,
          });
          return token;
        },
      });
      observeThenable(result);
      if (result !== undefined)
        throw new Error("Trusted plugin setup must be synchronous and return void");
      this.plugins.set(id, hooks);
      claudeAuthorities.add(this);
    } catch (error) {
      this.failed = true;
      this.management.close();
      throw error;
    } finally {
      registering = false;
    }
  }

  catalog(): Array<{ id: string; contract?: "1.1"; hooks: string[] }> {
    this.assertHealthy();
    return [
      ...[...this.plugins].map(([id, hooks]) => ({ id, hooks: Object.keys(hooks) })),
      ...[...this.v11].map(([id, hooks]) => ({
        id,
        contract: "1.1" as const,
        hooks: Object.keys(hooks),
      })),
    ];
  }

  sequence(id: string): InputSequence {
    return { ...(this.sequences.get(id) ?? { boot: this.boot, humanAt: 0 }) };
  }

  rpc<T>(token: string | undefined, operation: () => T): T {
    const consumeOnFailure = (error: unknown): never => {
      if (token !== undefined) this.tokens.delete(token);
      throw error;
    };
    return admissionRequest(() =>
      this.context.run({ token, source: "human", counted: new Set() }, () => {
        try {
          const result = operation();
          return result instanceof Promise ? (result.catch(consumeOnFailure) as T) : result;
        } catch (error) {
          return consumeOnFailure(error);
        }
      }),
    );
  }

  daemon<T>(operation: () => T): T {
    return this.context.run({ source: "daemon", counted: new Set() }, operation);
  }

  /** Host-only metadata admission. The transport owner reader is never supplied by a wire caller. */
  parentAdoption<T>(
    agent: Agent,
    payload: TrustedPayloadV11,
    validate: () => void,
    operation: () => T,
  ): T {
    validate();
    if (payload.type !== "command" || payload.command !== "adopt-parent")
      throw new AdmissionDeniedError("Parent adoption payload required");
    canonicalTrustedPayload({ agentId: agent.id, kind: "configure", messageId: null, payload });
    if ([...this.plugins.values()].some((hooks) => !!hooks.input))
      throw new AdmissionDeniedError("Legacy input authority cannot admit parent metadata");
    return this.context.run(
      { source: "daemon", cause: "parent-adoption", counted: new Set() },
      () =>
        this.input(
          agent,
          "configure",
          undefined,
          () => {
            validate();
            return operation();
          },
          payload,
        ),
    );
  }

  /**
   * The orderly-shutdown closure only; its one caller is bootstrap stop(). Daemon input whose call path is
   * that closure carries cause "shutdown", so a trusted plugin can tell it from every other daemon close
   * (provider retirement, load failure) without host state (W1 row 9, H7b).
   */
  shutdownClosure<T>(operation: () => T): T {
    return this.context.run({ source: "daemon", cause: "shutdown", counted: new Set() }, operation);
  }

  /** Host follow-ups have no inherited token/handle; only a human cause remains human. */
  followup<T>(operation: () => T): T {
    const ambient = this.context.getStore();
    const source =
      ambient?.verified || !ambient || ambient.source === "daemon" ? "daemon" : ambient.source;
    // The shutdown closure shares one context across every agent it closes: keep its cause on the follow-ups.
    if (ambient?.cause === "shutdown" && !ambient.verified && source === "daemon")
      return this.context.run({ source, cause: ambient.cause, counted: new Set() }, operation);
    return this.context.run({ source, counted: new Set() }, operation);
  }

  agentInput<T>(operation: () => T): T {
    return this.context.run({ source: "agent", counted: new Set() }, operation);
  }

  input<T>(
    agent: Agent,
    kind: TrustedInputKind,
    messageId: string | undefined,
    operation: () => T,
    payload?: TrustedPayloadV11 | (() => TrustedPayloadV11),
    handle?: TrustedOperationHandle,
    phase?: "enqueue",
  ): T {
    let actual: TrustedPayloadV11 | undefined;
    if (this.v11.size) actual = typeof payload === "function" ? payload() : payload;
    if (handle)
      return this.resumeOperation(handle, () =>
        this.admitInput(agent, kind, messageId, operation, actual, phase),
      );
    const ambient = this.context.getStore();
    if (this.v11.size && ambient?.handle) {
      return this.followup(() => this.admitInput(agent, kind, messageId, operation, actual, phase));
    }
    return this.admitInput(agent, kind, messageId, operation, actual, phase);
  }

  private admitInput<T>(
    agent: Agent,
    kind: TrustedInputKind,
    messageId: string | undefined,
    operation: () => T,
    payload?: TrustedPayloadV11,
    phase?: "enqueue",
  ): T {
    if (!this.context.getStore()) {
      return this.context.run({ source: "daemon", counted: new Set() }, () =>
        this.admitInput(agent, kind, messageId, operation, payload, phase),
      );
    }
    admissionCheck(() => {
      this.assertHealthy();
      const context = this.context.getStore()!;
      if (this.v11.size && !payload && (context.handle || context.verified))
        throw new AdmissionDeniedError("Actual input payload unavailable");
      const digest = this.inputDigest(agent, kind, messageId, payload);
      this.consumeInputToken(agent, kind, messageId, digest, context);
      this.verifyOperationBinding(agent, messageId, payload, digest, context);
      this.createOperation(agent, kind, messageId, payload, digest, context);
      if (this.v11.size && !context.handle)
        throw new AdmissionDeniedError("Actual input payload unavailable");
      this.countHumanInput(agent, context);
      const input: TrustedInput = {
        kind,
        messageId,
        source: context.verified ? "plugin" : context.source,
        provenance: context.verified ? { pluginId: context.verified.pluginId } : null,
      };
      context.input = input;
      for (const hooks of this.plugins.values()) {
        if (hooks.input) {
          try {
            requireAllow(hooks.input(this.agent(agent), structuredClone(input)));
          } catch (error) {
            if (error instanceof AdmissionDeniedError) throw error;
            throw new AdmissionDeniedError(
              `Trusted plugin denied admission: ${error instanceof Error ? error.message : "input hook failed"}`,
            );
          }
        }
      }
      for (const hooks of this.v11.values()) {
        if (!hooks.input) continue;
        try {
          requireAllow(hooks.input(this.agentV11(agent), this.inputV11(context, phase)));
        } catch (error) {
          if (error instanceof AdmissionDeniedError) throw error;
          const denied = new AdmissionDeniedError("Trusted plugin input hook failed");
          if (error instanceof Error) admissionDiagnostic(denied, error.message);
          throw denied;
        }
      }
    });
    return operation();
  }

  private inputDigest(
    agent: Agent,
    kind: TrustedInputKind,
    messageId: string | undefined,
    payload: TrustedPayloadV11 | undefined,
  ): Sha256 | undefined {
    return this.v11.size && payload
      ? (createHash("sha256")
          .update(
            canonicalTrustedPayload({
              agentId: agent.id,
              kind,
              messageId: messageId ?? null,
              payload,
            }),
          )
          .digest("hex") as Sha256)
      : undefined;
  }

  private inputV11(
    context: InputContext,
    phase?: "enqueue",
  ): import("@getpaseo/plugin/server").TrustedInputV11 {
    const verified = context.verified && this.v11.has(context.verified.pluginId);
    return deepFreeze({
      ...structuredClone(context.input!),
      source: verified ? "plugin" : context.source,
      provenance: verified ? { pluginId: context.verified!.pluginId } : null,
      ...(context.cause && !verified ? { cause: context.cause } : {}),
      ...(phase ? { admissionPhase: phase } : {}),
      operation: context.handle!.operation,
    });
  }

  private consumeInputToken(
    agent: Agent,
    kind: TrustedInputKind,
    messageId: string | undefined,
    digest: Sha256 | undefined,
    context: InputContext,
  ): void {
    if (context.token !== undefined && !context.verified) {
      const token = this.tokens.get(context.token);
      this.tokens.delete(context.token);
      if (
        !token ||
        token.expires <= Date.now() ||
        token.binding.agentId !== agent.id ||
        token.binding.kind !== kind ||
        (token.binding.messageId ?? null) !== (messageId ?? null) ||
        (this.v11.has(token.pluginId) &&
          (!digest || (token.binding as unknown as ProvenanceBindingV11).payloadDigest !== digest))
      ) {
        throw new AdmissionDeniedError("Invalid, expired or replayed input provenance");
      }
      context.verified = token;
    }
    if (
      context.verified &&
      (context.verified.binding.agentId !== agent.id ||
        (messageId !== undefined && context.verified.binding.messageId !== messageId))
    ) {
      throw new AdmissionDeniedError("Input provenance cannot cross agent boundaries");
    }
  }

  private verifyOperationBinding(
    agent: Agent,
    messageId: string | undefined,
    payload: TrustedPayloadV11 | undefined,
    digest: Sha256 | undefined,
    context: InputContext,
  ): void {
    if (this.v11.size && context.handle && context.handle.operation.agentId !== agent.id)
      throw new AdmissionDeniedError("Operation cannot cross agents");
    if (this.v11.size && context.handle && payload) {
      const primary = context.payload!;
      if (primary.type === "prompt" && payload.type === "prompt") {
        this.verifyNestedPrompt(agent, messageId, primary, payload, context.handle.operation);
      } else if (digest !== context.handle.operation.payloadDigest) {
        const permitted = permitsNestedCommand(primary, payload, context.handle.operation.kind);
        if (!permitted) throw new AdmissionDeniedError("Unbound nested effect");
      }
    }
  }

  private verifyNestedPrompt(
    agent: Agent,
    messageId: string | undefined,
    primary: Extract<TrustedPayloadV11, { type: "prompt" }>,
    payload: Extract<TrustedPayloadV11, { type: "prompt" }>,
    operation: TrustedOperationV11,
  ): void {
    const primaryOperation = operation;
    if ((messageId ?? null) !== primaryOperation.messageId)
      throw new AdmissionDeniedError("Nested message identity changed");
    const subset = promptOptionSubset(payload);
    if (
      subset &&
      !subset.has("sessionMode") &&
      primary.options.sessionMode !== null &&
      agent.currentModeId !== primary.options.sessionMode
    )
      throw new AdmissionDeniedError("Bound session mode was not applied");
    if (
      subset &&
      !subset.has("unarchive") &&
      primary.options.unarchive === true &&
      agent.archivedAt !== null
    )
      throw new AdmissionDeniedError("Bound unarchive was not applied");
    const actualOptions = { ...primary.options };
    for (const [key, value] of Object.entries(payload.options))
      if (!subset || subset.has(key)) Reflect.set(actualOptions, key, value);
    const reconstructed = canonicalTrustedPayload({
      agentId: agent.id,
      kind: primaryOperation.kind,
      messageId: primaryOperation.messageId,
      payload: { type: "prompt", prompt: payload.prompt, options: actualOptions },
    });
    if (createHash("sha256").update(reconstructed).digest("hex") !== primaryOperation.payloadDigest)
      throw new AdmissionDeniedError("Nested prompt or options changed");
  }

  private createOperation(
    agent: Agent,
    kind: TrustedInputKind,
    messageId: string | undefined,
    payload: TrustedPayloadV11 | undefined,
    digest: Sha256 | undefined,
    context: InputContext,
  ): void {
    if (this.v11.size && !context.handle && digest && payload) {
      const verified =
        context.verified && this.v11.has(context.verified.pluginId) ? context.verified : undefined;
      const binding = verified?.binding as ProvenanceBindingV11 | undefined;
      const primaryOperation: TrustedOperationV11 = Object.freeze({
        operationId: randomUUID(),
        agentId: agent.id,
        kind,
        messageId: messageId ?? null,
        payloadDigest: digest,
        attemptId: binding?.attemptId ?? null,
        pluginId: verified?.pluginId ?? null,
      });
      context.handle = Object.freeze({ operation: primaryOperation });
      context.payload = deepFreeze(structuredClone(payload));
      this.handles.set(context.handle, context);
    }
  }

  private countHumanInput(agent: Agent, context: InputContext): void {
    if (this.indexed && (!this.known.has(agent.id) || this.deleted.has(agent.id))) {
      if (this.v11.size) throw new AdmissionDeniedError("Agent input observation unavailable");
      return;
    }
    if (
      (!context.verified || (this.v11.size > 0 && !this.v11.has(context.verified.pluginId))) &&
      context.source === "human" &&
      (this.indexed ? this.known.has(agent.id) : agent.provider !== undefined) &&
      !context.counted.has(agent.id)
    ) {
      const sequence = this.sequence(agent.id);
      if (
        !Number.isSafeInteger(sequence.humanAt) ||
        sequence.humanAt < 0 ||
        sequence.humanAt >= Number.MAX_SAFE_INTEGER - 1
      )
        throw new AdmissionDeniedError("Unsafe human input counter");
      this.sequences.set(agent.id, { ...sequence, humanAt: sequence.humanAt + 1 });
      context.counted.add(agent.id);
    }
  }

  hasPermissionGuards(): boolean {
    this.assertHealthy();
    return [...this.plugins.values(), ...this.v11.values()].some(
      (hooks) => hooks.permission !== undefined,
    );
  }

  permission(agent: Agent, requestId: string, response: AgentPermissionResponse): string {
    return admissionCheck(() => {
      this.assertHealthy();
      const before = permissionFacts(agent);
      for (const hooks of this.plugins.values()) {
        if (!hooks.permission) continue;
        const decision = hooks.permission(
          this.agent(agent),
          requestId,
          structuredClone(response),
          structuredClone(
            this.context.getStore()?.input ?? {
              kind: "permission",
              messageId: requestId,
              source: "daemon",
              provenance: null,
            },
          ),
        );
        observeThenable(decision);
        if (decision === "allow") continue;
        if (
          decision &&
          typeof decision === "object" &&
          !("then" in decision) &&
          typeof decision.requestId === "string" &&
          decision.requestId.length > 0
        ) {
          requestId = decision.requestId;
        } else throw new AdmissionDeniedError("Trusted plugin denied permission response");
      }
      return this.permissionV11(agent, requestId, response, before);
    });
  }

  private permissionV11(
    agent: Agent,
    requestId: string,
    response: AgentPermissionResponse,
    before: ReturnType<typeof permissionFacts>,
  ): string {
    for (const hooks of this.v11.values()) {
      if (!hooks.permission) continue;
      const context = this.context.getStore();
      if (!context?.input || !context.handle || before.status !== "known")
        throw new AdmissionDeniedError("Permission facts unavailable");
      const decision = hooks.permission(
        this.agentV11(agent),
        requestId,
        structuredClone(response),
        this.inputV11(context),
      );
      observeThenable(decision);
      if (decision === "allow") continue;
      if (decision && typeof decision === "object" && typeof decision.requestId === "string")
        requestId = decision.requestId;
      else throw new AdmissionDeniedError("Trusted plugin denied permission response");
    }
    if (this.v11.size) {
      const after = permissionFacts(agent);
      if (
        before.status !== "known" ||
        after.status !== "known" ||
        canonicalJson(before) !== canonicalJson(after) ||
        !after.requests.some((request) => request.id === requestId) ||
        after.inFlightRequestIds.includes(requestId)
      )
        throw new AdmissionDeniedError("Pending permission changed or unavailable");
    }
    return requestId;
  }

  mcpRefresh(agent: Agent): { allowed: boolean; revision: string } {
    return admissionCheck(() => {
      this.assertHealthy();
      const revisions: Array<[string, string]> = [];
      for (const [id, hooks] of this.plugins) {
        if (!hooks.mcp) continue;
        const decision = hooks.mcp(this.agent(agent));
        observeThenable(decision);
        if (decision?.allowed !== true || typeof decision.revision !== "string")
          throw new Error("Trusted plugin denied MCP refresh");
        revisions.push([id, decision.revision]);
      }
      for (const [id, hooks] of this.v11) {
        if (!hooks.mcp) continue;
        const decision = hooks.mcp(this.agentV11(agent));
        observeThenable(decision);
        if (decision?.allowed !== true || typeof decision.revision !== "string")
          throw new AdmissionDeniedError("Trusted plugin denied MCP refresh");
        revisions.push([id, decision.revision]);
      }
      return {
        allowed: true,
        revision: revisions.length ? JSON.stringify(revisions) : "unmanaged",
      };
    });
  }

  hasCodexTurnHooks(): boolean {
    this.assertHealthy();
    return [...this.plugins.values(), ...this.v11.values()].some(
      (hooks) => hooks.codex !== undefined,
    );
  }

  hasV11CodexTurnHooks(): boolean {
    this.assertHealthy();
    return [...this.v11.values()].some((hooks) => hooks.codex !== undefined);
  }

  codexTurn(agent: Agent, quota: AgentQuotaSnapshot): true {
    this.assertHealthy();
    for (const hooks of this.plugins.values())
      if (hooks.codex) requireAllow(hooks.codex(this.agent(agent), structuredClone(quota)));
    return true;
  }

  codexTurnV11(agent: Agent, turn: TrustedCodexTurnV11, quota: AgentQuotaSnapshot): true {
    return admissionCheck(() => {
      this.codexTurn(agent, quota);
      for (const hooks of this.v11.values())
        if (hooks.codex)
          requireAllow(
            hooks.codex.check(
              this.agentV11(agent),
              deepFreeze(structuredClone(turn)),
              deepFreeze(structuredClone(quota)),
            ),
          );
      return true;
    });
  }
  quotaReadFailure(agent: Agent, turn: TrustedCodexTurnV11, failure: QuotaReadFailureV11): void {
    return admissionCheck(() => {
      this.assertHealthy();
      for (const hooks of this.v11.values()) {
        if (!hooks.codex) continue;
        const result = hooks.codex.onQuotaReadFailure(
          this.agentV11(agent),
          deepFreeze(structuredClone(turn)),
          Object.freeze({ ...failure }),
        );
        observeThenable(result);
        if (result !== undefined)
          throw new AdmissionDeniedError("Quota failure callback must return void");
      }
    });
  }
  private agentV11(agent: Agent): TrustedAgentV11 {
    return deepFreeze({
      ...this.agent(agent),
      inputSequence: this.requireSequence(agent.id),
      permissions: permissionFacts(agent),
      runtime: runtimeFacts(agent),
    });
  }

  /** Host-owned files no agent may touch, whatever the plugins contribute (W1: daemon-boot.ts). */
  denyToAgents(rules: readonly string[]): void {
    this.builtInDeny.push(...rules);
    // Reach every Claude query even in a boot with no trusted plugin registered (review delta W1-1(d)).
    claudeAuthorities.add(this);
  }

  /**
   * FIX-8 W3: whether a trusted plugin answers this permission request itself, before it is surfaced. Fail-closed:
   * true only when some handler returns "allow" and none returns anything else or throws.
   */
  automaticPermission(agent: Agent, request: AgentPermissionRequest): boolean {
    try {
      this.assertHealthy();
      let allowed = false;
      for (const hooks of this.v11.values()) {
        if (!hooks.automatic) continue;
        const decision = hooks.automatic(this.agentV11(agent), structuredClone(request));
        observeThenable(decision);
        if (decision === "allow") allowed = true;
        else return false;
      }
      return allowed;
    } catch {
      return false;
    }
  }

  claudeDenyRules(): string[] {
    this.assertHealthy();
    const rules: string[] = [...this.builtInDeny];
    for (const hooks of [...this.plugins.values(), ...this.v11.values()]) {
      if (!hooks.deny) continue;
      const additions = hooks.deny();
      observeThenable(additions);
      if (
        !Array.isArray(additions) ||
        additions.some((rule) => typeof rule !== "string" || !rule.trim())
      ) {
        throw new Error("Invalid trusted Claude deny rules");
      }
      rules.push(...additions);
    }
    return rules;
  }

  close(): void {
    this.failed = true;
    this.tokens.clear();
    this.management.close();
    claudeAuthorities.delete(this);
  }

  private agent(agent: Agent): TrustedAgent {
    return {
      id: agent.id,
      provider: agent.provider,
      cwd: agent.cwd,
      archivedAt: agent.archivedAt,
      labels: { ...agent.labels },
      lifecycle: agent.lifecycle,
      activeTurnId: agent.activeTurnId,
      activeForegroundTurnId: agent.activeForegroundTurnId,
      pendingPermissionIds: [...(agent.pendingPermissions?.keys() ?? [])],
      persistenceSessionId: agent.persistence?.sessionId,
      workspaceId: agent.workspaceId,
      inputSequence: this.sequence(agent.id),
    };
  }
  private assertHealthy(): void {
    if (this.failed) throw new AdmissionDeniedError("Trusted plugin host is unavailable");
  }
}

const distributions = new WeakMap<TrustedPlugins, ControllerDistribution>();
export function controllerDistribution(
  authority: TrustedPlugins,
): ControllerDistribution | undefined {
  return distributions.get(authority);
}

const bundledDirectories = new WeakMap<TrustedPlugins, Map<string, string>>();

/** Only a distribution path provided by the embedding host; never persisted plugin config. */
export async function loadTrustedPlugins(
  directory: string | undefined,
  paseoHome: string,
  knownAgentIds: readonly string[] = [],
  management?: ManagementStartup,
): Promise<TrustedPlugins> {
  if (directory) requireTrustedBundleHost();
  // U7: remote account actions are audited in this home, for the owner.
  const authority = new TrustedPlugins(management, {
    accountActions: new AccountActionsAudit(paseoHome),
  });
  const directories = new Map<string, string>();
  bundledDirectories.set(authority, directories);
  authority.initializeKnownAgents(knownAgentIds);
  if (!directory) return authority;
  const root = await realpath(directory);
  await mkdir(paseoHome, { recursive: true });
  const home = await realpath(paseoHome);
  const isWithin = (parent: string, child: string) =>
    child === parent || child.startsWith(parent + path.sep);
  if (isWithin(home, root)) throw new Error("Trusted bundles must be outside PASEO_HOME");
  try {
    for (const item of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!item.isDirectory() || item.isSymbolicLink())
        throw new Error("Trusted bundle entries must be directories");
      const bundleDirectory = await realpath(path.join(root, item.name));
      const entry = await realpath(path.join(bundleDirectory, "index.host.js"));
      if (
        !isWithin(root, bundleDirectory) ||
        isWithin(home, bundleDirectory) ||
        !isWithin(bundleDirectory, entry) ||
        isWithin(home, entry)
      )
        throw new Error("Trusted bundle entry escaped distribution");
      const manifest = JSON.parse(
        await readFile(path.join(root, item.name, "paseo-plugin.json"), "utf8"),
      );
      if (manifest.id !== item.name || !/^[a-z0-9][a-z0-9-]*$/.test(item.name))
        throw new Error("Invalid trusted bundle id");
      directories.set(item.name, bundleDirectory);
      await verifyTrustedEntryOwnership(bundleDirectory, entry);
      const module = await import(pathToFileURL(entry).href);
      if (typeof module.default !== "function")
        throw new Error("Trusted bundle must export synchronous setup");
      registerDistributionContribution(authority, module, item.name, home, bundleDirectory);
    }
    return authority;
  } catch (error) {
    authority.close();
    throw error;
  }
}

async function verifyTrustedEntryOwnership(bundleDirectory: string, entry: string) {
  for (const file of [bundleDirectory, entry]) {
    const stat = await lstat(file);
    if (
      stat.isSymbolicLink() ||
      stat.mode & 0o022 ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.())
    )
      throw Error("Unsafe trusted bundle ownership");
  }
}
function registerDistributionContribution(
  authority: TrustedPlugins,
  module: {
    hostContract?: string;
    default: unknown;
    createDistribution?: (input: {
      home: string;
      bundleDirectory: string;
    }) => ControllerDistribution;
  },
  id: string,
  home: string,
  bundleDirectory: string,
) {
  if (module.hostContract === "1.1") {
    if (id === authority.controllerPluginId && typeof module.createDistribution === "function") {
      const distribution: ControllerDistribution = module.createDistribution({
        home: path.join(home, "command-centre"),
        bundleDirectory,
      });
      if (
        !distribution ||
        typeof distribution.setup !== "function" ||
        typeof distribution.start !== "function" ||
        typeof distribution.stop !== "function" ||
        typeof distribution.validate !== "function"
      )
        throw Error("Invalid controller distribution");
      distributions.set(authority, distribution);
      authority.registerV11(id, true, distribution.setup);
    } else authority.registerV11(id, true, module.default as TrustedPluginContributionV11);
  }
  // COMPAT(trustedV10): added in v0.9.1, remove after 2027-03-26 once all bundles declare 1.1.
  else if (module.hostContract === undefined || module.hostContract === "1.0")
    authority.register(id, true, module.default as Parameters<TrustedPlugins["register"]>[2]);
  else throw new Error("Unsupported trusted host contract");
}
