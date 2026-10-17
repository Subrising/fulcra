import type { SessionCost } from "@getpaseo/protocol/recorded-usage";
import type pino from "pino";
import {
  sanitizeAccountMetadata,
  safeAccountName,
} from "../../../services/quota-fetcher/account-usage-sanitize.js";
import type {
  ProviderUsage,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
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

export interface AccountUsageSessionOptions {
  canReadSessionCost?: (id: string) => boolean | Promise<boolean>;
  refreshSessionCost?: (agentId: string) => Promise<SessionCost | undefined>;
  sessionCost?: (agentId: string) => SessionCost | undefined;
  host: {
    emit(message: SessionOutboundMessage): void;
    isProviderVisibleToClient(provider: string): boolean;
  };
  /** FULCRA(accounts): legacy provider usage list, until account usage moves to a usage source. */
  providerUsageService: Pick<ProviderUsageService, "listUsage" | "observeUsage">;
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
// COMPAT(pooledLegacyUsage): added in v0.2.18, remove after 2027-04-12 when clients use native usage sources.
export class AccountUsageSession {
  private readonly host: AccountUsageSessionOptions["host"];
  private readonly providerUsageService: AccountUsageSessionOptions["providerUsageService"];
  private readonly logger: pino.Logger;
  private readonly sessionUsage: AccountUsageSessionOptions["sessionUsage"];
  private readonly usageCredential: AccountUsageSessionOptions["usageCredential"];
  private readonly accountUsage: AccountUsageRegistry | undefined;
  private readonly canReadSessionCost: AccountUsageSessionOptions["canReadSessionCost"];
  private readonly refreshSessionCost: AccountUsageSessionOptions["refreshSessionCost"];
  private readonly sessionCost: AccountUsageSessionOptions["sessionCost"];
  constructor(options: AccountUsageSessionOptions) {
    this.sessionCost = options.sessionCost;
    this.canReadSessionCost = options.canReadSessionCost;
    this.refreshSessionCost = options.refreshSessionCost;
    this.host = options.host;
    this.providerUsageService = options.providerUsageService;
    this.logger = options.logger;
    this.sessionUsage = options.sessionUsage;
    this.usageCredential = options.usageCredential;
    this.accountUsage = options.accountUsage;
  }
  private async accountEntryFor(
    credential: NonNullable<ReturnType<NonNullable<AccountUsageSessionOptions["usageCredential"]>>>,
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

  private async emitObservedUsage(
    msg: Extract<SessionInboundMessage, { type: "provider.usage.list.request" }>,
  ): Promise<void> {
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
        sessionCost: await this.readSessionCost(msg.agentId),
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
    credential: ReturnType<NonNullable<AccountUsageSessionOptions["usageCredential"]>> | undefined,
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
        await this.emitObservedUsage(msg);
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
  private async readSessionCost(id: string | undefined) {
    if (!id || (this.canReadSessionCost && !(await this.canReadSessionCost(id)))) return undefined;
    return this.refreshSessionCost ? this.refreshSessionCost(id) : this.sessionCost?.(id);
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
        sessionCost: await this.readSessionCost(msg.agentId),
        requestId: msg.requestId,
        fetchedAt: usage.fetchedAt,
        providers,
        ...(accounts ? { accounts } : {}),
      },
    });
  }
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
