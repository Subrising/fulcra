// Sign-in provider table for the shared credential store (CONTRACTS §7.1/§7.2). One entry per
// connector. Findings behind `publicClient` and the sources are in docs/integrations-auth.md: only a
// provider that lets a desktop app finish sign-in without a client secret gets a working method.
// Everything else is marked `needs-broker` and is never offered.

export type SignInMethod = "browser" | "device" | "token" | "cli";

export type CredentialAuthScheme = "bearer" | "basic";

export interface IdentityRequest {
  url: string;
  headers: Record<string, string>;
}

export interface IdentityResult {
  // Shown in Settings › Integrations, e.g. "octocat (GitHub)". Never an email address.
  name: string;
}

export interface TokenMethodDefinition {
  // Jira Cloud and Bitbucket Cloud API tokens are sent with the account email (HTTP basic).
  requiresEmail: boolean;
  // Bitbucket Data Center documents personal HTTP access tokens with Basic auth and a username, and
  // project/repository tokens with Bearer. With a username the token is sent as Basic.
  acceptsUsername?: boolean;
  scheme: CredentialAuthScheme;
  help: { createUrl: string; scopes: readonly string[]; note: string };
}

export interface DeviceMethodDefinition {
  deviceCodeUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  // The provider refreshes device-flow tokens without a client secret.
  refreshWithoutSecret: boolean;
}

export interface BrowserMethodDefinition {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  extraAuthorizeParams?: Record<string, string>;
  // True only when the token endpoint accepts an authorization-code + PKCE exchange without a
  // client secret. False means a hosted token broker is required: the method is `needs-broker`.
  publicClient: boolean;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  // Self-hosted connectors need a site and sign in with a token only.
  selfHosted: boolean;
  // Jira Cloud needs the site (acme.atlassian.net) for token sign-in as well.
  requiresSite: boolean;
  // Preference order, as shown on the Connect sheet.
  methods: readonly SignInMethod[];
  token: TokenMethodDefinition;
  device?: DeviceMethodDefinition;
  browser?: BrowserMethodDefinition;
  // Where plugin requests may go (CONTRACTS §7.2 v1.7): the provider's API base for the account and
  // the path prefixes under it. The host never sends an account's credential anywhere else.
  // `readOnlyPathPrefixes` are reachable with GET only, whatever the plugin declares (CONTRACTS v1.10).
  api: {
    base(site: string | null): string;
    pathPrefixes: readonly string[];
    readOnlyPathPrefixes?: readonly string[];
  };
  identity(input: { site: string | null; authorization: string }): IdentityRequest;
  readIdentity(body: unknown, headers: Headers, site: string | null): IdentityResult;
}

function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function named(base: string | null, label: string, fallback: string): IdentityResult {
  const name = `${(base ?? fallback).slice(0, 60)} (${label})`;
  return { name: name.slice(0, 80) };
}

const JSON_ACCEPT = { Accept: "application/json" };

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "github",
    label: "GitHub",
    selfHosted: false,
    requiresSite: false,
    methods: ["device", "token", "cli"],
    token: {
      requiresEmail: false,
      scheme: "bearer",
      help: {
        createUrl: "https://github.com/settings/tokens",
        scopes: ["repo", "read:org"],
        note: "A fine-grained or classic personal access token with read access to your repositories.",
      },
    },
    device: {
      deviceCodeUrl: "https://github.com/login/device/code",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:org"],
      refreshWithoutSecret: true,
    },
    browser: {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:org"],
      publicClient: false,
    },
    api: {
      base: (site) => (site ? `https://${site}/api/v3` : "https://api.github.com"),
      pathPrefixes: ["/"],
    },
    identity: ({ authorization }) => ({
      url: "https://api.github.com/user",
      headers: { ...JSON_ACCEPT, Authorization: authorization, "User-Agent": "Fulcra" },
    }),
    readIdentity: (body) => named(readString(body, "login"), "GitHub", "account"),
  },
  {
    id: "jira",
    label: "Jira",
    selfHosted: false,
    requiresSite: true,
    methods: ["browser", "token"],
    token: {
      requiresEmail: true,
      scheme: "basic",
      help: {
        createUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
        scopes: ["read:jira-work", "read:jira-user"],
        note: "An Atlassian API token plus the email address of your Atlassian account.",
      },
    },
    browser: {
      authorizeUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      scopes: ["read:jira-work", "read:jira-user", "offline_access"],
      extraAuthorizeParams: { audience: "api.atlassian.com", prompt: "consent" },
      publicClient: false,
    },
    api: {
      base: (site) => `https://${site}`,
      pathPrefixes: ["/rest/api/"],
      readOnlyPathPrefixes: ["/rest/dev-status/", "/rest/agile/1.0/"],
    },
    identity: ({ site, authorization }) => ({
      url: `https://${site}/rest/api/3/myself`,
      headers: { ...JSON_ACCEPT, Authorization: authorization },
    }),
    readIdentity: (body, _headers, site) =>
      named(readString(body, "displayName"), "Jira", site ?? "Jira"),
  },
  {
    id: "jira-dc",
    label: "Jira Data Center",
    selfHosted: true,
    requiresSite: true,
    methods: ["token"],
    token: {
      requiresEmail: false,
      scheme: "bearer",
      help: {
        createUrl:
          "https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html",
        scopes: [],
        note: "A personal access token from your Jira profile (Profile › Personal Access Tokens).",
      },
    },
    api: {
      base: (site) => `https://${site}`,
      pathPrefixes: ["/rest/api/"],
      readOnlyPathPrefixes: ["/rest/dev-status/", "/rest/agile/1.0/"],
    },
    identity: ({ site, authorization }) => ({
      url: `https://${site}/rest/api/2/myself`,
      headers: { ...JSON_ACCEPT, Authorization: authorization },
    }),
    readIdentity: (body, _headers, site) =>
      named(readString(body, "displayName"), "Jira Data Center", site ?? "Jira"),
  },
  {
    id: "bitbucket",
    label: "Bitbucket",
    selfHosted: false,
    requiresSite: false,
    methods: ["browser", "token"],
    token: {
      requiresEmail: true,
      scheme: "basic",
      help: {
        createUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
        scopes: ["read:repository:bitbucket", "read:pullrequest:bitbucket", "read:user:bitbucket"],
        note: "A Bitbucket API token with read scopes, plus the email address of your Atlassian account.",
      },
    },
    browser: {
      authorizeUrl: "https://bitbucket.org/site/oauth2/authorize",
      tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
      scopes: ["repository", "pullrequest", "account"],
      publicClient: false,
    },
    api: { base: () => "https://api.bitbucket.org", pathPrefixes: ["/2.0/"] },
    identity: ({ authorization }) => ({
      url: "https://api.bitbucket.org/2.0/user",
      headers: { ...JSON_ACCEPT, Authorization: authorization },
    }),
    readIdentity: (body) => named(readString(body, "display_name"), "Bitbucket", "account"),
  },
  {
    id: "bitbucket-dc",
    label: "Bitbucket Data Center",
    selfHosted: true,
    requiresSite: true,
    methods: ["token"],
    token: {
      requiresEmail: false,
      acceptsUsername: true,
      scheme: "bearer",
      help: {
        createUrl:
          "https://confluence.atlassian.com/bitbucketserver/http-access-tokens-939515499.html",
        scopes: ["REPO_READ"],
        note: "An HTTP access token from Manage account › HTTP access tokens. Add your username for a personal token.",
      },
    },
    // Bitbucket Data Center has no "current user" resource; any authenticated read proves the
    // token, and the server names the user in the X-AUSERNAME response header.
    api: { base: (site) => `https://${site}`, pathPrefixes: ["/rest/"] },
    identity: ({ site, authorization }) => ({
      url: `https://${site}/rest/api/1.0/profile/recent/repos?limit=1`,
      headers: { ...JSON_ACCEPT, Authorization: authorization },
    }),
    readIdentity: (_body, headers, site) =>
      named(headers.get("x-ausername"), "Bitbucket Data Center", site ?? "Bitbucket"),
  },
];

export function findProvider(
  providers: readonly ProviderDefinition[],
  connector: string,
): ProviderDefinition | null {
  return providers.find((provider) => provider.id === connector) ?? null;
}

export type MethodAvailability =
  | { method: SignInMethod; status: "available" }
  | { method: SignInMethod; status: "unavailable"; reason: "no-client-id" | "host-only" }
  | { method: SignInMethod; status: "needs-broker" };

// `token` always works. `device`/`browser` need an OAuth client id from host config and a provider
// that accepts a public client. `cli` is the existing `gh` login, which the forge layer already uses
// directly; it is listed for completeness and never produces an account.
export function methodAvailability(
  provider: ProviderDefinition,
  clientIds: Readonly<Record<string, string | undefined>>,
): MethodAvailability[] {
  return provider.methods.map((method): MethodAvailability => {
    if (method === "token") return { method, status: "available" };
    if (method === "cli") return { method, status: "unavailable", reason: "host-only" };
    if (method === "browser" && provider.browser && !provider.browser.publicClient) {
      return { method, status: "needs-broker" };
    }
    if (!clientIds[provider.id]?.trim()) {
      return { method, status: "unavailable", reason: "no-client-id" };
    }
    return { method, status: "available" };
  });
}

export function authorizationHeader(
  scheme: CredentialAuthScheme,
  accessToken: string,
  email?: string | null,
): string {
  if (scheme === "basic") {
    return `Basic ${Buffer.from(`${email ?? ""}:${accessToken}`, "utf8").toString("base64")}`;
  }
  return `Bearer ${accessToken}`;
}

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}(?::\d{1,5})?$/;

// A site is a bare hostname (optionally with a port): no scheme, path, credentials or query. Tokens
// only ever travel to it over https.
export function normalizeSite(site: string | null | undefined): string | null {
  if (site === null || site === undefined) return null;
  const trimmed = site
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/+$/, "");
  if (!HOSTNAME.test(trimmed))
    throw new Error("Enter the site as a host name, like acme.atlassian.net");
  return trimmed;
}
