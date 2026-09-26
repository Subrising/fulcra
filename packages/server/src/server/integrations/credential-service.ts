import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AccountsStore, CredentialAccount } from "./accounts-store.js";
import { CREDENTIALS_SERVICE, type CredentialBackend } from "./credential-backend.js";
import {
  PROVIDERS,
  authorizationHeader,
  findProvider,
  methodAvailability,
  normalizeSite,
  type MethodAvailability,
  type ProviderDefinition,
  type SignInMethod,
} from "./providers.js";
import {
  SignInFlows,
  SignInError,
  refreshDeviceToken,
  type BeginResult,
  type CompleteResult,
  type ConnectedResult,
  type FlowInput,
  type LoopbackListener,
  type RedirectTarget,
  type StoredSecret,
} from "./sign-in-flows.js";
import {
  CredentialRequestSchema,
  sendCredentialRequest,
  type CredentialResponse,
} from "./credential-request.js";

// The shared credential store. Metadata goes through the accounts store; secrets
// go only to the OS credential store under `ai.fulcra.credentials/<account id>`. Plugins and the forge
// layer read the same accounts. Plugins never receive a secret: they make host-mediated requests.

const StoredSecretSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    scheme: z.enum(["bearer", "basic"]),
  })
  .strict();

export interface ProviderSummary {
  connector: string;
  label: string;
  selfHosted: boolean;
  requiresSite: boolean;
  requiresEmailForToken: boolean;
  acceptsUsernameForToken: boolean;
  methods: MethodAvailability[];
  tokenHelp: { createUrl: string; scopes: string[]; note: string };
}

export type CompleteOutcome =
  | { status: "pending"; retryAfterSeconds: number }
  | { status: "connected"; account: CredentialAccount };

export class CredentialAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialAccessError";
  }
}

export interface LegacyImportInput {
  pluginId: string;
  secretName: string;
  connector: string;
  site?: string | null;
  email?: string | null;
}

export interface CredentialServiceOptions {
  accounts: AccountsStore;
  backend: CredentialBackend;
  clientIds?: () => Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  now?: () => number;
  providers?: readonly ProviderDefinition[];
  openLoopback?: (onCallback: (url: string) => void) => Promise<LoopbackListener>;
  onAccountsChanged?: () => void;
}

const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;
// Per-account budget for plugin requests. Provider limits are far higher; this bounds a runaway
// plugin before it spends the user's provider quota.
const REQUESTS_PER_WINDOW = 120;
const REQUEST_WINDOW_MS = 60_000;
const REMOVAL_PENDING = "Couldn't remove this account from the system keychain; retry Disconnect";
const RECONNECT_NEEDED = "This account needs to be reconnected in Settings › Integrations";
const GITHUB_TOKEN_CACHE_MS = 60_000;
const LEGACY_SECRET_NAME = /^[a-z0-9][a-z0-9.:-]{0,127}$/;

export class CredentialService {
  private readonly providers: readonly ProviderDefinition[];
  private readonly flows: SignInFlows;
  private readonly clientIds: () => Readonly<Record<string, string | undefined>>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  // Loopback sign-ins finish on the host without a client call; their result waits here.
  private readonly loopbackResults = new Map<string, Promise<CompleteOutcome>>();
  // The PR panels run `gh` often; the token is looked up at most once a minute and on every change.
  private githubToken: { value: string | null; at: number } | null = null;
  // Per-account lifecycle: mutations run one at a time, and Disconnect bumps the generation so a
  // refresh or reconnect that started earlier cannot commit afterwards.
  private readonly accountLocks = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();
  // One refresh per account *and generation*: after a reconnect, callers never join old work.
  private readonly refreshing = new Map<
    string,
    { generation: number; promise: Promise<StoredSecret> }
  >();
  private readonly requestTimes = new Map<string, number[]>();

  constructor(private readonly options: CredentialServiceOptions) {
    this.providers = options.providers ?? PROVIDERS;
    this.clientIds = options.clientIds ?? (() => ({}));
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.flows = new SignInFlows({
      providers: this.providers,
      clientIds: this.clientIds,
      fetch: this.fetchImpl,
      now: this.now,
      openLoopback: options.openLoopback,
      onLoopbackCallback: (flowId, result) => {
        const outcome = result.then((value) => this.toOutcome(value));
        outcome.catch(() => undefined);
        this.loopbackResults.set(flowId, outcome);
      },
    });
  }

  // -- Host API -------------------------------------------------------------------------------

  async list(): Promise<{ accounts: CredentialAccount[]; providers: ProviderSummary[] }> {
    return { accounts: await this.options.accounts.list(), providers: this.providerSummaries() };
  }

  providerSummaries(): ProviderSummary[] {
    const clientIds = this.clientIds();
    return this.providers.map((provider) => ({
      connector: provider.id,
      label: provider.label,
      selfHosted: provider.selfHosted,
      requiresSite: provider.requiresSite,
      requiresEmailForToken: provider.token.requiresEmail,
      acceptsUsernameForToken: provider.token.acceptsUsername === true,
      methods: methodAvailability(provider, clientIds),
      tokenHelp: {
        createUrl: provider.token.help.createUrl,
        scopes: [...provider.token.help.scopes],
        note: provider.token.help.note,
      },
    }));
  }

  begin(input: {
    connector: string;
    method: SignInMethod;
    site?: string | null;
    redirect?: RedirectTarget;
  }): Promise<BeginResult> {
    return this.flows.begin(input);
  }

  async complete(flowId: string, input: FlowInput): Promise<CompleteOutcome> {
    const loopback = this.loopbackResults.get(flowId);
    if (loopback) {
      this.loopbackResults.delete(flowId);
      return loopback;
    }
    return this.toOutcome(await this.flows.complete(flowId, input));
  }

  private async toOutcome(result: CompleteResult): Promise<CompleteOutcome> {
    if (result.status === "pending") return result;
    return { status: "connected", account: await this.store(result) };
  }

  // The app forwards fulcra://oauth/<flowId>?code=…&state=… here.
  completeCallback(url: string): Promise<CompleteOutcome> {
    return this.complete(this.flows.flowIdForCallback(url), { kind: "callback", url });
  }

  async reconnect(
    accountId: string,
    options: { method?: SignInMethod; redirect?: RedirectTarget } = {},
  ): Promise<BeginResult> {
    const account = await this.requireAccount(accountId);
    const provider = this.requireProvider(account.connector);
    const available = methodAvailability(provider, this.clientIds())
      .filter((entry) => entry.status === "available")
      .map((entry) => entry.method);
    const method =
      options.method ?? (available.includes(account.method) ? account.method : "token");
    if (account.state === "revoked") throw new CredentialAccessError(REMOVAL_PENDING);
    return this.flows.begin({
      connector: account.connector,
      method,
      site: account.site,
      redirect: options.redirect,
      replaceAccountId: account.id,
      replaceGeneration: this.generation(account.id),
    });
  }

  // Disconnect is final. The account is first marked `revoked` (listed as "Couldn't remove; retry"
  // until this completes), which stops every use and fences in-flight refresh and reconnect work.
  // Metadata goes only after the OS store confirms the secret is deleted; if it cannot, the call
  // fails and the `revoked` row stays so the user can retry.
  async remove(accountId: string): Promise<boolean> {
    this.bumpGeneration(accountId);
    this.flows.cancelForAccount(accountId);
    return this.withAccountLock(accountId, async () => {
      const account = await this.options.accounts.get(accountId);
      if (!account) return false;
      if (account.state !== "revoked") {
        await this.options.accounts.put({
          ...account,
          state: "revoked",
          lastCheckedAt: new Date(this.now()).toISOString(),
        });
        this.accountsChanged();
      }
      try {
        await this.options.backend.delete(CREDENTIALS_SERVICE, account.id);
      } catch {
        throw new CredentialAccessError(REMOVAL_PENDING);
      }
      const removed = await this.options.accounts.remove(account.id);
      this.accountsChanged();
      return removed;
    });
  }

  dispose(): void {
    this.flows.dispose();
  }

  // -- Plugin access ------------------------------------------------------------------------------

  // A host-mediated provider request. The caller is the daemon, which passes
  // the connectors and write permission from the plugin's manifest; the plugin supplies neither.
  // The credential is attached here and scrubbed from the answer, so it never reaches the plugin.
  async request(input: {
    grants: readonly string[];
    writeGranted: boolean;
    accountId: string;
    connector: string;
    request: unknown;
  }): Promise<CredentialResponse> {
    if (!input.grants.includes(input.connector)) {
      throw new CredentialAccessError(
        `This plugin did not declare "${input.connector}" in requirements.credentials`,
      );
    }
    const parsed = CredentialRequestSchema.safeParse(input.request);
    if (!parsed.success) throw new CredentialAccessError("That request is not valid");
    const request = parsed.data;
    if (request.method !== "GET" && !input.writeGranted) {
      throw new CredentialAccessError(
        `${request.method} requests need requirements.credentialsWrite; trackers are read-only in v1`,
      );
    }
    const account = await this.options.accounts.get(input.accountId);
    // One message for "missing" and "other connector", so a plugin cannot probe other accounts.
    if (!account || account.connector !== input.connector) {
      throw new CredentialAccessError(`No ${input.connector} account with that id`);
    }
    this.takeRequestSlot(account.id);
    const secret = await this.secretFor(account);
    const authorization = authorizationHeader(secret.scheme, secret.accessToken, secret.email);
    return sendCredentialRequest({
      provider: this.requireProvider(account.connector),
      site: account.site,
      authorization,
      secrets: [
        secret.accessToken,
        ...(secret.refreshToken ? [secret.refreshToken] : []),
        authorization,
        authorization.slice(authorization.indexOf(" ") + 1),
      ],
      request,
      fetch: this.fetchImpl,
    });
  }

  private takeRequestSlot(accountId: string): void {
    const now = this.now();
    const recent = (this.requestTimes.get(accountId) ?? []).filter(
      (at) => now - at < REQUEST_WINDOW_MS,
    );
    if (recent.length >= REQUESTS_PER_WINDOW) {
      this.requestTimes.set(accountId, recent);
      throw new CredentialAccessError(
        "Too many requests for this account in the last minute; try again shortly",
      );
    }
    recent.push(now);
    this.requestTimes.set(accountId, recent);
  }

  // Once per plugin item: copies a token stored under the plugin's own keychain namespace
  // (`ai.fulcra.plugin.<pluginId>`) into an account. The old item is read and never changed.
  async importLegacy(input: LegacyImportInput & { grants: readonly string[] }): Promise<{
    account: CredentialAccount;
    imported: boolean;
  }> {
    if (!PLUGIN_ID.test(input.pluginId)) throw new CredentialAccessError("Invalid plugin id");
    if (!LEGACY_SECRET_NAME.test(input.secretName)) {
      throw new CredentialAccessError("Invalid plugin secret name");
    }
    if (!input.grants.includes(input.connector)) {
      throw new CredentialAccessError(
        `This plugin did not declare "${input.connector}" in requirements.credentials`,
      );
    }
    const provider = this.requireProvider(input.connector);
    const key = `${input.pluginId}/${input.secretName}`;
    const existingId = await this.options.accounts.findImport(key);
    if (existingId) {
      const existing = await this.options.accounts.get(existingId);
      if (existing) return { account: existing, imported: false };
      throw new CredentialAccessError(
        "This token was imported before and that account was disconnected; sign in again in Settings › Integrations",
      );
    }

    const token = await this.options.backend.get(
      `ai.fulcra.plugin.${input.pluginId}`,
      input.secretName,
    );
    if (!token)
      throw new CredentialAccessError("There is no stored token with that name to import");
    const site = normalizeSite(input.site);
    if (provider.requiresSite && !site)
      throw new CredentialAccessError(`${provider.label} needs a site`);
    const email = input.email?.trim() || undefined;
    if (provider.token.requiresEmail && !email) {
      throw new CredentialAccessError(`${provider.label} needs the email address of the account`);
    }
    const account = await this.store({
      status: "connected",
      connector: provider.id,
      site: provider.requiresSite ? site : null,
      method: "token",
      displayName: `${provider.label} (imported)`.slice(0, 80),
      scopes: [...provider.token.help.scopes],
      expiresAt: null,
      secret: {
        accessToken: token.trim(),
        scheme: provider.token.acceptsUsername && email ? "basic" : provider.token.scheme,
        ...(email ? { email } : {}),
      },
      replaceAccountId: null,
      replaceGeneration: null,
    });
    await this.options.accounts.recordImport(key, account.id);
    return { account, imported: true };
  }

  // -- Forge layer --------------------------------------------------------------------------------

  // The GitHub PR panels run the `gh` CLI; a connected github.com account supplies its token. Returns
  // null when there is none, and the CLI's own login applies as before.
  async githubTokenForHost(host: string | null): Promise<string | null> {
    const normalized = (host ?? "github.com").toLowerCase();
    if (normalized !== "github.com") return null;
    const cached = this.githubToken;
    if (cached && this.now() - cached.at < GITHUB_TOKEN_CACHE_MS) return cached.value;
    const value = await this.findGithubToken();
    this.githubToken = { value, at: this.now() };
    return value;
  }

  private async findGithubToken(): Promise<string | null> {
    const accounts = await this.options.accounts.list();
    const candidates = accounts
      .filter((account) => account.connector === "github" && account.state === "connected")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const account of candidates) {
      try {
        return (await this.secretFor(account)).accessToken;
      } catch {
        // An account that fails refresh is marked needs-reconnect; try the next one.
      }
    }
    return null;
  }

  // -- Internals ----------------------------------------------------------------------------------

  private generation(accountId: string): number {
    return this.generations.get(accountId) ?? 0;
  }

  private bumpGeneration(accountId: string): void {
    this.generations.set(accountId, this.generation(accountId) + 1);
  }

  private withAccountLock<Result>(accountId: string, work: () => Promise<Result>): Promise<Result> {
    const previous = this.accountLocks.get(accountId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.accountLocks.set(accountId, settled);
    void settled.then(() => {
      if (this.accountLocks.get(accountId) === settled) this.accountLocks.delete(accountId);
      return undefined;
    });
    return next;
  }

  private accountsChanged(): void {
    this.githubToken = null;
    this.options.onAccountsChanged?.();
  }

  private requireProvider(connector: string): ProviderDefinition {
    const provider = findProvider(this.providers, connector);
    if (!provider) throw new SignInError(`Unknown connector: ${connector}`);
    return provider;
  }

  private async requireAccount(accountId: string): Promise<CredentialAccount> {
    const account = await this.options.accounts.get(accountId);
    if (!account) throw new CredentialAccessError("No account with that id");
    return account;
  }

  private async readSecret(accountId: string): Promise<StoredSecret | null> {
    const raw = await this.options.backend.get(CREDENTIALS_SERVICE, accountId);
    if (!raw) return null;
    try {
      return StoredSecretSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async setState(
    account: CredentialAccount,
    state: CredentialAccount["state"],
  ): Promise<CredentialAccount> {
    const next = { ...account, state, lastCheckedAt: new Date(this.now()).toISOString() };
    await this.options.accounts.put(next);
    this.accountsChanged();
    return next;
  }

  // The account, its secret and its generation are read together under the account lock, where a
  // reconnect also commits, so a caller never pairs one identity's metadata with another's secret.
  private async secretFor(accountRef: CredentialAccount): Promise<StoredSecret> {
    const snapshot = await this.withAccountLock(accountRef.id, async () => ({
      account: await this.options.accounts.get(accountRef.id),
      secret: await this.readSecret(accountRef.id),
      generation: this.generation(accountRef.id),
    }));
    const { account, generation } = snapshot;
    if (!account) throw new CredentialAccessError("No account with that id");
    if (account.state === "revoked")
      throw new CredentialAccessError("This account is being disconnected");
    if (account.state === "needs-reconnect") throw new CredentialAccessError(RECONNECT_NEEDED);
    if (!snapshot.secret) {
      await this.markNeedsReconnect(account.id, generation);
      throw new CredentialAccessError(RECONNECT_NEEDED);
    }
    const expired =
      account.expiresAt !== null && Date.parse(account.expiresAt) <= this.now() + 60_000;
    return expired ? this.refreshOnce(account, snapshot.secret, generation) : snapshot.secret;
  }

  // Concurrent callers share one refresh: rotating refresh tokens must not be spent twice.
  private refreshOnce(
    account: CredentialAccount,
    secret: StoredSecret,
    generation: number,
  ): Promise<StoredSecret> {
    const running = this.refreshing.get(account.id);
    if (running && running.generation === generation) return running.promise;
    const promise = this.refresh(account, secret, generation).finally(() => {
      if (this.refreshing.get(account.id)?.promise === promise) this.refreshing.delete(account.id);
    });
    this.refreshing.set(account.id, { generation, promise });
    return promise;
  }

  // `generation` is the one the account and secret were read under. Success and failure both
  // commit only if it is still current: a reconnect or Disconnect in the meantime wins.
  private async refresh(
    account: CredentialAccount,
    secret: StoredSecret,
    generation: number,
  ): Promise<StoredSecret> {
    const provider = this.requireProvider(account.connector);
    let refreshed: Awaited<ReturnType<typeof refreshDeviceToken>>;
    try {
      if (account.method !== "device" || !secret.refreshToken) throw new Error("not refreshable");
      refreshed = await refreshDeviceToken({
        provider,
        clientId: this.clientIds()[provider.id],
        refreshToken: secret.refreshToken,
        fetch: this.fetchImpl,
        nowMs: this.now(),
      });
    } catch {
      await this.markNeedsReconnect(account.id, generation);
      throw new CredentialAccessError(RECONNECT_NEEDED);
    }
    return this.withAccountLock(account.id, async () => {
      // Disconnected (or replaced) while the provider answered: the new token is dropped.
      const current = await this.options.accounts.get(account.id);
      if (this.generation(account.id) !== generation || !current || current.state === "revoked") {
        throw new CredentialAccessError(
          "This account was reconnected or disconnected while it refreshed; try again",
        );
      }
      await this.options.backend.set(
        CREDENTIALS_SERVICE,
        account.id,
        JSON.stringify(refreshed.secret),
      );
      await this.options.accounts.put({
        ...current,
        state: "connected",
        expiresAt: refreshed.expiresAt,
        lastCheckedAt: new Date(this.now()).toISOString(),
      });
      this.accountsChanged();
      return refreshed.secret;
    });
  }

  private markNeedsReconnect(accountId: string, generation: number): Promise<void> {
    return this.withAccountLock(accountId, async () => {
      const current = await this.options.accounts.get(accountId);
      if (this.generation(accountId) !== generation || !current || current.state === "revoked") {
        return;
      }
      await this.setState(current, "needs-reconnect");
    });
  }

  private async store(result: ConnectedResult): Promise<CredentialAccount> {
    if (!result.replaceAccountId) return this.writeAccount(result, null);
    const accountId = result.replaceAccountId;
    return this.withAccountLock(accountId, async () => {
      const previous = await this.options.accounts.get(accountId);
      if (
        !previous ||
        previous.state === "revoked" ||
        this.generation(accountId) !== result.replaceGeneration
      ) {
        throw new SignInError("This account was disconnected; connect it again");
      }
      if (previous.connector !== result.connector) {
        throw new SignInError("A reconnect must use the same provider");
      }
      const account = await this.writeAccount(result, previous);
      // The replacement is committed: every refresh or reconnect that started under the old
      // identity is now stale, whether it later succeeds or fails.
      this.bumpGeneration(accountId);
      return account;
    });
  }

  private async writeAccount(
    result: ConnectedResult,
    previous: CredentialAccount | null,
  ): Promise<CredentialAccount> {
    const nowIso = new Date(this.now()).toISOString();
    const account: CredentialAccount = {
      version: 1,
      id: previous?.id ?? randomUUID(),
      connector: result.connector,
      site: result.site,
      displayName: result.displayName,
      method: result.method,
      scopes: result.scopes,
      state: "connected",
      expiresAt: result.expiresAt,
      lastCheckedAt: nowIso,
      createdAt: previous?.createdAt ?? nowIso,
    };
    // Secret first: an account row never exists without its secret.
    await this.options.backend.set(CREDENTIALS_SERVICE, account.id, JSON.stringify(result.secret));
    await this.options.accounts.put(account);
    this.accountsChanged();
    return account;
  }
}
