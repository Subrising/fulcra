import { configuredControllerPluginId } from "@getpaseo/protocol/bundled-controller";
import { AsyncLocalStorage } from "node:async_hooks";
import { boundedJson } from "./controller-frames.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  ControllerManagementCommandV11,
  ManagementPrincipalV11,
} from "@getpaseo/protocol/controller-management";
import { canonicalJson, type JsonValue, type JsonObject } from "@getpaseo/protocol/trusted-input";
import { AccountActionInputSchema, type AccountActionSink } from "./account-actions.js";

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ManagementAuthentication = Omit<ManagementPrincipalV11, "permissions">;
export type PrincipalReader = () => ManagementPrincipalV11 | undefined;
type Bridge = (
  command: ControllerManagementCommandV11,
  principal: ManagementPrincipalV11,
) => Promise<JsonValue>;
export type OwnerManagementHandler = (
  command: ControllerManagementCommandV11,
  authority: Readonly<{ ownerId: string; requireOwner: () => void }>,
) => Promise<JsonValue>;
export interface ManagementTarget {
  readonly pluginId: string;
  readonly bundleDirectory: string;
  isCurrent(): boolean;
}
export interface ManagementStartup {
  /** FULCRA(trusted-bundle): immutable embedding-host selector, never a wire label or grant. */
  readonly controllerPluginId?: string;
  enabled(target: ManagementTarget): boolean;
  validate(command: ControllerManagementCommandV11): ControllerManagementCommandV11;
  /** D13: whether a validated command is a controller READ. Absent (an older distribution): no read-only management. */
  isRead?(command: ControllerManagementCommandV11): boolean;
}
export interface ManagementInvocation {
  isFor(target: ManagementTarget | undefined): boolean;
  readonly id: string;
  readonly principal: ManagementPrincipalV11;
  /** D13: opened for a read-only principal (sent to the plugin so it refuses writes too). */
  readonly readOnly: boolean;
  /** U7: the principal may manage accounts (the owner, or a device the owner granted accounts.manage); never read-only. */
  readonly accountsManage: boolean;
  /** U7: audits a remote account action for this invocation's device (see ManagementAuthority.recordAccountAction). */
  recordAccountAction(entry: unknown): Promise<{ recorded: boolean }>;
  invoke(callId: string, command: unknown): Promise<JsonValue>;
  close(): void;
}
interface Invocation {
  target: ManagementTarget;
  pluginId: string;
  reader: PrincipalReader;
  principal: ManagementPrincipalV11;
  expires: number;
  calls: Set<string>;
  bridge: Bridge;
  /** D13: opened for a read-only principal; every command must be a read. */
  readOnly: boolean;
}

const dispatchScope = new AsyncLocalStorage<
  (command: ControllerManagementCommandV11, principal: ManagementPrincipalV11) => void
>();
/** Transport write fence, available only inside an admitted trusted bridge call. */
export function consumeManagementDispatch(
  command: ControllerManagementCommandV11,
  principal: ManagementPrincipalV11,
): void {
  const consume = dispatchScope.getStore();
  if (!consume) throw new Error("Missing management dispatch capability");
  consume(command, principal);
}

/** Host-only authority. Configuration and registration are never reachable over plugin RPC. */
export class ManagementAuthority {
  readonly controllerPluginId: string;
  private bridge?: Bridge;
  private handoffObserver?: (sourceId: string, operationId: string) => (() => void) | undefined;

  /** Host-only fact observer. Registration confers no management/report authority. */
  registerHandoffObserver(
    observer: (sourceId: string, operationId: string) => (() => void) | undefined,
  ): void {
    if (this.stopped || this.handoffObserver || typeof observer !== "function")
      throw new Error("Invalid native handoff observer");
    this.handoffObserver = observer;
  }
  private readonly config?: Readonly<ManagementStartup>;
  private invocations = new Map<string, Invocation>();
  private capabilities = new Map<string, { invocation: string; digest: string }>();
  private stopped = false;
  private readonly ownerHandlers = new Map<string, OwnerManagementHandler>();
  private readonly accountActions?: AccountActionSink;

  constructor(config?: ManagementStartup, options?: { accountActions?: AccountActionSink }) {
    this.controllerPluginId = configuredControllerPluginId(config?.controllerPluginId);
    Object.defineProperty(this, "controllerPluginId", {
      value: this.controllerPluginId,
      writable: false,
      configurable: false,
    });
    this.config = config && Object.freeze({ ...config });
    this.accountActions = options?.accountActions;
  }
  private enabled(target: ManagementTarget | undefined): target is ManagementTarget {
    try {
      return (
        !!target &&
        target.pluginId === this.controllerPluginId &&
        !!target.bundleDirectory &&
        target.isCurrent() &&
        this.config?.enabled(target) === true
      );
    } catch {
      return false;
    }
  }
  register(pluginId: string, bridge: Bridge): void {
    if (
      pluginId !== this.controllerPluginId ||
      this.bridge ||
      this.stopped ||
      typeof bridge !== "function"
    )
      throw new Error("Invalid management bridge");
    this.bridge = bridge;
  }
  /** Native host wiring only. Never exposed through the plugin contribution or an RPC. */
  registerOwnerHandler(method: string, handler: OwnerManagementHandler): void {
    if (
      this.stopped ||
      ![
        "report-prime-register",
        "report-prime-promote",
        "report-prime-demote",
        "report-project-transfer",
        "report-parent-adopt",
        "report-registration-revoke",
        "intercom-rate-settings-set",
        "intercom-rate-settings-get",
        "intercom-status",
        "report-inbox-owner-read",
        "evidence-index-owner-read",
        "artifact-tool-owner-set",
        "artifact-content-owner-set",
        "artifact-content-owner-list",
        "artifact-content-owner-read",
        "managed-artifact-index-owner-read",
        "intercom-receipt-maintenance",
        "radius-scratch-simulate",
        "radius-scratch-prune-and-simulate",
      ].includes(method) ||
      this.ownerHandlers.has(method) ||
      typeof handler !== "function"
    )
      throw new Error("Invalid owner-only native handler");
    this.ownerHandlers.set(method, handler);
  }

  private isOwner(principal: ManagementPrincipalV11): boolean {
    // Existing verified owner password/protected IPC principal. Explicit device management grants
    // are not ownership and cannot register the prime, adopt report links or raise Settings rates.
    return (
      this.authorised(principal) &&
      principal.deviceId === null &&
      (principal.authentication === "daemon-password" ||
        principal.authentication === "protected-local-ipc") &&
      principal.permissions.includes("accounts.manage")
    );
  }

  open(
    target: ManagementTarget | undefined,
    reader: PrincipalReader,
    mode?: { readOnly?: boolean },
  ): ManagementInvocation | undefined {
    const principal = reader();
    const pluginId = target?.pluginId;
    // D13: a read-only invocation needs a read principal and the distribution's read classifier; it never widens.
    const readOnly = mode?.readOnly === true;
    if (
      this.stopped ||
      pluginId !== this.controllerPluginId ||
      !this.bridge ||
      !this.enabled(target) ||
      !principal ||
      !(readOnly ? this.readAuthorised(principal) : this.authorised(principal))
    )
      return undefined;
    const id = randomUUID();
    const snapshot = this.snapshot(principal);
    this.invocations.set(id, {
      pluginId,
      target,
      reader,
      principal: snapshot,
      expires: Date.now() + 30_000,
      calls: new Set(),
      bridge: this.bridge,
      readOnly,
    });
    return Object.freeze({
      id,
      isFor: (candidate: ManagementTarget | undefined) =>
        candidate === target && this.enabled(target),
      principal: snapshot,
      readOnly,
      accountsManage: !readOnly && this.managesAccounts(snapshot),
      recordAccountAction: (entry: unknown) => this.recordAccountAction(id, pluginId, entry),
      invoke: (callId: string, command: unknown) => this.invoke(id, pluginId, callId, command),
      close: () => this.revoke(id),
    });
  }
  async invoke(id: string, pluginId: string, callId: string, input: unknown): Promise<JsonValue> {
    const invocation = this.check(id, pluginId);
    if (
      !callId ||
      callId.length > 64 ||
      invocation.calls.has(callId) ||
      invocation.calls.size >= 32
    )
      throw new Error("Management call replay or limit");
    invocation.calls.add(callId);
    const command = this.command(input);
    // The distribution supplies the existing controller method/input parser. Never dispatch without it.
    const validated = this.command(this.config!.validate(command));
    if (invocation.readOnly && this.config?.isRead?.(validated) !== true)
      throw new Error("This device can only read Command Centre");
    const capability = randomUUID();
    this.capabilities.set(capability, {
      invocation: id,
      digest: this.digest(validated),
    });
    return this.consume(capability, id, pluginId, validated);
  }
  private consume(
    capability: string,
    id: string,
    pluginId: string,
    command: ControllerManagementCommandV11,
  ): Promise<JsonValue> {
    const binding = this.capabilities.get(capability);
    this.capabilities.delete(capability);
    if (!binding || binding.invocation !== id || binding.digest !== this.digest(command))
      throw new Error("Invalid management capability");
    const invocation = this.check(id, pluginId);
    // No await between the final authority check, one-use consume, and protected bridge dispatch.
    const principal = this.snapshot(invocation.reader()!);
    if (command.method === "session-takeover" && !this.managesAccounts(principal))
      throw new Error("This device may not manage accounts");
    const ownerHandler = this.ownerHandlers.get(command.method);
    if (ownerHandler) {
      const requireOwner = () => {
        const live = this.check(id, pluginId);
        const current = this.snapshot(live.reader()!);
        if (
          live.readOnly ||
          !this.isOwner(current) ||
          canonicalJson(current) !== canonicalJson(principal)
        )
          throw new Error("Fresh owner authority required");
      };
      requireOwner();
      return ownerHandler(command, Object.freeze({ ownerId: principal.id, requireOwner }));
    }
    // An owner-only method is never allowed to fall through to a generic controller bridge.
    if (
      [
        "report-prime-register",
        "report-prime-promote",
        "report-prime-demote",
        "report-project-transfer",
        "report-parent-adopt",
        "report-registration-revoke",
        "intercom-rate-settings-set",
        "intercom-rate-settings-get",
        "intercom-status",
        "report-inbox-owner-read",
        "evidence-index-owner-read",
        "artifact-tool-owner-set",
        "artifact-content-owner-set",
        "artifact-content-owner-list",
        "artifact-content-owner-read",
        "managed-artifact-index-owner-read",
        "intercom-receipt-maintenance",
        "radius-scratch-simulate",
        "radius-scratch-prune-and-simulate",
      ].includes(command.method)
    )
      throw new Error("Native owner-only handler unavailable");
    const input = command.input;
    const handoff =
      command.method === "leadership-transfer" &&
      isJsonObject(input) &&
      typeof input.sessionId === "string" &&
      typeof input.messageId === "string"
        ? this.handoffObserver?.(input.sessionId, input.messageId)
        : undefined;
    let consumed = false;
    const completion = dispatchScope.run(
      (actualCommand, actualPrincipal) => {
        const live = this.check(id, pluginId);
        const currentPrincipal = this.snapshot(live.reader()!);
        if (
          consumed ||
          this.digest(actualCommand) !== binding.digest ||
          canonicalJson(actualPrincipal) !== canonicalJson(principal) ||
          canonicalJson(actualPrincipal) !== canonicalJson(currentPrincipal)
        )
          throw new Error("Invalid management write capability");
        if (actualCommand.method === "session-takeover" && !this.managesAccounts(currentPrincipal))
          throw new Error("This device may not manage accounts");
        consumed = true;
      },
      () => invocation.bridge(command, principal),
    );
    return completion.then((result) => {
      // Only the actual consumed bridge's successful durable transfer is a host lifecycle fact.
      if (
        consumed &&
        handoff &&
        isJsonObject(result) &&
        result.ownershipTransferred === true &&
        isJsonObject(input) &&
        result.handoffId === input.messageId
      ) {
        try {
          handoff();
        } catch {
          /* A report refusal cannot undo the completed transfer fact. */
        }
      }
      return result;
    });
  }
  private check(id: string, pluginId: string): Invocation {
    const invocation = this.invocations.get(id);
    const principal = invocation?.reader();
    if (
      this.stopped ||
      !invocation ||
      invocation.pluginId !== pluginId ||
      invocation.bridge !== this.bridge ||
      !this.enabled(invocation.target) ||
      Date.now() >= invocation.expires ||
      !principal ||
      !(invocation.readOnly ? this.readAuthorised(principal) : this.authorised(principal)) ||
      principal.id !== invocation.principal.id ||
      principal.authentication !== invocation.principal.authentication ||
      principal.deviceId !== invocation.principal.deviceId
    ) {
      this.revoke(id);
      throw new Error("Management unavailable or unauthorised");
    }
    return invocation;
  }
  /**
   * U7: whether the principal may manage accounts. It holds accounts.manage as well as full management: this Mac's
   * owner holds it; a paired device only by the owner's explicit grant (the registry and relay gate add it).
   */
  private managesAccounts(principal: ManagementPrincipalV11): boolean {
    return this.authorised(principal) && principal.permissions.includes("accounts.manage");
  }
  /**
   * U7: records a remote account action for the owner. The invocation must still be live and its principal must hold
   * account management NOW (a revoked grant is refused mid-invocation). The plugin gives only the action and the
   * account label; the device and time come from here. This Mac's owner's own actions are not recorded.
   */
  async recordAccountAction(
    id: string,
    pluginId: string,
    entry: unknown,
  ): Promise<{ recorded: boolean }> {
    const invocation = this.check(id, pluginId);
    const principal = invocation.reader();
    if (invocation.readOnly || !principal || !this.managesAccounts(principal))
      throw new Error("This device may not manage accounts");
    const parsed = AccountActionInputSchema.safeParse(entry);
    if (!parsed.success) throw new Error("Invalid account action");
    if (principal.authentication !== "paired-device" || !principal.deviceId)
      return { recorded: false };
    if (!this.accountActions) throw new Error("The account audit is unavailable on this host");
    this.accountActions.record({
      at: new Date().toISOString(),
      deviceId: principal.deviceId,
      action: parsed.data.action,
      accountLabel: parsed.data.accountLabel,
    });
    return { recorded: true };
  }
  /** D13: a paired device holding the read tier (daemon.read + workspace.read), with a read classifier to check against. */
  private readAuthorised(
    principal: ManagementPrincipalV11 | undefined,
  ): principal is ManagementPrincipalV11 {
    return (
      !!principal &&
      !!principal.id &&
      principal.authentication === "paired-device" &&
      !!principal.deviceId &&
      principal.permissions.includes("daemon.read") &&
      principal.permissions.includes("workspace.read") &&
      typeof this.config?.isRead === "function"
    );
  }
  private authorised(
    principal: ManagementPrincipalV11 | undefined,
  ): principal is ManagementPrincipalV11 {
    return (
      !!principal &&
      !!principal.id &&
      ["daemon-password", "paired-device", "protected-local-ipc"].includes(
        principal.authentication,
      ) &&
      (principal.authentication !== "paired-device" || !!principal.deviceId) &&
      principal.permissions.includes("command-centre.manage") &&
      principal.permissions.includes("daemon.manage")
    );
  }
  private snapshot(principal: ManagementPrincipalV11): ManagementPrincipalV11 {
    return Object.freeze({
      ...principal,
      permissions: Object.freeze([...principal.permissions]),
    });
  }
  private command(value: unknown): ControllerManagementCommandV11 {
    const bytes = canonicalJson(boundedJson(value));
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error("Management command too large");
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).sort().join() !== "input,method" ||
      typeof Reflect.get(value, "method") !== "string" ||
      !Reflect.get(value, "method")
    )
      throw new Error("Invalid management command");
    return JSON.parse(bytes) as ControllerManagementCommandV11;
  }
  private digest(command: ControllerManagementCommandV11): string {
    return createHash("sha256")
      .update(canonicalJson(command as unknown as JsonValue))
      .digest("hex");
  }
  private revoke(id: string): void {
    this.invocations.delete(id);
    for (const [token, binding] of this.capabilities)
      if (binding.invocation === id) this.capabilities.delete(token);
  }
  close(): void {
    this.stopped = true;
    this.invocations.clear();
    this.capabilities.clear();
    this.bridge = undefined;
  }
}
