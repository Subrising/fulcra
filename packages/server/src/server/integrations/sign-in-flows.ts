import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  authorizationHeader,
  findProvider,
  methodAvailability,
  normalizeSite,
  type ProviderDefinition,
  type SignInMethod,
} from "./providers.js";

// Sign-in flow state machine for the shared credential store. A flow starts with `begin` and ends in
// exactly one `connected` result or a failure. It never persists anything itself: the credential
// service stores what `complete` returns. Secrets live only in memory while a flow runs.

export const OAUTH_CALLBACK_SCHEME = "fulcra:";
const FLOW_LIFETIME_MS = 10 * 60 * 1000;
const MAX_ACTIVE_FLOWS = 16;

export interface StoredSecret {
  accessToken: string;
  refreshToken?: string;
  email?: string;
  scheme: "bearer" | "basic";
}

export interface ConnectedResult {
  status: "connected";
  connector: string;
  site: string | null;
  method: SignInMethod;
  displayName: string;
  scopes: string[];
  expiresAt: string | null;
  secret: StoredSecret;
  replaceAccountId: string | null;
  // The account's lifecycle generation when the reconnect began; the store refuses a stale one.
  replaceGeneration: number | null;
}

export type CompleteResult = { status: "pending"; retryAfterSeconds: number } | ConnectedResult;

export interface BeginResult {
  flowId: string;
  method: SignInMethod;
  expiresAt: string;
  userCode?: string;
  verifyUrl?: string;
  authUrl?: string;
}

export type FlowInput =
  | { kind: "token"; token: string; email?: string }
  | { kind: "callback"; url: string }
  | { kind: "poll" };

export type RedirectTarget = "app" | "loopback";

export interface LoopbackListener {
  // http://127.0.0.1:<port>
  origin: string;
  close(): void;
}

export interface SignInFlowDependencies {
  providers: readonly ProviderDefinition[];
  clientIds: () => Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now?: () => number;
  // Desktop only: listens on 127.0.0.1 and hands each callback URL back to `complete`.
  openLoopback?: (onCallback: (url: string) => void) => Promise<LoopbackListener>;
  // Called as soon as a loopback callback arrives, with the exchange still in flight.
  onLoopbackCallback?: (flowId: string, result: Promise<CompleteResult>) => void;
}

export class SignInError extends Error {
  // A retryable failure (a mistyped token) leaves the flow open for another attempt.
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

interface FlowBase {
  id: string;
  provider: ProviderDefinition;
  site: string | null;
  replaceAccountId: string | null;
  replaceGeneration: number | null;
  expiresAtMs: number;
  // A flow that finished, failed or was consumed by a callback never runs again.
  done: boolean;
  // Single-flight: one completion attempt at a time. A second concurrent call is refused.
  busy: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface TokenFlow extends FlowBase {
  method: "token";
}

interface DeviceFlow extends FlowBase {
  method: "device";
  deviceCode: string;
  intervalMs: number;
  nextPollAtMs: number;
}

interface BrowserFlow extends FlowBase {
  method: "browser";
  state: string;
  codeVerifier: string;
  redirectUri: string;
  loopback: LoopbackListener | null;
}

type Flow = TokenFlow | DeviceFlow | BrowserFlow;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

function sameSecret(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function isoOrNull(nowMs: number, expiresInSeconds: unknown): string | null {
  return typeof expiresInSeconds === "number" && expiresInSeconds > 0
    ? new Date(nowMs + expiresInSeconds * 1000).toISOString()
    : null;
}

export class SignInFlows {
  private readonly flows = new Map<string, Flow>();
  // Device and browser flows count against the limit while they start, not only once stored.
  private initializing = 0;
  private readonly now: () => number;

  constructor(private readonly deps: SignInFlowDependencies) {
    this.now = deps.now ?? Date.now;
  }

  async begin(input: {
    connector: string;
    method: SignInMethod;
    site?: string | null;
    redirect?: RedirectTarget;
    replaceAccountId?: string | null;
    replaceGeneration?: number | null;
  }): Promise<BeginResult> {
    const provider = findProvider(this.deps.providers, input.connector);
    if (!provider) throw new SignInError(`Unknown connector: ${input.connector}`);
    const availability = methodAvailability(provider, this.deps.clientIds()).find(
      (entry) => entry.method === input.method,
    );
    if (!availability || availability.status !== "available") {
      throw new SignInError(
        `${provider.label} sign-in by ${input.method} is not available on this host`,
      );
    }
    const site = normalizeSite(input.site);
    if (provider.requiresSite && !site) throw new SignInError(`${provider.label} needs a site`);
    this.sweep();
    if (this.flows.size + this.initializing >= MAX_ACTIVE_FLOWS) {
      throw new SignInError("Too many sign-ins in progress");
    }
    const common: FlowBase = {
      id: randomUUID(),
      provider,
      site: provider.requiresSite ? site : null,
      replaceAccountId: input.replaceAccountId ?? null,
      replaceGeneration: input.replaceGeneration ?? null,
      expiresAtMs: this.now() + FLOW_LIFETIME_MS,
      done: false,
      busy: false,
      timer: null,
    };
    if (input.method === "token") {
      this.register({ ...common, method: "token" });
      return {
        flowId: common.id,
        method: "token",
        expiresAt: new Date(common.expiresAtMs).toISOString(),
      };
    }
    if (input.method !== "device" && input.method !== "browser") {
      throw new SignInError(
        `${provider.label} sign-in by ${input.method} is not available on this host`,
      );
    }
    this.initializing += 1;
    try {
      return input.method === "device"
        ? await this.beginDevice(common)
        : await this.beginBrowser(common, input.redirect ?? "app");
    } finally {
      this.initializing -= 1;
    }
  }

  async complete(flowId: string, input: FlowInput): Promise<CompleteResult> {
    const flow = this.flows.get(flowId);
    if (!flow || flow.done)
      throw new SignInError("This sign-in has finished or expired; start again");
    if (this.now() > flow.expiresAtMs) {
      this.finish(flow);
      throw new SignInError("This sign-in expired; start again");
    }
    if (flow.busy) throw new SignInError("This sign-in is already being finished; wait for it");
    flow.busy = true;
    try {
      if (flow.method === "token") {
        if (input.kind !== "token") throw new SignInError("Paste a token to finish this sign-in");
        return this.finishWith(
          flow,
          this.stillCurrent(flow, await this.completeToken(flow, input)),
        );
      }
      if (flow.method === "device") {
        if (input.kind !== "poll")
          throw new SignInError("This sign-in finishes on the provider's page");
        const result = await this.pollDevice(flow);
        return result.status === "connected"
          ? this.finishWith(flow, this.stillCurrent(flow, result))
          : result;
      }
      if (input.kind !== "callback") throw new SignInError("This sign-in finishes in the browser");
      // Consumed before the exchange: a replayed callback can never trigger a second one.
      flow.done = true;
      return this.finishWith(
        flow,
        this.stillCurrent(flow, await this.completeBrowser(flow, input.url)),
      );
    } catch (error) {
      // A wrong pasted token may be retried; any other failure ends the flow.
      if (!(error instanceof SignInError && error.retryable)) this.finish(flow);
      throw error;
    } finally {
      flow.busy = false;
    }
  }

  // A result that arrives after the flow expired or was cancelled (for example by Disconnect)
  // is discarded.
  private stillCurrent(flow: Flow, result: ConnectedResult): ConnectedResult {
    if (this.flows.get(flow.id) !== flow || this.now() > flow.expiresAtMs) {
      throw new SignInError("This sign-in expired or was cancelled; start again");
    }
    return result;
  }

  // Resolves the flow a callback URL belongs to. The URL must be exactly the redirect this host
  // issued: fulcra://oauth/<flowId> or http://127.0.0.1:<port>/oauth/<flowId>.
  flowIdForCallback(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SignInError("Not a sign-in callback");
    }
    const match =
      parsed.protocol === OAUTH_CALLBACK_SCHEME
        ? /^\/\/oauth\/([0-9a-f-]{36})$/.exec(`//${parsed.host}${parsed.pathname}`)
        : /^\/oauth\/([0-9a-f-]{36})$/.exec(parsed.pathname);
    if (!match) throw new SignInError("Not a sign-in callback");
    return match[1];
  }

  cancel(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (flow) this.finish(flow);
  }

  // Disconnect ends every reconnect in progress for that account.
  cancelForAccount(accountId: string): void {
    for (const flow of this.flows.values()) {
      if (flow.replaceAccountId === accountId) this.finish(flow);
    }
  }

  activeFlowCount(): number {
    this.sweep();
    return this.flows.size;
  }

  dispose(): void {
    for (const flow of this.flows.values()) this.finish(flow);
  }

  // ---------------------------------------------------------------------------------------------

  private register(flow: Flow): void {
    this.flows.set(flow.id, flow);
    // An abandoned flow (and its loopback port) ends on time, not on the next API call.
    const delay = Math.max(0, flow.expiresAtMs - this.now()) + 1;
    flow.timer = setTimeout(() => this.finish(flow), delay);
    flow.timer.unref?.();
  }

  private finish(flow: Flow): void {
    flow.done = true;
    if (flow.timer) clearTimeout(flow.timer);
    flow.timer = null;
    if (this.flows.get(flow.id) === flow) this.flows.delete(flow.id);
    if (flow.method === "browser") flow.loopback?.close();
  }

  private finishWith(flow: Flow, result: ConnectedResult): ConnectedResult {
    this.finish(flow);
    return result;
  }

  private sweep(): void {
    const now = this.now();
    for (const flow of this.flows.values()) {
      if (flow.done || now > flow.expiresAtMs) this.finish(flow);
    }
  }

  private clientId(provider: ProviderDefinition): string {
    const clientId = this.deps.clientIds()[provider.id]?.trim();
    if (!clientId) throw new SignInError(`No OAuth client id is configured for ${provider.label}`);
    return clientId;
  }

  private async identify(
    provider: ProviderDefinition,
    site: string | null,
    authorization: string,
  ): Promise<string> {
    const request = provider.identity({ site, authorization });
    let response: Response;
    try {
      response = await this.deps.fetch(request.url, {
        headers: request.headers,
        redirect: "error",
      });
    } catch {
      throw new SignInError(`Couldn't reach ${provider.label}; check the site and your connection`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SignInError(`That token was refused by ${provider.label}`, true);
    }
    if (!response.ok)
      throw new SignInError(`${provider.label} answered ${response.status}; try again`);
    const body = await response.json().catch(() => null);
    return provider.readIdentity(body, response.headers, site).name;
  }

  private async completeToken(
    flow: TokenFlow,
    input: { token: string; email?: string },
  ): Promise<ConnectedResult> {
    const token = input.token.trim();
    if (!token || token.length > 4096 || /\s/.test(token))
      throw new SignInError("That token is not valid", true);
    const email = input.email?.trim() || undefined;
    const tokenMethod = flow.provider.token;
    if (email && !tokenMethod.requiresEmail && !tokenMethod.acceptsUsername) {
      throw new SignInError(`${flow.provider.label} tokens are used without an email`, true);
    }
    if (tokenMethod.requiresEmail && !email) {
      throw new SignInError(`${flow.provider.label} needs the email address of your account`, true);
    }
    const scheme = tokenMethod.acceptsUsername && email ? "basic" : tokenMethod.scheme;
    const displayName = await this.identify(
      flow.provider,
      flow.site,
      authorizationHeader(scheme, token, email),
    );
    return {
      status: "connected",
      connector: flow.provider.id,
      site: flow.site,
      method: "token",
      displayName,
      scopes: [...flow.provider.token.help.scopes],
      expiresAt: null,
      secret: { accessToken: token, scheme, ...(email ? { email } : {}) },
      replaceAccountId: flow.replaceAccountId,
      replaceGeneration: flow.replaceGeneration,
    };
  }

  private async beginDevice(common: FlowBase): Promise<BeginResult> {
    const device = common.provider.device;
    if (!device) throw new SignInError(`${common.provider.label} has no device sign-in`);
    const response = await this.deps.fetch(device.deviceCodeUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ client_id: this.clientId(common.provider), scope: device.scopes.join(" ") }),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !response.ok ||
      !body ||
      typeof body.device_code !== "string" ||
      typeof body.user_code !== "string" ||
      typeof body.verification_uri !== "string" ||
      !body.verification_uri.startsWith("https://")
    ) {
      throw new SignInError(`${common.provider.label} did not start the sign-in; try again`);
    }
    const intervalMs = Math.max(5, typeof body.interval === "number" ? body.interval : 5) * 1000;
    const expiresIn =
      typeof body.expires_in === "number" ? body.expires_in * 1000 : FLOW_LIFETIME_MS;
    const flow: DeviceFlow = {
      ...common,
      method: "device",
      expiresAtMs: this.now() + Math.min(expiresIn, FLOW_LIFETIME_MS * 3),
      deviceCode: body.device_code,
      intervalMs,
      nextPollAtMs: this.now() + intervalMs,
    };
    this.register(flow);
    return {
      flowId: flow.id,
      method: "device",
      expiresAt: new Date(flow.expiresAtMs).toISOString(),
      userCode: body.user_code,
      verifyUrl: body.verification_uri,
    };
  }

  private async pollDevice(flow: DeviceFlow): Promise<CompleteResult> {
    const device = flow.provider.device!;
    const waitMs = flow.nextPollAtMs - this.now();
    if (waitMs > 0) return { status: "pending", retryAfterSeconds: Math.ceil(waitMs / 1000) };
    flow.nextPollAtMs = this.now() + flow.intervalMs;
    const response = await this.deps.fetch(device.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_id: this.clientId(flow.provider),
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (body && typeof body.access_token === "string" && body.access_token) {
      return this.connectedFromTokenResponse(flow, "device", body, device.scopes);
    }
    const error = body && typeof body.error === "string" ? body.error : "unknown";
    if (error === "authorization_pending") {
      return { status: "pending", retryAfterSeconds: Math.ceil(flow.intervalMs / 1000) };
    }
    if (error === "slow_down") {
      flow.intervalMs += 5000;
      flow.nextPollAtMs = this.now() + flow.intervalMs;
      return { status: "pending", retryAfterSeconds: Math.ceil(flow.intervalMs / 1000) };
    }
    if (error === "access_denied")
      throw new SignInError("Sign-in was declined on the provider's page");
    if (error === "expired_token") throw new SignInError("The code expired; start again");
    throw new SignInError(`${flow.provider.label} sign-in failed; start again`);
  }

  private async connectedFromTokenResponse(
    flow: Flow,
    method: "device" | "browser",
    body: Record<string, unknown>,
    requestedScopes: readonly string[],
  ): Promise<ConnectedResult> {
    const accessToken = String(body.access_token);
    const refreshToken =
      typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined;
    const displayName = await this.identify(
      flow.provider,
      flow.site,
      authorizationHeader("bearer", accessToken),
    );
    const granted =
      typeof body.scope === "string" && body.scope.trim()
        ? body.scope.split(/[\s,]+/).filter(Boolean)
        : [...requestedScopes];
    return {
      status: "connected",
      connector: flow.provider.id,
      site: flow.site,
      method,
      displayName,
      scopes: granted.slice(0, 12).map((scope) => scope.slice(0, 60)),
      expiresAt: isoOrNull(this.now(), body.expires_in),
      secret: { accessToken, scheme: "bearer", ...(refreshToken ? { refreshToken } : {}) },
      replaceAccountId: flow.replaceAccountId,
      replaceGeneration: flow.replaceGeneration,
    };
  }

  private async beginBrowser(common: FlowBase, redirect: RedirectTarget): Promise<BeginResult> {
    const browser = common.provider.browser;
    if (!browser?.publicClient)
      throw new SignInError(`${common.provider.label} browser sign-in needs a broker`);
    const clientId = this.clientId(common.provider);
    let loopback: LoopbackListener | null = null;
    let redirectUri = `fulcra://oauth/${common.id}`;
    if (redirect === "loopback") {
      if (!this.deps.openLoopback)
        throw new SignInError("Loopback sign-in is only available on desktop");
      loopback = await this.deps.openLoopback((url) => this.handleLoopback(common.id, url));
      redirectUri = `${loopback.origin}/oauth/${common.id}`;
    }
    const flow: BrowserFlow = {
      ...common,
      method: "browser",
      state: base64url(randomBytes(32)),
      codeVerifier: base64url(randomBytes(32)),
      redirectUri,
      loopback,
    };
    this.register(flow);
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: browser.scopes.join(" "),
      state: flow.state,
      code_challenge: pkceChallenge(flow.codeVerifier),
      code_challenge_method: "S256",
      ...browser.extraAuthorizeParams,
    });
    return {
      flowId: flow.id,
      method: "browser",
      expiresAt: new Date(flow.expiresAtMs).toISOString(),
      authUrl: `${browser.authorizeUrl}?${params.toString()}`,
    };
  }

  private handleLoopback(flowId: string, url: string): void {
    const result = this.complete(flowId, { kind: "callback", url });
    if (this.deps.onLoopbackCallback) this.deps.onLoopbackCallback(flowId, result);
    else result.catch(() => undefined);
  }

  private async completeBrowser(flow: BrowserFlow, url: string): Promise<ConnectedResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SignInError("Not a sign-in callback");
    }
    const expected = new URL(flow.redirectUri);
    if (
      parsed.protocol !== expected.protocol ||
      parsed.host !== expected.host ||
      parsed.pathname !== expected.pathname
    ) {
      throw new SignInError("This callback does not belong to this sign-in");
    }
    const state = parsed.searchParams.get("state") ?? "";
    if (!sameSecret(flow.state, state))
      throw new SignInError("This callback does not belong to this sign-in");
    const providerError = parsed.searchParams.get("error");
    if (providerError) throw new SignInError("Sign-in was declined on the provider's page");
    const code = parsed.searchParams.get("code");
    if (!code) throw new SignInError("The provider did not return a sign-in code");
    const browser = flow.provider.browser!;
    const response = await this.deps.fetch(browser.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "authorization_code",
        client_id: this.clientId(flow.provider),
        code,
        redirect_uri: flow.redirectUri,
        code_verifier: flow.codeVerifier,
      }),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !body || typeof body.access_token !== "string" || !body.access_token) {
      throw new SignInError(`${flow.provider.label} did not accept the sign-in; start again`);
    }
    return this.connectedFromTokenResponse(flow, "browser", body, browser.scopes);
  }
}

// Refreshes a device-flow token where the provider allows it without a client secret. Returns the new
// secret and expiry, or throws; the caller marks the account `needs-reconnect` on failure.
export async function refreshDeviceToken(input: {
  provider: ProviderDefinition;
  clientId: string | undefined;
  refreshToken: string;
  fetch: typeof fetch;
  nowMs: number;
}): Promise<{ secret: StoredSecret; expiresAt: string | null }> {
  const device = input.provider.device;
  if (!device?.refreshWithoutSecret || !input.clientId?.trim()) {
    throw new SignInError("This account cannot refresh itself");
  }
  const response = await input.fetch(device.tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: input.clientId.trim(),
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body || typeof body.access_token !== "string" || !body.access_token) {
    throw new SignInError("The sign-in could not be refreshed");
  }
  return {
    secret: {
      accessToken: body.access_token,
      scheme: "bearer",
      ...(typeof body.refresh_token === "string" && body.refresh_token
        ? { refreshToken: body.refresh_token }
        : { refreshToken: input.refreshToken }),
    },
    expiresAt: isoOrNull(input.nowMs, body.expires_in),
  };
}
