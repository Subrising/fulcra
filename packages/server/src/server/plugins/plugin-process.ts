import { createManagementContext } from "./plugin-management-context.js";
import { untrustedHostHooks } from "./trusted.js";
import { PluginHookHandlers } from "./lifecycle/index.js";
import { evaluateBundle } from "./bundle-evaluator.js";
import {
  PluginProcessRequestSchema,
  type PluginHostCallMethod,
  type PluginProcessMessage,
  type PluginProcessRequest,
} from "./plugin-process-protocol.js";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import type { SettingsDefinition, PluginRpcContract } from "@getpaseo/plugin";
import type {
  PluginCredentials,
  PluginHandlerContext,
  PluginNotifyInput,
  PluginNotifyResult,
  PluginServerContribution,
} from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";
import {
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderRegistration,
  ProviderStatusSchema,
} from "@getpaseo/plugin/server/provider";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPluginDaemonTransportFactory } from "./daemon-transport.js";
import { createPluginClientId } from "./plugin-session-identity.js";

import { PluginSettingsStore } from "./settings/index.js";
import { readPluginProviderIcon } from "./provider-icon.js";
import {
  createPluginSecretStore,
  guardPluginOutput,
  redactPluginError,
  type PluginSecretStore,
} from "./plugin-secrets.js";
function describeError(error: unknown, secretStore: PluginSecretStore | null = null): string {
  return redactPluginError(secretStore, error instanceof Error ? error.message : String(error));
}

export interface PluginWorkerChannel {
  send(message: PluginProcessMessage, callback?: () => void): void;
  onMessage(handler: (message: PluginProcessRequest) => void): () => void;
  disconnect(): void;
}

export function createPluginWorker(options: {
  channel: PluginWorkerChannel;
  contribute: PluginServerContribution;
}): { shutdown(): Promise<void> } {
  const { channel, contribute } = options;
  let settingsStore: PluginSettingsStore | null = null;
  // FULCRA(plugin-secrets): the namespace comes from the host's initialize message, never from plugin code.
  let secretStore: PluginSecretStore | null = null;
  let hostCapabilities = { notify: false, credentials: false };
  const redact = (error: unknown) => describeError(error, secretStore);
  function registerSettings<Schema extends ZodType>(definition: SettingsDefinition<Schema>) {
    if (!settingsStore) throw new Error("Plugin settings storage is unavailable");
    const handlers = settingsStore.register(definition);
    register(handlers.read.contract, handlers.read.handle);
    register(handlers.write.contract, (input) =>
      handlers.write.handle(handlers.write.contract.input.parse(input)),
    );
    register(handlers.reset.contract, (input) =>
      handlers.reset.handle(handlers.reset.contract.input.parse(input)),
    );
    return handlers.settings;
  }

  type RpcHandler = (input: unknown, context: PluginHandlerContext) => unknown | Promise<unknown>;

  interface RegisteredRpc {
    contract: PluginRpcContract;
    handler: RpcHandler;
    readOnly: boolean;
  }

  const hooks = new PluginHookHandlers(() => {
    send({ type: "hooks.changed", hooks: hooks.catalog() });
  });
  const handlers = new Map<string, RegisteredRpc>();
  const providers = new Map<string, ProviderRegistration>();
  const usageSources = new Map<string, UsageSourceRegistration>();
  const providerConnections = new Map<
    string,
    { connection: ProviderConnection; unsubscribe: () => void; closing?: Promise<void> }
  >();
  const pendingProviderConnections = new Map<string, { tombstoned: boolean }>();
  let cleanup: (() => void | Promise<void>) | null = null;
  let daemonClient: DaemonClient | null = null;
  let paseo: PaseoApi | null = null;
  let stopping = false;
  const pendingHostCalls = new Map<
    string,
    { resolve: (output: unknown) => void; reject: (error: Error) => void }
  >();
  let nextHostCallId = 0;
  function send(message: PluginProcessMessage): void {
    channel.send(message);
  }

  // FULCRA(plugin-secrets): plugin code reaches host capabilities only through the daemon, which checks the manifest.
  function hostCall(method: PluginHostCallMethod, input: unknown): Promise<unknown> {
    if (stopping) return Promise.reject(new Error("Plugin is stopping"));
    nextHostCallId += 1;
    const callId = `host-${nextHostCallId}`;
    return new Promise((resolve, reject) => {
      pendingHostCalls.set(callId, { resolve, reject });
      send({ type: "host.call", callId, method, input });
    });
  }

  function settleHostCall(
    message: Extract<PluginProcessRequest, { type: "host.result" | "host.error" }>,
  ): void {
    const pending = pendingHostCalls.get(message.callId);
    if (!pending) return;
    pendingHostCalls.delete(message.callId);
    if (message.type === "host.result") pending.resolve(message.output);
    else pending.reject(Object.assign(new Error(message.error), { code: message.code }));
  }

  async function notify(input: PluginNotifyInput): Promise<PluginNotifyResult> {
    const output = (await hostCall("notify", input)) as PluginNotifyResult;
    return { id: output.id, duplicate: output.duplicate };
  }

  // Provider requests run in the daemon, which attaches the credential; the plugin process never
  // holds a secret.
  const credentials: PluginCredentials = {
    async request(accountId, connectorId, request) {
      const output = (await hostCall("credentials.request", {
        accountId,
        connector: connectorId,
        request,
      })) as { status: number; headers: Record<string, string>; body: unknown };
      return { status: output.status, headers: output.headers, body: output.body };
    },
    async importLegacy(input) {
      const output = (await hostCall("credentials.import_legacy", input)) as {
        accountId: string;
        imported: boolean;
      };
      return { accountId: output.accountId, imported: output.imported };
    },
  };

  function sendAndWait(message: PluginProcessMessage): Promise<void> {
    return new Promise((resolve) => {
      channel.send(message, () => resolve());
    });
  }

  function jsonTransportValue<Value>(value: Value): Value {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Provider value is not JSON-serializable");
    return JSON.parse(encoded) as Value;
  }

  function validateMethod(method: string): string {
    const normalized = method.trim();
    if (!/^[a-z][a-z0-9._-]*$/.test(normalized)) {
      throw new Error(`Invalid plugin RPC method: ${method}`);
    }
    if (handlers.has(normalized)) {
      throw new Error(`Duplicate plugin RPC method: ${normalized}`);
    }
    return normalized;
  }

  function register(
    contract: PluginRpcContract,
    handler: RpcHandler,
    rpcOptions?: { readOnly?: boolean },
  ): void {
    if (typeof handler !== "function") {
      throw new Error(`Plugin RPC ${contract.name} must provide a handler`);
    }
    const method = validateMethod(contract.name);
    handlers.set(method, {
      contract: { ...contract, name: method },
      handler,
      readOnly: rpcOptions?.readOnly === true,
    });
  }

  function registerProvider(provider: ProviderRegistration): void {
    const id = provider.id.trim();
    if (!/^[a-z][a-z0-9._-]*$/.test(id)) {
      throw new Error(`Invalid plugin provider ID: ${provider.id}`);
    }
    if (!provider.label.trim()) throw new Error(`Plugin provider ${id} requires a label`);
    if (typeof provider.connect !== "function") {
      throw new Error(`Plugin provider ${id} must implement connect()`);
    }
    if (
      provider.getCatalogCacheKey !== undefined &&
      typeof provider.getCatalogCacheKey !== "function"
    ) {
      throw new Error(`Invalid catalogue key callback for plugin provider ${id}`);
    }
    if (provider.status !== undefined && typeof provider.status !== "function")
      throw new Error(`Invalid status callback for plugin provider ${id}`);
    if (
      provider.command !== undefined &&
      (provider.command.length === 0 ||
        provider.command.some((part) => typeof part !== "string" || !part.trim()))
    )
      throw new Error(`Invalid command for plugin provider ${id}`);
    if (providers.has(id)) throw new Error(`Duplicate plugin provider ID: ${id}`);
    providers.set(id, { ...provider, id });
  }

  function registerUsageSource(source: UsageSourceRegistration): void {
    const id = source.id.trim();
    if (
      !/^[a-z][a-z0-9._-]*$/.test(id) ||
      !source.label.trim() ||
      typeof source.fetch !== "function" ||
      typeof source.discover !== "function" ||
      !source.input ||
      typeof source.input.parseAsync !== "function"
    ) {
      throw new Error(`Invalid usage source: ${source.id}`);
    }
    if (usageSources.has(id)) throw new Error(`Duplicate usage source: ${id}`);
    usageSources.set(id, { ...source, id });
  }

  function providerMetadata(provider: ProviderRegistration) {
    return {
      id: provider.id,
      label: provider.label,
      description: provider.description,
      iconPath: provider.icon,
      hasCatalogCacheKey: provider.getCatalogCacheKey !== undefined,
      hasStatus: provider.status !== undefined,
      command: provider.command,
    };
  }

  async function connectProvider(
    message: Extract<PluginProcessRequest, { type: "provider.connect" }>,
  ): Promise<void> {
    if (stopping) throw new Error("Plugin is stopping");
    const provider = providers.get(message.providerId);
    if (!provider) throw new Error(`Unknown plugin provider: ${message.providerId}`);
    if (
      providerConnections.has(message.connectionId) ||
      pendingProviderConnections.has(message.connectionId)
    ) {
      throw new Error(`Duplicate provider connection: ${message.connectionId}`);
    }
    const pending = { tombstoned: false };
    pendingProviderConnections.set(message.connectionId, pending);
    let connection: ProviderConnection;
    try {
      connection = await provider.connect(message.request);
    } catch (error) {
      pendingProviderConnections.delete(message.connectionId);
      if (pending.tombstoned || stopping) return;
      throw error;
    }
    pendingProviderConnections.delete(message.connectionId);
    if (pending.tombstoned || stopping) {
      await connection.close().catch(() => undefined);
      return;
    }
    let unsubscribe = () => {};
    unsubscribe = connection.onEvent((event) => {
      try {
        send({
          type: "provider.event",
          connectionId: message.connectionId,
          event: ProviderEventSchema.parse(jsonTransportValue(event)),
        });
      } catch (error) {
        providerConnections.delete(message.connectionId);
        unsubscribe();
        void connection.close().catch(() => undefined);
        send({
          type: "provider.closed",
          connectionId: message.connectionId,
          error: redact(error),
        });
      }
    });
    providerConnections.set(message.connectionId, { connection, unsubscribe });
    send({
      type: "provider.connected",
      connectionId: message.connectionId,
      version: connection.version,
      capabilities: connection.capabilities,
    });
  }

  async function sendProviderInput(
    message: Extract<PluginProcessRequest, { type: "provider.send" }>,
  ): Promise<void> {
    if (stopping) throw new Error("Plugin is stopping");
    const current = providerConnections.get(message.connectionId);
    if (!current) throw new Error(`Unknown provider connection: ${message.connectionId}`);
    if (current.closing) throw new Error("Provider connection is closing");
    await current.connection.send(message.input);
    send({
      type: "provider.accepted",
      connectionId: message.connectionId,
      acceptanceId: message.acceptanceId,
    });
  }

  // The connection stays registered until its close has reported, so shutdown
  // waits for a close already in flight instead of disconnecting underneath it.
  async function closeProviderConnection(connectionId: string): Promise<void> {
    const current = providerConnections.get(connectionId);
    if (!current) return;
    if (current.closing) return current.closing;
    const closing = (async () => {
      current.unsubscribe();
      try {
        await current.connection.close();
        send({ type: "provider.closed", connectionId });
      } catch (error) {
        send({ type: "provider.closed", connectionId, error: redact(error) });
      } finally {
        providerConnections.delete(connectionId);
      }
    })();
    current.closing = closing;
    return closing;
  }

  const transportFactory = createPluginDaemonTransportFactory({
    send,
    onMessage(handler) {
      return channel.onMessage(handler);
    },
  });

  async function initialize(message: Extract<PluginProcessRequest, { type: "initialize" }>) {
    daemonClient = new DaemonClient({
      url: `ipc://plugin/${encodeURIComponent(message.pluginId)}`,
      clientId: createPluginClientId(message.pluginId),
      clientType: "cli",
      appVersion: message.appVersion,
      // The runtime re-attaches a session when the daemon drops this socket.
      reconnect: { enabled: true },
      transportFactory,
    });
    paseo = createPaseoApi(daemonClient);
    await daemonClient.connect();
    settingsStore = message.settingsDirectory
      ? new PluginSettingsStore(message.settingsDirectory, (settingsId) =>
          send({ type: "settings.changed", settingsId }),
        )
      : null;
    secretStore = createPluginSecretStore({ pluginId: message.pluginId });
    hostCapabilities = message.capabilities ?? { notify: false, credentials: false };
    const contributedCleanup = contribute({
      ...untrustedHostHooks,
      handle: (contract, handler, rpcOptions?: { readOnly?: boolean }) =>
        register(
          contract,
          (input, context) => handler(contract.input.parse(input), context),
          rpcOptions,
        ),
      secrets: secretStore?.secrets,
      ...(hostCapabilities.notify ? { notify } : {}),
      ...(hostCapabilities.credentials ? { credentials } : {}),
      registerProvider,
      registerUsageSource,
      registerSettings,
      on: hooks.on,
      before: hooks.before,
    });
    if (typeof contributedCleanup !== "function") {
      throw new Error("Plugin contribution must return a cleanup function");
    }
    cleanup = contributedCleanup;
    const usageSourceMetadata = await Promise.all(
      [...usageSources.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(async (source) => ({
          id: source.id,
          label: source.label,
          icon: source.icon
            ? await readPluginProviderIcon(message.pluginDirectory, source.icon)
            : undefined,
        })),
    );
    send({
      type: "ready",
      methods: [...handlers.keys()].sort(),
      readMethods: [...handlers]
        .filter(([, registered]) => registered.readOnly)
        .map(([method]) => method)
        .sort(),
      hooks: hooks.catalog(),
      providers: [...providers.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(providerMetadata),
      usageSources: usageSourceMetadata,
    });
  }

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    const releaseApi = paseo
      ?.dispose()
      .catch((error) => console.error("Plugin API cleanup failed", error));
    hooks.close();
    for (const pending of pendingProviderConnections.values()) pending.tombstoned = true;
    for (const pending of pendingHostCalls.values())
      pending.reject(new Error("Plugin is stopping"));
    pendingHostCalls.clear();
    const currentCleanup = cleanup;
    cleanup = null;
    try {
      await currentCleanup?.();
    } catch (error) {
      console.error("Plugin cleanup failed", error);
    }
    await Promise.all([...providerConnections.keys()].map(closeProviderConnection));
    await releaseApi;
    await daemonClient?.close().catch(() => undefined);
    await sendAndWait({ type: "paseo_close" });
    daemonClient = null;
    paseo = null;
    channel.disconnect();
  }

  function handleUsageRequest(
    message: Extract<PluginProcessRequest, { type: "usage.fetch" | "usage.discover" }>,
  ): void {
    void (async () => {
      const source = usageSources.get(message.sourceId);
      if (!source) throw new Error(`Unknown usage source: ${message.sourceId}`);
      if (message.type === "usage.discover")
        return jsonTransportValue(await source.discover(message.scope));
      const input = await source.input.parseAsync(message.input);
      return jsonTransportValue(await source.fetch(input));
    })().then(
      (output) => send({ type: "result", requestId: message.requestId, output }),
      (error) => send({ type: "error", requestId: message.requestId, error: redact(error) }),
    );
  }

  function rejectWhileStopping(message: PluginProcessRequest): void {
    if (
      message.type === "provider.status" ||
      message.type === "provider.catalog_key" ||
      message.type === "usage.fetch" ||
      message.type === "usage.discover"
    ) {
      send({ type: "error", requestId: message.requestId, error: "Plugin is stopping" });
    } else if (message.type === "provider.connect") {
      send({
        type: "provider.connect_failed",
        connectionId: message.connectionId,
        error: "Plugin is stopping",
      });
    } else if (message.type === "provider.send") {
      send({
        type: "provider.rejected",
        connectionId: message.connectionId,
        acceptanceId: message.acceptanceId,
        error: "Plugin is stopping",
      });
    } else if (message.type === "provider.close") {
      send({ type: "provider.closed", connectionId: message.connectionId });
    }
  }

  // oxlint-disable-next-line complexity -- FULCRA: upstream body plus the named core patch seams; split on the next upstream merge.
  function handleMessage(rawMessage: unknown): void {
    const parsed = PluginProcessRequestSchema.safeParse(rawMessage);
    if (!parsed.success) {
      const value = rawMessage as { connectionId?: unknown; acceptanceId?: unknown } | null;
      if (
        value &&
        typeof value.connectionId === "string" &&
        typeof value.acceptanceId === "string"
      ) {
        send({
          type: "provider.rejected",
          connectionId: value.connectionId,
          acceptanceId: value.acceptanceId,
          error: `Invalid provider input: ${parsed.error.message}`,
        });
        void closeProviderConnection(value.connectionId);
        return;
      }
      send({ type: "fatal", error: `Invalid plugin process request: ${parsed.error.message}` });
      void shutdown();
      return;
    }
    const message = parsed.data;
    if (message.type === "initialize") {
      void initialize(message).catch(async (error) => {
        send({ type: "fatal", error: redact(error) });
        await paseo
          ?.dispose()
          .catch((failure) => console.error("Plugin API cleanup failed", failure));
        await daemonClient?.close().catch(() => undefined);
      });
      return;
    }
    if (message.type === "shutdown") {
      void shutdown();
      return;
    }
    if (message.type === "host.result" || message.type === "host.error") {
      settleHostCall(message);
      return;
    }
    if (stopping) {
      rejectWhileStopping(message);
      return;
    }
    if (message.type === "provider.status") {
      void (async () => {
        const provider = providers.get(message.providerId);
        if (!provider || !provider.status)
          throw new Error(`Provider has no status capability: ${message.providerId}`);
        const output = ProviderStatusSchema.parse(await provider.status(message.request));
        send({ type: "result", requestId: message.requestId, output });
      })().catch((error) =>
        send({ type: "error", requestId: message.requestId, error: redact(error) }),
      );
      return;
    }
    if (message.type === "provider.catalog_key") {
      void (async () => {
        const provider = providers.get(message.providerId);
        if (!provider) throw new Error(`Unknown provider: ${message.providerId}`);
        const output = await provider.getCatalogCacheKey?.(message.options);
        if (output !== undefined && typeof output !== "string")
          throw new Error("Invalid catalogue key");
        send({ type: "result", requestId: message.requestId, output });
      })().catch((error) =>
        send({ type: "error", requestId: message.requestId, error: redact(error) }),
      );
      return;
    }
    if (message.type === "usage.fetch" || message.type === "usage.discover") {
      handleUsageRequest(message);
      return;
    }
    if (message.type === "provider.connect") {
      void connectProvider(message).catch((error) => {
        if (stopping) return;
        send({
          type: "provider.connect_failed",
          connectionId: message.connectionId,
          error: redact(error),
        });
      });
      return;
    }
    if (message.type === "provider.send") {
      void sendProviderInput(message).catch((error) => {
        if (stopping) return;
        send({
          type: "provider.rejected",
          connectionId: message.connectionId,
          acceptanceId: message.acceptanceId,
          error: redact(error),
        });
      });
      return;
    }
    if (message.type === "provider.close") {
      void closeProviderConnection(message.connectionId);
      return;
    }
    if (message.type === "paseo_frame" || message.type === "paseo_close") return;
    if (isHookMessage(message)) {
      handleHookMessage(message);
      return;
    }
    const registered = handlers.get(message.method);
    if (!registered) {
      send({
        type: "error",
        requestId: message.requestId,
        error: `Unknown RPC method: ${message.method}`,
      });
      return;
    }
    // FULCRA(orchestration): management invocations carry a host-issued principal and audit route.
    const management = message.management
      ? createManagementContext(
          message.management,
          (callId, invocationId, command) => {
            if (stopping) return Promise.reject(new Error("Plugin is stopping"));
            return new Promise((resolve, reject) => {
              pendingHostCalls.set(callId, { resolve, reject });
              try {
                send({ type: "management.invoke", callId, invocationId, command });
              } catch (error) {
                pendingHostCalls.delete(callId);
                reject(error);
              }
            });
          },
          // U7: an account action is audited by the host against this invocation.
          (invocationId, entry) => {
            if (stopping) return Promise.reject(new Error("Plugin is stopping"));
            const callId = randomUUID();
            return new Promise((resolve, reject) => {
              pendingHostCalls.set(callId, { resolve, reject });
              try {
                send({ type: "management.audit", callId, invocationId, entry });
              } catch (error) {
                pendingHostCalls.delete(callId);
                reject(error);
              }
            });
          },
        )
      : undefined;
    void registered.contract.input
      .parseAsync(message.input)
      .then((input) => {
        if (!paseo) throw new Error("Plugin host API is unavailable");
        return registered.handler(input, {
          paseo,
          ...(management ? { management: management.context } : {}),
        });
      })
      .finally(() => management?.close())
      .then((output) => registered.contract.output.parseAsync(output))
      .then((output) => guardPluginOutput(secretStore, output))
      .then(
        (output) => send({ type: "result", requestId: message.requestId, output }),
        (error) => send({ type: "error", requestId: message.requestId, error: redact(error) }),
      );
  }
  channel.onMessage(handleMessage);

  function handleHookMessage(
    message: Extract<PluginProcessRequest, { type: "hook" | "hook.cancel" }>,
  ): void {
    if (message.type === "hook.cancel") {
      hooks.cancel(message.requestId);
      return;
    }
    if (message.type === "hook") {
      if (!paseo) {
        send({
          type: "error",
          requestId: message.requestId,
          error: "Plugin host API is unavailable",
        });
        return;
      }
      void hooks.invoke(message.requestId, message.kind, message.name, message.input, paseo).then(
        (output) => {
          try {
            return send({
              type: "result",
              requestId: message.requestId,
              output: guardPluginOutput(secretStore, output),
            });
          } catch (error) {
            return send({ type: "error", requestId: message.requestId, error: redact(error) });
          }
        },
        (error) => {
          return send({ type: "error", requestId: message.requestId, error: redact(error) });
        },
      );
      return;
    }
  }

  function isHookMessage(
    message: PluginProcessRequest,
  ): message is Extract<PluginProcessRequest, { type: "hook" | "hook.cancel" }> {
    return message.type === "hook" || message.type === "hook.cancel";
  }
  return { shutdown };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let worker: ReturnType<typeof createPluginWorker> | null = null;
  const handlers = new Set<(message: PluginProcessRequest) => void>();
  const channel: PluginWorkerChannel = {
    send(message, callback) {
      if (callback) process.send?.(message, () => callback());
      else process.send?.(message);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    disconnect() {
      process.disconnect();
    },
  };
  process.on("message", (raw) => {
    const parsed = PluginProcessRequestSchema.safeParse(raw);
    if (!worker && parsed.success && parsed.data.type === "initialize") {
      try {
        worker = createPluginWorker({ channel, contribute: evaluateBundle(parsed.data.bundle) });
      } catch (error) {
        channel.send({ type: "fatal", error: describeError(error) });
        return;
      }
    }
    if (worker) for (const handler of handlers) handler(raw as PluginProcessRequest);
  });
}
