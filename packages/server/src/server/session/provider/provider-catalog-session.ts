import { sanitizeAccountMetadata } from "../../../services/quota-fetcher/account-usage-sanitize.js";
import { safeAccountName } from "../../../services/quota-fetcher/account-usage-sanitize.js";
import type { ProviderUsage } from "../../messages.js";
import type pino from "pino";
import { createHash } from "node:crypto";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import { compactProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  isGlobalProviderSnapshotKey,
  resolveSnapshotCwd,
  sameSnapshotRecords,
  type ProviderSnapshotManager,
  type ProviderSnapshot,
  type ProviderSnapshotTransition,
} from "../../agent/provider-snapshot-manager.js";
import {
  filterSelectableAgentModels,
  type AgentFeature,
  type AgentProvider,
  type AgentSessionConfig,
  type ProviderSnapshotEntry,
} from "../../agent/agent-sdk-types.js";
import type { ProviderAvailability } from "../../agent/agent-manager.js";
import type { ProviderUsageService } from "../../../services/quota-fetcher/service.js";
import type { AccountUsageRegistry } from "../../../services/quota-fetcher/account-usage-registry.js";
import {
  providerUsageFromAccountRow,
  unavailableAccountEntry,
} from "../../../services/quota-fetcher/account-usage-entry.js";
import type {
  AccountCredential,
  AccountProvider,
  PooledAccount,
} from "../../../services/quota-fetcher/account-usage-types.js";
import { expandTilde } from "../../../utils/path.js";

// COMPAT(customModeIcons): the only mode icons known to clients before v0.1.84. Any
// other icon name is downgraded to "ShieldCheck" for those clients.
const LEGACY_MODE_ICONS = new Set<string>([
  "ShieldCheck",
  "ShieldAlert",
  "ShieldOff",
  "ShieldQuestionMark",
]);

/**
 * The collaborators a provider-catalog request reaches that are NOT part of the
 * provider domain. Two are CLIENT-COMPAT predicates the Session shell owns because
 * agent-lifecycle shares the visibility gate: both read client state (appVersion /
 * capabilities) LIVE, mutated post-construction via updateAppVersion /
 * updateClientCapabilities. The two agent-control reads expose provider availability
 * and draft features the AgentManager owns.
 */
export interface ProviderCatalogSessionHost {
  emit(msg: SessionOutboundMessage): void;
  // COMPAT(providersSnapshot): visibility gating for older clients lives on the shell
  // (agent-lifecycle shares it). Reads appVersion live.
  isProviderVisibleToClient(provider: string): boolean;
  // COMPAT(customModeIcons): reads clientCapabilities live.
  supportsCustomModeIcons(): boolean;
  supportsCompactProviderSnapshots(): boolean;
  supportsProviderSnapshotReferences(): boolean;
  publishSnapshot(project: () => SessionOutboundMessage | null): void;
  listProviderAvailability(): Promise<ProviderAvailability[]>;
  listDraftFeatures(config: AgentSessionConfig): Promise<AgentFeature[]>;
}

export interface ProviderCatalogSessionOptions {
  host: ProviderCatalogSessionHost;
  providerSnapshotManager: ProviderSnapshotManager;
  /** FULCRA(accounts): legacy provider usage list, until account usage moves to a usage source. */
  providerUsageService: ProviderUsageService;
  logger: pino.Logger;
  /** Native quota from the running account, without credential-file access. */
  sessionUsage?: (agentId: string) => Promise<ProviderUsage | null>;
  /** Fulcra account pool: the launch credential of a session this client can see (daemon-internal), or null. */
  usageCredential?: (agentId: string) => {
    provider: string;
    credential: AccountCredential;
    label: string | null;
    accountId?: string | null;
    isCurrent?: () => boolean;
  } | null;
  /** update-7c: the per-account usage cache/scheduler (Claude and Codex pooled accounts). */
  accountUsage?: AccountUsageRegistry;
}

/**
 * A client's provider catalog surface: model / mode / feature listing, the providers
 * snapshot push + pull, and provider diagnostics. The snapshot PUSH (start) and
 * every PULL handler gate visibility and downgrade mode icons through the SAME predicates,
 * so an older client sees one consistent provider set across both paths — the COMPAT
 * invariant the shell could only enforce by code proximity before this carve.
 */
export class ProviderCatalogSession {
  private readonly host: ProviderCatalogSessionHost;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly providerUsageService: ProviderUsageService;
  private readonly logger: pino.Logger;
  private readonly sessionUsage: ProviderCatalogSessionOptions["sessionUsage"];
  private readonly usageCredential: ProviderCatalogSessionOptions["usageCredential"];
  private readonly accountUsage: AccountUsageRegistry | undefined;
  private unsubscribeSnapshotEvents: (() => void) | null = null;

  constructor(options: ProviderCatalogSessionOptions) {
    this.host = options.host;
    this.providerSnapshotManager = options.providerSnapshotManager;
    this.providerUsageService = options.providerUsageService;
    this.logger = options.logger;
    this.usageCredential = options.usageCredential;
    this.sessionUsage = options.sessionUsage;
    this.accountUsage = options.accountUsage;
  }

  get isObserving(): boolean {
    return this.unsubscribeSnapshotEvents !== null;
  }

  start(): void {
    if (this.unsubscribeSnapshotEvents) return;
    const handleProviderSnapshotChange = (transition: ProviderSnapshotTransition) => {
      this.host.publishSnapshot(() => {
        const previous = this.visibleSnapshot(transition.previous);
        const current = this.visibleSnapshot(transition.current);
        if (sameSnapshotRecords(previous.records, current.records)) return null;
        return { type: "providers_snapshot_update", payload: this.snapshotPayload(current) };
      });
    };
    this.providerSnapshotManager.on("change", handleProviderSnapshotChange);
    this.unsubscribeSnapshotEvents = () => {
      this.providerSnapshotManager.off("change", handleProviderSnapshotChange);
    };
  }

  dispose(): void {
    if (this.unsubscribeSnapshotEvents) {
      this.unsubscribeSnapshotEvents();
      this.unsubscribeSnapshotEvents = null;
    }
  }

  // COMPAT(customModeIcons): rewrite icons unknown to v0.1.83 clients (whose MODE_ICONS
  // map is a closed enum and would render `undefined`, crashing in render). Drop
  // this and the cap gate when floor >= v0.1.84.
  private downgradeModeIconsForClient<T extends { icon?: string }>(
    modes: T[],
    customModeIcons = this.host.supportsCustomModeIcons(),
  ): T[] {
    if (customModeIcons) return modes;
    return modes.map((mode) =>
      mode.icon && !LEGACY_MODE_ICONS.has(mode.icon) ? { ...mode, icon: "ShieldCheck" } : mode,
    );
  }

  private visibleSnapshot(snapshot: ProviderSnapshot): ProviderSnapshot {
    // COMPAT(providersSnapshot): use the shell's current visibility policy for both sides.
    return {
      ...snapshot,
      records: snapshot.records.filter(({ entry }) =>
        this.host.isProviderVisibleToClient(entry.provider),
      ),
    };
  }

  private snapshotPayload(snapshot: ProviderSnapshot, request?: { ifNoneMatch?: string }) {
    const { records } = snapshot;
    const customModeIcons = this.host.supportsCustomModeIcons();
    const compact = this.host.supportsCompactProviderSnapshots();
    const references = this.host.supportsProviderSnapshotReferences();
    const envelope = {
      ...(!isGlobalProviderSnapshotKey(snapshot.cwd) ? { cwd: snapshot.cwd } : {}),
      generatedAt: new Date().toISOString(),
    };
    const clientEntries = () =>
      records.map(({ entry }) =>
        entry.modes && !customModeIcons
          ? { ...entry, modes: this.downgradeModeIconsForClient(entry.modes, customModeIcons) }
          : entry,
      );
    if (!compact) {
      return { ...envelope, entries: clientEntries() };
    }

    // COMPAT(providerSnapshotReferences): added in v0.7.2, remove legacy full
    // pushes and embedded freshness after 2027-03-06 once the client floor supports references.
    const snapshotHash = createHash("sha256")
      .update(
        JSON.stringify([
          "paseo.providers-snapshot/1",
          references ? "references" : "embedded",
          customModeIcons ? "icons" : "legacy-icons",
          records.map(({ entry, contentHash }) => [
            entry.provider,
            contentHash,
            references ? null : (entry.fetchedAt ?? null),
          ]),
        ]),
      )
      .digest("base64url");
    const fetchedAt = references
      ? Object.fromEntries(
          records.flatMap(({ entry }) =>
            entry.fetchedAt ? [[entry.provider, entry.fetchedAt]] : [],
          ),
        )
      : undefined;
    const identified = { ...envelope, entries: [], snapshotHash, fetchedAt };
    if (request && request.ifNoneMatch === snapshotHash) {
      return { ...identified, notModified: true as const };
    }
    if (!request && references) return identified;

    const entries = clientEntries();
    const content = references
      ? entries.map(({ fetchedAt: _fetchedAt, ...entry }) => entry)
      : entries;
    return { ...identified, compactSnapshot: compactProviderSnapshot(content) };
  }

  private emitProviderDisabledResponse(
    kind: "models" | "modes",
    provider: AgentProvider,
    requestId: string,
    fetchedAt: string,
  ): void {
    const payload = {
      provider,
      error: `Provider ${provider} is disabled`,
      fetchedAt,
      requestId,
    };
    if (kind === "models") {
      this.host.emit({ type: "list_provider_models_response", payload });
    } else {
      this.host.emit({ type: "list_provider_modes_response", payload });
    }
  }

  async handleListProviderModelsRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_models_request" }>,
  ): Promise<void> {
    const cwd = resolveCatalogRequestCwd(msg.cwd);
    const fetchedAt = new Date().toISOString();

    const entry = await this.getProviderSnapshotEntryForRead(cwd, msg.provider);

    if (!entry) {
      this.host.emit({
        type: "list_provider_models_response",
        payload: {
          provider: msg.provider,
          error: `Unknown provider: ${msg.provider}`,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    if (!entry.enabled) {
      this.emitProviderDisabledResponse("models", msg.provider, msg.requestId, fetchedAt);
      return;
    }

    if (entry.status === "ready") {
      this.host.emit({
        type: "list_provider_models_response",
        payload: {
          provider: msg.provider,
          models: filterSelectableAgentModels(entry.models),
          error: null,
          fetchedAt: entry.fetchedAt ?? fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    const errorMessage =
      entry.status === "error"
        ? (entry.error ?? `Failed to list models for ${msg.provider}`)
        : `Provider ${msg.provider} is not available`;

    this.host.emit({
      type: "list_provider_models_response",
      payload: {
        provider: msg.provider,
        error: errorMessage,
        fetchedAt,
        requestId: msg.requestId,
      },
    });
  }

  async handleListProviderModesRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_modes_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    const cwd = resolveCatalogRequestCwd(msg.cwd);
    const entry = await this.getProviderSnapshotEntryForRead(cwd, msg.provider);

    if (!entry) {
      this.host.emit({
        type: "list_provider_modes_response",
        payload: {
          provider: msg.provider,
          error: `Unknown provider: ${msg.provider}`,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    if (!entry.enabled) {
      this.emitProviderDisabledResponse("modes", msg.provider, msg.requestId, fetchedAt);
      return;
    }

    if (entry.status === "ready") {
      this.host.emit({
        type: "list_provider_modes_response",
        payload: {
          provider: msg.provider,
          modes: this.downgradeModeIconsForClient(entry.modes ?? []),
          error: null,
          fetchedAt: entry.fetchedAt ?? fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    const errorMessage =
      entry.status === "error"
        ? (entry.error ?? `Failed to list modes for ${msg.provider}`)
        : `Provider ${msg.provider} is not available`;

    this.host.emit({
      type: "list_provider_modes_response",
      payload: {
        provider: msg.provider,
        error: errorMessage,
        fetchedAt,
        requestId: msg.requestId,
      },
    });
  }

  private async getProviderSnapshotEntryForRead(
    cwd: string | undefined,
    provider: AgentProvider,
  ): Promise<ProviderSnapshotEntry | undefined> {
    const manager = this.providerSnapshotManager;
    const findEntry = () =>
      manager.getSnapshot(cwd).records.find(({ entry }) => entry.provider === provider)?.entry;

    let entry = findEntry();
    if (entry && !entry.enabled) {
      return entry;
    }
    if (!entry || entry.status === "loading") {
      // Awaits the in-flight warmup (deduped per-cwd) so old clients still get
      // a resolved answer rather than a loading placeholder.
      await manager.warmUpSnapshotForCwd({ cwd, providers: [provider] });
      entry = findEntry();
    }
    return entry;
  }

  private buildDraftAgentSessionConfig(draftConfig: {
    provider: AgentProvider;
    cwd: string;
    modeId?: string;
    model?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
  }): AgentSessionConfig {
    return {
      provider: draftConfig.provider,
      cwd: expandTilde(draftConfig.cwd),
      ...(draftConfig.modeId ? { modeId: draftConfig.modeId } : {}),
      ...(draftConfig.model ? { model: draftConfig.model } : {}),
      ...(draftConfig.thinkingOptionId ? { thinkingOptionId: draftConfig.thinkingOptionId } : {}),
      ...(draftConfig.featureValues ? { featureValues: draftConfig.featureValues } : {}),
    };
  }

  async handleListProviderFeaturesRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_features_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      const sessionConfig = this.buildDraftAgentSessionConfig(msg.draftConfig);
      const features = await this.host.listDraftFeatures(sessionConfig);
      this.host.emit({
        type: "list_provider_features_response",
        payload: {
          provider: msg.draftConfig.provider,
          features,
          error: null,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, provider: msg.draftConfig.provider, draftConfig: msg.draftConfig },
        `Failed to list features for ${msg.draftConfig.provider}`,
      );
      this.host.emit({
        type: "list_provider_features_response",
        payload: {
          provider: msg.draftConfig.provider,
          error: getErrorMessage(error),
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleListAvailableProvidersRequest(
    msg: Extract<SessionInboundMessage, { type: "list_available_providers_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      const providers = (await this.host.listProviderAvailability()).filter((provider) =>
        this.host.isProviderVisibleToClient(provider.provider),
      );
      this.host.emit({
        type: "list_available_providers_response",
        payload: {
          providers,
          error: null,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to list provider availability");
      this.host.emit({
        type: "list_available_providers_response",
        payload: {
          providers: [],
          error: getErrorMessage(error),
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleGetProvidersSnapshotRequest(
    msg: Extract<SessionInboundMessage, { type: "get_providers_snapshot_request" }>,
  ): Promise<void> {
    const cwd = msg.cwd?.trim() ? resolveSnapshotCwd(expandTilde(msg.cwd)) : undefined;
    const snapshot = this.visibleSnapshot(this.providerSnapshotManager.getSnapshot(cwd));
    this.host.emit({
      type: "get_providers_snapshot_response",
      payload: {
        ...this.snapshotPayload(snapshot, { ifNoneMatch: msg.ifNoneMatch }),
        requestId: msg.requestId,
      },
    });
  }

  async handleRefreshProvidersSnapshotRequest(
    msg: Extract<SessionInboundMessage, { type: "refresh_providers_snapshot_request" }>,
  ): Promise<void> {
    if (msg.cwd) {
      await this.providerSnapshotManager.refreshSnapshotForCwd({
        cwd: expandTilde(msg.cwd),
        providers: msg.providers,
      });
    } else {
      await this.providerSnapshotManager.refreshSettingsSnapshot({
        providers: msg.providers,
      });
    }
    this.host.emit({
      type: "refresh_providers_snapshot_response",
      payload: {
        acknowledged: true,
        requestId: msg.requestId,
      },
    });
  }

  async handleProviderDiagnosticRequest(
    msg: Extract<SessionInboundMessage, { type: "provider_diagnostic_request" }>,
  ): Promise<void> {
    try {
      const { diagnostic } = await this.providerSnapshotManager.getProviderDiagnostic(msg.provider);
      this.host.emit({
        type: "provider_diagnostic_response",
        payload: {
          provider: msg.provider,
          diagnostic,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        { err, provider: msg.provider },
        `Failed to get provider diagnostic for ${msg.provider}`,
      );
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to get provider diagnostic: ${err.message}`,
          code: "provider_diagnostic_failed",
        },
      });
    }
  }

  private async accountEntryFor(
    credential: NonNullable<
      ReturnType<NonNullable<ProviderCatalogSessionOptions["usageCredential"]>>
    >,
    displayName: string,
    refresh: boolean,
  ) {
    const name = credential.label ?? "this account";
    if (!this.accountUsage) return unavailableAccountEntry(credential.provider, displayName, name);
    return providerUsageFromAccountRow(
      await this.accountUsage.rowFor(pooledAccountOf(credential, name), { refresh }),
      displayName,
    );
  }

  private emitObservedUsage(
    msg: Extract<SessionInboundMessage, { type: "provider.usage.list.request" }>,
  ): void {
    if (msg.refresh === true) {
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: "Observation refresh cannot generate usage reads",
          code: "observation_refresh_unsupported",
        },
      });
      return;
    }
    const usage = this.providerUsageService.observeUsage();
    const credential = msg.agentId ? this.usageCredential?.(msg.agentId) : null;
    const accounts = msg.accounts === true ? this.accountUsage?.observe() : undefined;
    const sessionAccount = this.observedSessionAccount(credential);
    if (credential?.isCurrent && !credential.isCurrent())
      throw Error("Session changed during usage observation");
    let providers = usage.providers.filter((entry) =>
      this.host.isProviderVisibleToClient(entry.providerId),
    );
    if (sessionAccount) {
      const bound = sessionAccount.usage
        ? providerUsageFromAccountRow(sessionAccount.usage, sessionAccount.provider)
        : unavailableAccountEntry(
            sessionAccount.provider,
            sessionAccount.provider,
            sessionAccount.displayName,
          );
      providers = providers.filter((entry) => entry.providerId !== bound.providerId).concat(bound);
    }
    this.host.emit({
      type: "provider.usage.list.response",
      payload: {
        requestId: msg.requestId,
        fetchedAt: usage.fetchedAt,
        providers,
        observationOnly: true,
        ...(accounts
          ? {
              accounts: accounts.filter((row) => this.host.isProviderVisibleToClient(row.provider)),
            }
          : {}),
        ...(msg.agentId ? { sessionAccount } : {}),
      },
    });
  }

  private observedSessionAccount(
    credential:
      | ReturnType<NonNullable<ProviderCatalogSessionOptions["usageCredential"]>>
      | undefined,
  ): NonNullable<
    Extract<
      SessionOutboundMessage,
      { type: "provider.usage.list.response" }
    >["payload"]["sessionAccount"]
  > | null {
    if (
      !credential ||
      (credential.provider !== "claude" && credential.provider !== "codex") ||
      !this.host.isProviderVisibleToClient(credential.provider)
    )
      return null;
    const metadata = sanitizeAccountMetadata({
      id: credential.accountId ?? null,
      provider: credential.provider,
      name: credential.label ?? "Pooled account",
    });
    const usage = this.accountUsage?.observeRowFor({
      ...metadata,
      credential: credential.credential,
    });
    return {
      accountId: metadata.id,
      provider: metadata.provider,
      displayName: metadata.name,
      state: metadata.id ? "bound" : "identity-unavailable",
      source: "session-launch",
      ...(usage ? { usage } : {}),
    };
  }

  async handleProviderUsageListRequest(
    msg: Extract<SessionInboundMessage, { type: "provider.usage.list.request" }>,
  ): Promise<void> {
    try {
      if (msg.observationOnly === true) {
        this.emitObservedUsage(msg);
        return;
      }
      await this.emitProviderUsage(msg);
    } catch {
      this.logger.error("Failed to list provider usage");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: "Failed to list provider usage",
          code: "provider_usage_list_failed",
        },
      });
    }
  }
  private async emitProviderUsage(
    msg: Extract<SessionInboundMessage, { type: "provider.usage.list.request" }>,
  ): Promise<void> {
    const usage = await this.providerUsageService.listUsage();
    // A pooled session: its provider's entry is the account it runs on (labelled), never the Mac's own login. When
    // that account cannot be read the entry says "Usage unavailable for <name>" instead of falling back.
    const credential = msg.agentId ? (this.usageCredential?.(msg.agentId) ?? null) : null;
    const nativeUsage = msg.agentId ? await this.sessionUsage?.(msg.agentId) : null;
    const refresh = msg.refresh === true;
    let providers = usage.providers;
    if (nativeUsage) {
      const sourceLabel = nativeUsage.sourceLabel ? safeAccountName(nativeUsage.sourceLabel) : null;
      const sanitized = {
        ...nativeUsage,
        sourceLabel,
        error: nativeUsage.error
          ? `Usage unavailable for ${sourceLabel ?? "this account"}`
          : nativeUsage.error,
      };
      providers = providers.map((entry) =>
        entry.providerId === nativeUsage.providerId ? sanitized : entry,
      );
    } else if (credential) {
      const displayName =
        providers.find((entry) => entry.providerId === credential.provider)?.displayName ??
        credential.provider;
      const entry = await this.accountEntryFor(credential, displayName, refresh);
      providers = providers.map((p) => (p.providerId === credential.provider ? entry : p));
    }
    const accounts =
      msg.accounts === true && this.accountUsage
        ? await this.accountUsage.list({ refresh })
        : undefined;
    if (credential?.isCurrent && !credential.isCurrent())
      throw new Error("Session changed during account usage read");
    this.host.emit({
      type: "provider.usage.list.response",
      payload: {
        requestId: msg.requestId,
        fetchedAt: usage.fetchedAt,
        providers,
        ...(accounts ? { accounts } : {}),
      },
    });
  }
}

function resolveCatalogRequestCwd(cwd?: string | null): string | undefined {
  const trimmed = cwd?.trim();
  return trimmed ? expandTilde(trimmed) : undefined;
}

function pooledAccountOf(
  session: { provider: string; credential: AccountCredential; accountId?: string | null },
  name: string,
): PooledAccount {
  return {
    id: session.accountId ?? null,
    provider: session.provider as AccountProvider,
    name,
    credential: session.credential,
  };
}
